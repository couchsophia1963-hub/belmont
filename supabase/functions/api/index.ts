import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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

interface RosterByline {
  byline: string;
  profile_id: string | null;
  kind: "reporter" | "desk";
}

async function authenticate(authHeader: string | null) {
  if (!authHeader || !authHeader.startsWith("Bearer bcn_")) {
    return null;
  }
  const rawKey = authHeader.replace("Bearer ", "").trim();

  const { data: keyRow } = await supabase
    .from("api_keys")
    .select("user_id")
    .eq("key_hash", rawKey)
    .maybeSingle();

  if (!keyRow) return null;

  // Update last_used_at
  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", rawKey);

  // Get profile to check role
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, display_name, email")
    .eq("id", keyRow.user_id)
    .maybeSingle();

  if (!profile || (profile.role !== "writer" && profile.role !== "admin")) return null;

  return profile;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .substring(0, 80);
}

// The byline comes from the draft, not from the key. The key owner is
// permission to write; it is not authorship. Reads byline_roster, which
// the BEL-188 migration seeds from the desk's ruling, and refuses
// anything that is not on it rather than writing a name nobody ruled on.
// Returns a Response on refusal so the caller can return it unchanged.
//
// The roster bounds which NAME may be written. It does not by itself
// guarantee the right name reaches the reader, because the string rendered
// on the story page is profiles.display_name, not byline_roster.byline -
// StoryDetailPage.tsx renders `story.author.display_name`. A display name
// can drift (profiles_owner_update is table-level, and DashboardPage
// writes display_name from a text box) and a drifted name renders with no
// error anywhere. So a match is not enough: the profile's own display_name
// has to still equal the roster entry. That check is the same one RLS
// applies to direct PostgREST writers, via is_permitted_byline().
//
// Deploy order, and all four steps are required:
//   1. 20261005172000_byline_roster.sql
//   2. 20261005173000_stories_byline_check.sql
//   3. Auth dashboard: create the auth users. profiles rows come from the
//      on_auth_user_created trigger, so this is NOT a SQL step.
//   4. SQL: set byline_roster.profile_id, and make profiles.display_name
//      equal byline_roster.byline.
// Until step 4 is done for the desk row, `stories create` refuses with
// 500 by design.
//
// `action` is read only by the blank-byline rule, which differs between
// create and update. It defaults to "create" so a caller that omits it
// cannot silently get create semantics on an update.
async function resolveByline(
  data: Record<string, unknown> | undefined,
  keyOwner: { id: string; display_name: string },
  action: "create" | "update" = "create",
): Promise<{ profileId: string; byline: string } | Response> {
  const { data: roster, error } = await supabase
    .from("byline_roster")
    .select("byline, profile_id, kind")
    .eq("active", true);

  if (error) {
    return errorResponse(
      `byline_roster is unreadable, so no story can be written with a correct byline. Apply 20261005172000_byline_roster.sql before this function. Supabase says: ${error.message}`,
      500,
    );
  }

  const permitted = (roster ?? []) as RosterByline[];
  const permittedList = permitted.map((r) => r.byline).sort().join(", ") || "(none seeded)";

  // Present-but-blank is different from absent, and only on update.
  // `{"byline": null}` and `{"byline": ""}` both reach here as a present
  // field with an empty string. On create that means "no byline named", and
  // the desk line below is the right answer. On update it is a correction in
  // flight that would quietly republish a reporter's story under the desk
  // line, returning 200 with nothing in a log. So it is refused on update
  // only, and omitting the field remains how you say "no change".
  const bylinePresent =
    data?.byline !== undefined || data?.author_name !== undefined || data?.author_id !== undefined;
  const requested =
    typeof data?.byline === "string" ? data.byline.trim()
    : typeof data?.author_name === "string" ? data.author_name.trim()
    : typeof data?.author_id === "string" ? data.author_id.trim()
    : "";

  if (bylinePresent && !requested && action === "update") {
    return errorResponse(
      "A byline was supplied but it is blank. Name the byline, or omit the field entirely to leave it unchanged.",
      422,
    );
  }

  let match: RosterByline | undefined;

  if (requested) {
    // Name match only. Accepting a bare profile uuid here would make the
    // permitted list read as though uuids were permitted names, and a
    // writer token must not be able to name an arbitrary profile id.
    match = permitted.find((r) => r.byline.toLowerCase() === requested.toLowerCase());
    if (!match) {
      // A bare uuid is not a byline name, so say so rather than quoting a
      // uuid back as though it were one. The author_id field name is an
      // easy thing to reach for by mistake, and the old message answered
      // that mistake in the shape of a byline complaint.
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested);
      return errorResponse(
        looksLikeUuid
          ? `A profile id was supplied where a byline name belongs. The byline is chosen by name from the roster - ` +
            `permitted: ${permittedList}. Send it in "byline", not "author_id".`
          : `Byline '${requested}' is not a permitted byline. Permitted: ${permittedList}. ` +
            `This API key belongs to ${keyOwner.display_name}; holding the key is permission to write, not authorship.`,
        422,
      );
    }
  } else {
    match = permitted.find((r) => r.kind === "desk");
    if (!match) {
      return errorResponse(
        "byline_roster has no active desk byline, and this request named none. " +
          "Pass data.byline, or activate the desk row the BEL-188 migration seeds.",
        500,
      );
    }
  }

  if (!match.profile_id) {
    // 500, not 422. Nothing is wrong with the request: an operator has to
    // create an auth user, which the publisher cannot do. 422 tells a client
    // to change its request, which sends whoever is reading the error to
    // the wrong place.
    return errorResponse(
      `Byline '${match.byline}' has no profiles row yet, so it cannot be written to stories.author_id. ` +
        "An operator must create the auth user for this byline (the on_auth_user_created trigger creates the profiles row), " +
        "set byline_roster.profile_id for it, and make profiles.display_name match byline_roster.byline. " +
        "Refusing rather than writing a null author_id, which is unattributed copy.",
      500,
    );
  }

  // The name is permitted; confirm the name that will actually render still
  // matches it. Without this, renaming a profile to a name the desk ruled
  // out of bylines publishes that name with a satisfied roster.
  const { data: profileRow, error: profileError } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", match.profile_id)
    .maybeSingle();

  if (profileError) {
    return errorResponse(
      `Could not read the profiles row for byline '${match.byline}': ${profileError.message}`,
      500,
    );
  }

  const displayName = (profileRow as { display_name: string } | null)?.display_name ?? "";
  if (displayName.trim().toLowerCase() !== match.byline.trim().toLowerCase()) {
    return errorResponse(
      `Byline '${match.byline}' does not match the profiles display_name '${displayName}', and the ` +
        "display name is what the story page renders. Align profiles.display_name with byline_roster.byline, " +
        "or change the roster entry. Refusing rather than publishing a byline nobody ruled on.",
      422,
    );
  }

  return { profileId: match.profile_id, byline: match.byline };
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
        const byline = await resolveByline(data, profile, "create");
        if (byline instanceof Response) return byline;
        const slug = (data.slug as string) || slugify(data.title as string);
        const insertData = {
          title: data.title,
          slug,
          excerpt: (data.excerpt as string) || (data.body as string).substring(0, 200) + "...",
          body: data.body,
          image_url: data.image_url || null,
          category: data.category || "Local News",
          author_id: byline.profileId,
          is_headline: data.is_headline || false,
          published: data.published !== undefined ? data.published : true,
        };
        const { data: story, error } = await supabase
          .from("stories")
          .insert(insertData)
          .select()
          .single();
        if (error) return errorResponse(error.message, 500);
        return jsonResponse({ story, byline: byline.byline }, 201);
      }

      if (action === "update") {
        if (!id) return errorResponse("Update requires 'id'", 400);
        // No lock check here on purpose. Lock is narrow: it prevents deletion,
        // nothing more. A correction is an update, so a locked story has to
        // stay correctable -- a story nobody can fix is a worse failure than
        // one somebody can delete. See BEL-83 item 2.
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
        if (data?.published !== undefined) updateData.published = data.published;
        // A correction that carries a blank or null byline is refused inside
        // resolveByline, not treated as "no change" and not silently
        // republishing the story under the desk line.
        if (data?.byline !== undefined || data?.author_name !== undefined || data?.author_id !== undefined) {
          const byline = await resolveByline(data, profile, "update");
          if (byline instanceof Response) return byline;
          updateData.author_id = byline.profileId;
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
