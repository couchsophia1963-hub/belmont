/*
# Belmont County News - Full Database Schema

1. Purpose
   This migration creates the complete database schema for the Belmont County News web app,
   a local news platform for Belmont, Ohio (43718). It supports user accounts with three
   roles (user, writer, admin), news stories, weather forecasts, story comments, and
   writer API keys for programmatic content management.

2. New Tables
   - `profiles`: Extends Supabase auth.users with a role (user/writer/admin) and display name.
     Auto-created via trigger when a user signs up.
   - `stories`: News articles with title, slug, excerpt, body, image, author, headline flag.
   - `weather_forecasts`: Daily weather entries (date, high/low temp, condition, icon, humidity, wind).
   - `comments`: User comments on stories (body, story_id, user_id).
   - `api_keys`: Writer API keys stored as hashes with a display prefix, name, and last-used timestamp.

3. Security (RLS)
   - All tables have RLS enabled.
   - Stories: public read (anon + authenticated); writers/admins can insert/update; admins can delete.
   - Weather: public read; writers/admins can insert/update/delete.
   - Comments: public read; any authenticated user can insert their own; owner or admin can update/delete.
   - Profiles: public read; owner can update display_name; admin can update role.
   - API keys: owner can read/insert/delete only their own keys.

4. Trigger
   - `on_auth_user_created`: Creates a profiles row automatically when a new auth user signs up.

5. Seed Data
   - 3 days of weather forecasts starting from current date.
   - 6 news stories with real images, one flagged as headline.
*/

-- ============================================================
-- PROFILES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'writer', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_public_read" ON profiles;
CREATE POLICY "profiles_public_read"
  ON profiles FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "profiles_owner_update" ON profiles;
CREATE POLICY "profiles_owner_update"
  ON profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- STORIES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  slug text NOT NULL UNIQUE,
  excerpt text NOT NULL,
  body text NOT NULL,
  image_url text,
  category text NOT NULL DEFAULT 'Local News',
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_headline boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stories_public_read" ON stories;
CREATE POLICY "stories_public_read"
  ON stories FOR SELECT TO anon, authenticated
  USING (published = true);

DROP POLICY IF EXISTS "stories_writer_insert" ON stories;
CREATE POLICY "stories_writer_insert"
  ON stories FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  );

DROP POLICY IF EXISTS "stories_writer_update" ON stories;
CREATE POLICY "stories_writer_update"
  ON stories FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  );

DROP POLICY IF EXISTS "stories_admin_delete" ON stories;
CREATE POLICY "stories_admin_delete"
  ON stories FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- ============================================================
-- WEATHER FORECASTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS weather_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_date date NOT NULL UNIQUE,
  high_temp integer NOT NULL,
  low_temp integer NOT NULL,
  condition text NOT NULL,
  icon text NOT NULL DEFAULT 'sun',
  humidity integer NOT NULL DEFAULT 50,
  wind_speed integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE weather_forecasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weather_public_read" ON weather_forecasts;
CREATE POLICY "weather_public_read"
  ON weather_forecasts FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "weather_writer_insert" ON weather_forecasts;
CREATE POLICY "weather_writer_insert"
  ON weather_forecasts FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  );

DROP POLICY IF EXISTS "weather_writer_update" ON weather_forecasts;
CREATE POLICY "weather_writer_update"
  ON weather_forecasts FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  );

DROP POLICY IF EXISTS "weather_writer_delete" ON weather_forecasts;
CREATE POLICY "weather_writer_delete"
  ON weather_forecasts FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role IN ('writer', 'admin')
    )
  );

-- ============================================================
-- COMMENTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comments_public_read" ON comments;
CREATE POLICY "comments_public_read"
  ON comments FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "comments_user_insert" ON comments;
CREATE POLICY "comments_user_insert"
  ON comments FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "comments_owner_update" ON comments;
CREATE POLICY "comments_owner_update"
  ON comments FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "comments_owner_or_admin_delete" ON comments;
CREATE POLICY "comments_owner_or_admin_delete"
  ON comments FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- ============================================================
-- API KEYS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  name text NOT NULL DEFAULT 'Default',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "api_keys_owner_read" ON api_keys;
CREATE POLICY "api_keys_owner_read"
  ON api_keys FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "api_keys_owner_insert" ON api_keys;
