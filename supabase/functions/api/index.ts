import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { digestFromHeader, evaluateApiKeyAuth } from "./api-key-auth.ts";
import { evaluateTakeDown } from "./story-lock.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

interface ApiRequest {
  resource: "stories" | "weather";
  action: "create" | "update" | "delete" | "upsert" | "list" | "lock" | "unlock" | "unpublish" | "publish";
  data?: Record<string, unknown>;
  id?: string;
}

async function authenticate(authHeader: string | null) {
  // The key is looked up by its digest, never by itself. `key_hash` is named for
  // a hash and holds the raw credential — read it and you have every desk key in
  // full — so it is not a value this function may put in a query. The digest is
  // the same SHA-256 that `api_keys_fill_key_digest` writes into `key_digest`,
  // over the same bytes, so the credential never leaves this function: it is
  // hashed here and dropped.
  //
  // Requires 20261005290000 (PR #40). Deploying this before that migration is
  // applied refuses every key with no error in either column, because no
  // `key_digest` column exists to match.
  const digest = await digestFromHeader(authHeader);
  if (!digest) return null;

  // `.is("revoked_at", null)" is the revocation half, and it is load-bearing:
  // revoking a row does not delete it, so without this filter a revoked key keeps
  // working. `evaluateApiKeyAuth` checks `revoked_at` again, which is redundant
  // on purpose — if this filter is ever dropped the guard survives in code where a
  // test can reach it, instead of the refusal depending on one string here.
  //
  // `id` is selected for the `last_used_at` stamp below and nothing else.
  const { data: keyRow } = await supabase
    .from("api_keys")
    .select("id, user_id, revoked_at")
    .eq("key_digest", digest)
    .is("revoked_at", null)
    .maybeSingle();

  // A key whose owner is gone, or who may not write, is refused here rather than
  // after the stamp, so a refused key is not written to.
  const { data: profile } = keyRow
    ? await supabase
        .from("profiles")
        .select("id, role, display_name, email")
        .eq("id", keyRow.user_id)
        .maybeSingle()
    : { data: null };

  const decision = evaluateApiKeyAuth({
    header: authHeader,
    keyRow: keyRow ? { id: keyRow.id, user_id: keyRow.user_id, revoked_at: keyRow.revoked_at } : null,
    profile: profile
      ? {
          id: profile.id,
          role: profile.role,
          display_name: profile.display_name,
          email: profile.email,
        }
      : null,
  });

  if (!decision.allowed) return null;

  // Stamp `last_used_at` by row id, not by the secret. This used to be a second
  // query filtered on `key_hash = rawKey`, which put the credential in a second
  // query's filter and scanned the column again to find the row the lookup above
  // had already found. `key_digest` is indexed and unique (PR #40), so the lookup
  // is a single index probe either way.
  //
  // Runs as service_role, which bypasses RLS, so this is not the panel's write
  // path and is not affected by the owner UPDATE policy in 20261005300000. It
  // does fire `api_keys_revoked_at_is_monotonic` (20261005305000), which compares
  // OLD and NEW `revoked_at`, sees the column unchanged, and returns NEW.
  //
  // The result is read, which it was not before. This is a best-effort stamp: a
  // failure here must not refuse a request the caller is entitled to make, so it
  // does not change the return value. But discarding the error made this the last
  // write in this function with the shape this whole stack exists to remove --
  // reports success, changes nothing, logs nothing -- which is precisely how
  // `handleRerollKey` has been silently failing since the beginning. `last_used_at`
  // is the evidence PR #40 section 8's audit case depends on, so a stamp that
  // quietly stops happening has to be visible.
  const { error: stampError } = await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", decision.keyId);

  if (stampError) {
    console.error(
      `api_keys.last_used_at not stamped for key ${decision.keyId}: ${stampError.message}`,
    );
  }

  return profile;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .substring(0, 80);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const profile = await authenticate(req.headers.get("Authorization"));
    if (!profile) {
      return errorResponse("Invalid or missing API key", 401);
    }

    // GET request = list stories or weather
    if (req.method === "GET") {
      const url = new URL(req.url);
      const resource = url.pathname.replace("/functions/v1/api/", "").replace("/functions/v1/api", "");

      if (resource === "stories" || resource === "") {
        const { data, error } = await supabase
          .from("stories")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ stories: data });
      }

      if (resource === "weather") {
        const { data, error } = await supabase
          .from("weather_forecasts")
          .select("*")
          .order("forecast_date", { ascending: true })
          .limit(7);
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ weather: data });
      }

      return errorResponse("Unknown resource", 404);
    }

    const body = (await req.json()) as ApiRequest;
    const { resource, action, data, id } = body;

    if (!resource || !action) {
      return errorResponse("Missing 'resource' or 'action' field", 400);
    }

    // ===== STORIES =====
    if (resource === "stories") {
      if (action === "create") {
        if (!data?.title || !data?.body) {
          return errorResponse("Stories require 'title' and 'body'", 400);
        }
        const slug = (data.slug as string) || slugify(data.title as string);
        const insertData = {
          title: data.title,
          slug,
          excerpt: (data.excerpt as string) || (data.body as string).substring(0, 200) + "...",
          body: data.body,
          image_url: data.image_url || null,
          category: data.category || "Local News",
          author_id: profile.id,
          is_headline: data.is_headline || false,
          published: data.published !== undefined ? data.published : true,
        };
        const { data: story, error } = await supabase
          .from("stories")
          .insert(insertData)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story }, 201);
      }

      if (action === "update") {
        if (!id) return errorResponse("Update requires 'id'", 400);
        // No blanket lock check here on purpose. Lock is narrow: it prevents
        // deletion and taking a live story down, nothing more. A correction is
        // an update, so a locked story has to stay correctable -- a story
        // nobody can fix is a worse failure than one somebody can delete. See
        // BEL-83 item 2 and BEL-166.
        const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (data?.title) {
          updateData.title = data.title;
          if (!data.slug) updateData.slug = slugify(data.title as string);
        }
        if (data?.slug) updateData.slug = data.slug;
        if (data?.excerpt) updateData.excerpt = data.excerpt;
        if (data?.body) updateData.body = data.body;
        if (data?.image_url !== undefined) updateData.image_url = data.image_url;
        if (data?.category) updateData.category = data.category;
        if (data?.is_headline !== undefined) updateData.is_headline = data.is_headline;
        if (data?.published !== undefined) {
          // `update` writes `published` too, so without this the check in
          // `unpublish` was bypassable from one action earlier and the lock was
          // advisory rather than enforced. Guard only the take-down of a live
          // story: every other field above still writes to a locked story.
          const wantsUnpublish = !data.published;
          if (wantsUnpublish) {
            const { data: lockRow, error: lockCheckError } = await supabase
              .from("stories")
              .select("locked, published")
              .eq("id", id)
              .maybeSingle();
            if (lockCheckError) return errorResponse(lockCheckError.message, 500);
            if (!lockRow) return errorResponse("Story not found", 404);
            const decision = evaluateTakeDown({
              wantsUnpublish,
              locked: Boolean(lockRow.locked),
              published: Boolean(lockRow.published),
            });
            if (!decision.allowed) return errorResponse(decision.message, decision.status);
          }
          updateData.published = data.published;
        }

        const { data: story, error } = await supabase
          .from("stories")
          .update(updateData)
          .eq("id", id)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story });
      }

      if (action === "delete") {
        if (!id) return errorResponse("Delete requires 'id'", 400);
        if (profile.role !== "admin") {
          return errorResponse("Only admins can delete stories", 403);
        }
        // Check if story is locked before deleting
        const { data: storyRow, error: fetchError } = await supabase
          .from("stories")
          .select("locked")
          .eq("id", id)
          .maybeSingle();
        if (fetchError) return errorResponse(fetchError.message, 500);
        if (!storyRow) return errorResponse("Story not found", 404);
        if (storyRow.locked) {
          return errorResponse("Story is locked and cannot be deleted. Unlock it first.", 409);
        }
        const { error } = await supabase.from("stories").delete().eq("id", id);
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ success: true });
      }

      if (action === "unpublish") {
        if (!id) return errorResponse("Unpublish requires 'id'", 400);
        // Without this a writer key lifts a freeze with one call, which makes
        // lock advisory rather than enforced.
        const { data: lockRow, error: lockCheckError } = await supabase
          .from("stories")
          .select("locked")
          .eq("id", id)
          .maybeSingle();
        if (lockCheckError) return errorResponse(lockCheckError.message, 500);
        if (!lockRow) return errorResponse("Story not found", 404);
        if (lockRow.locked) {
          return errorResponse("Story is locked and cannot be unpublished. Unlock it first.", 409);
        }
        const { data: story, error } = await supabase
          .from("stories")
          .update({ published: false, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story });
      }

      if (action === "publish") {
        if (!id) return errorResponse("Publish requires 'id'", 400);
        const { data: story, error } = await supabase
          .from("stories")
          .update({ published: true, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story });
      }

      if (action === "lock") {
        if (!id) return errorResponse("Lock requires 'id'", 400);
        if (profile.role !== "admin") {
          return errorResponse("Only admins can lock stories", 403);
        }
        const updateData: Record<string, unknown> = { locked: true, updated_at: new Date().toISOString() };
        if (data?.locked_until) updateData.locked_until = data.locked_until;
        const { data: story, error } = await supabase
          .from("stories")
          .update(updateData)
          .eq("id", id)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story });
      }

      if (action === "unlock") {
        if (!id) return errorResponse("Unlock requires 'id'", 400);
        if (profile.role !== "admin") {
          return errorResponse("Only admins can unlock stories", 403);
        }
        const { data: story, error } = await supabase
          .from("stories")
          .update({ locked: false, locked_until: null, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story });
      }

      if (action === "list") {
        const { data: stories, error } = await supabase
          .from("stories")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ stories });
      }

      return errorResponse(`Unknown action '${action}' for stories`, 400);
    }

    // ===== WEATHER =====
    if (resource === "weather") {
      // Fields added by 20261005140000_weather_forecasts_deferred_fields.sql.
      const OPTIONAL_WEATHER_FIELDS = [
        "precipitation_chance",
        "sunrise",
        "sunset",
        "wind_direction",
        "wind_min",
        "wind_max",
      ] as const;

      if (action === "upsert" || action === "create") {
        if (!data?.forecast_date || data?.high_temp === undefined || data?.low_temp === undefined) {
          return errorResponse("Weather requires 'forecast_date', 'high_temp', 'low_temp'", 400);
        }
        const weatherData: Record<string, unknown> = {
          forecast_date: data.forecast_date,
          high_temp: data.high_temp,
          low_temp: data.low_temp,
          condition: data.condition || "Sunny",
          icon: data.icon || "sun",
          humidity: data.humidity ?? 50,
          wind_speed: data.wind_speed ?? 5,
        };
        for (const field of OPTIONAL_WEATHER_FIELDS) {
          if (data[field] !== undefined) weatherData[field] = data[field];
        }
        const { data: weather, error } = await supabase
          .from("weather_forecasts")
          .upsert(weatherData, { onConflict: "forecast_date" })
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ weather }, 201);
      }

      if (action === "update") {
        if (!id) return errorResponse("Update requires 'id'", 400);
        const updateData: Record<string, unknown> = {};
        if (data?.high_temp !== undefined) updateData.high_temp = data.high_temp;
        if (data?.low_temp !== undefined) updateData.low_temp = data.low_temp;
        if (data?.condition) updateData.condition = data.condition;
        if (data?.icon) updateData.icon = data.icon;
        if (data?.humidity !== undefined) updateData.humidity = data.humidity;
        if (data?.wind_speed !== undefined) updateData.wind_speed = data.wind_speed;
        for (const field of OPTIONAL_WEATHER_FIELDS) {
          if (data?.[field] !== undefined) updateData[field] = data[field];
        }
        const { data: weather, error } = await supabase
          .from("weather_forecasts")
          .update(updateData)
          .eq("id", id)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ weather });
      }

      if (action === "delete") {
        if (!id) return errorResponse("Delete requires 'id'", 400);
        if (profile.role !== "admin") {
          return errorResponse("Only admins can delete weather forecasts", 403);
        }
        const { error } = await supabase.from("weather_forecasts").delete().eq("id", id);
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ success: true });
      }

      if (action === "list") {
        const { data: weather, error } = await supabase
          .from("weather_forecasts")
          .select("*")
          .order("forecast_date", { ascending: true })
          .limit(7);
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ weather });
      }

      return errorResponse(`Unknown action '${action}' for weather`, 400);
    }

    return errorResponse(`Unknown resource '${resource}'`, 400);
  } catch (err) {
    return errorResponse(err.message || "Internal server error", 500);
  }
});