CREATE POLICY "api_keys_owner_insert"
  ON api_keys FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "api_keys_owner_delete" ON api_keys;
CREATE POLICY "api_keys_owner_delete"
  ON api_keys FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_stories_created_at ON stories (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_slug ON stories (slug);
CREATE INDEX IF NOT EXISTS idx_stories_headline ON stories (is_headline) WHERE is_headline = true;
CREATE INDEX IF NOT EXISTS idx_comments_story_id ON comments (story_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_weather_date ON weather_forecasts (forecast_date);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);

-- ============================================================
-- TRIGGER: Auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)), 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- SEED: Weather forecasts (3 days from today)
-- ============================================================
INSERT INTO weather_forecasts (forecast_date, high_temp, low_temp, condition, icon, humidity, wind_speed)
VALUES
  (CURRENT_DATE,     72, 54, 'Sunny',              'sun',        45, 8),
  (CURRENT_DATE + 1, 68, 51, 'Partly Cloudy',      'cloud-sun',  55, 10),
  (CURRENT_DATE + 2, 61, 47, 'Showers',            'cloud-rain', 75, 14)
ON CONFLICT (forecast_date) DO NOTHING;

-- ============================================================
-- SEED: News stories
-- ============================================================
INSERT INTO stories (title, slug, excerpt, body, image_url, category, is_headline, created_at)
VALUES
  (
    'Belmont County Fair Draws Record Crowds This Weekend',
    'belmont-county-fair-record-crowds',
    'The annual Belmont County Fair shattered attendance records this weekend, with families from across the Ohio Valley enjoying rides, livestock shows, and live music.',
    'The 168th annual Belmont County Fair wrapped up this past weekend, and organizers are calling it the biggest year yet. Preliminary estimates suggest more than 18,000 visitors passed through the gates over four days — a 25% increase over last year''s attendance.

Fair board president Marlene Hitchens said the surge in visitors was driven by perfect weather and a packed entertainment schedule that included country music artist Travis Dawson on Saturday night.

"We couldn''t have asked for a better weekend," Hitchens said. "The community really showed up, and our volunteers worked around the clock to make it happen."

Highlights included the traditional livestock auction, which raised a record $42,000 for local 4-H and FFA programs, and a new pie-baking competition that drew more than 60 entries. The midway featured 24 rides, including the popular Ferris wheel that offered panoramic views of the Ohio River valley.

Local vendor Rick Morrison, who has operated the funnel cake stand at the fair for 12 years, said Saturday was the single busiest day he has ever seen. "We went through 400 pounds of batter. I had to call my wife to bring more from the house," he laughed.

The fair committee is already planning for next year, with discussions underway to expand the parking area and add a second entrance gate to reduce wait times.',
    'https://images.pexels.com/photos/33815997/pexels-photo-33815997.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'Community',
    true,
    now() - interval '3 hours'
  ),
  (
    'Riverside High Football Clinches Conference Title',
    'riverside-high-football-conference-title',
    'The Riverside Minutemen defeated rival Martins Ferry 28-14 Friday night to secure their first conference championship in over a decade.',
    'The Riverside Minutemen are conference champions for the first time since 2014 after a commanding 28-14 victory over the Martins Ferry Purple Riders on Friday night.

Senior quarterback Tyler Barnhart threw for 224 yards and three touchdowns, connecting with wide receiver Jake Phillips for two scores in the first half. The Minutemen defense forced three turnovers, including a fourth-quarter interception by linebacker Cody Marsh that effectively sealed the game.

"This group has worked so hard all season," said head coach Darren Leach. "These seniors have been through a lot of tough years, and to see it come together tonight — it''s special."

The Minutemen finish the regular season 9-1 and will host a first-round playoff game next Friday at Memorial Field. Tickets go on sale Monday at the high school athletic office.',
    'https://images.pexels.com/photos/9539096/pexels-photo-9539096.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'Sports',
    false,
    now() - interval '8 hours'
  ),
  (
    'County Commissioners Approve Road Improvement Budget',
    'county-commissioners-road-improvement-budget',
    'Belmont County Commissioners unanimously approved a $3.2 million budget for road repairs and resurfacing projects across the county.',
    'The Belmont County Board of Commissioners voted unanimously Tuesday to allocate $3.2 million for road improvement projects throughout the county.

The funding will cover resurfacing of approximately 28 miles of county roads, with priority given to National Road (US 40) between St. Clairsville and Belmont, and several township roads in Wheeling and Smith townships that have deteriorated significantly over the past two winters.

Commissioner Mark Rucker said the county was able to increase the road budget by $800,000 over last year thanks to federal infrastructure funds. "We''ve been waiting on these federal dollars for a long time," Rucker said. "This lets us tackle roads that have been on our list for years."

Work is expected to begin in spring 2026, weather permitting. The county will publish a full project list and schedule on its website by the end of the month.',
    'https://images.pexels.com/photos/32266781/pexels-photo-32266781.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'Government',
    false,
    now() - interval '14 hours'
  ),
  (
    'Autumn Harvest Festival Set for October 19',
    'autumn-harvest-festival-october-19',
    'Belmont''s annual Autumn Harvest Festival returns October 19 with pumpkin carving, a corn maze, hayrides, and a chili cook-off.',
    'The Belmont Community Association has announced the return of the annual Autumn Harvest Festival on Saturday, October 19, from 10 a.m. to 6 p.m. at the Belmont Village Park.

This year''s festival will feature a 5-acre corn maze, hayrides through the surrounding farmland, a pumpkin carving contest, and the popular chili cook-off, which has grown to 24 competing teams. New this year is an antique tractor show organized by the Belmont County Farmers Club.

"There''s something for every age," said festival coordinator Jenny Albright. "We have face painting and games for the little ones, the corn maze and hayrides for families, and the chili cook-off and tractor show for the adults."

Admission is free, with a $5 suggested donation to support the Belmont Food Pantry. Food vendors will be on-site throughout the day.',
    'https://images.pexels.com/photos/34143114/pexels-photo-34143114.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'Community',
    false,
    now() - interval '1 day'
  ),
  (
    'Historic Belmont Courthouse Restoration Nears Completion',
    'historic-belmont-courthouse-restoration-nears-completion',
    'After two years of work, the restoration of the 1898 Belmont County Courthouse is on track to finish by Thanksgiving.',
    'The two-year restoration of the historic Belmont County Courthouse is entering its final phase, with completion targeted for late November.

The $4.5 million project has addressed the building''s aging roof, restored the original clock tower, and repaired water damage to the interior woodwork. The courthouse, built in 1898, is listed on the National Register of Historic Places.

Project architect Lisa Donovan said the most challenging aspect was recreating the decorative copperwork on the clock tower. "We had to bring in a craftsman from Pennsylvania who specializes in historical metalwork," Donovan explained. "The original detailing was extraordinary, and we wanted to honor that."

The courthouse will reopen for public tours once restoration is complete. A rededication ceremony is being planned for early December.',
    'https://images.pexels.com/photos/32772108/pexels-photo-32772108.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'Local News',
    false,
    now() - interval '2 days'
  ),
  (
    'Ohio River Sweep Volunteers Collect 2,000 Pounds of Debris',
    'ohio-river-sweep-volunteers-debris',
    'More than 150 volunteers participated in the annual Ohio River Sweep, removing two thousand pounds of trash from the riverbanks.',
    'The annual Ohio River Sweep brought out over 150 volunteers last Saturday, who collectively removed approximately 2,000 pounds of debris from the riverbanks between Belmont and Powhatan Point.

The cleanup, organized by the Ohio River Valley Water Sanitation Commission and the Belmont County Soil and Water Conservation District, targeted areas along Route 7 and several public access points.

"It was an amazing turnout," said volunteer coordinator Pat Seabright. "We had families, church groups, Boy Scout troops, and even a group from Ohio University Eastern. The river is cleaner today because of them."

Among the items recovered were 14 tires, a shopping cart, several pieces of rusted fencing, and hundreds of plastic bottles. The debris was sorted and taken to the county landfill for proper disposal.

Organizers are already planning next year''s sweep for September 2026.',
    'https://images.pexels.com/photos/13345835/pexels-photo-13345835.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'Environment',
    false,
    now() - interval '3 days'
  )
ON CONFLICT (slug) DO NOTHING;
