-- ============================================================
--  JUST BETWEEN US — Supabase Schema
--  Paste this entire file into Supabase → SQL Editor → Run
-- ============================================================

-- ── 1. USERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'User',
  avatar_b64   TEXT,                        -- base64 profile photo (resized to 200x200)
  city         TEXT DEFAULT '',             -- e.g. "Chennai"
  couple_id    UUID,                        -- FK set after couple created/joined
  role         TEXT CHECK (role IN ('person1','person2')),
  invite_code  TEXT UNIQUE,                 -- 6-char code, only on person1
  invite_used  BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ── 2. COUPLES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.couples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person1_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  person2_id    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Add FK from users → couples (after both tables exist)
ALTER TABLE public.users
  ADD CONSTRAINT fk_users_couple
  FOREIGN KEY (couple_id) REFERENCES public.couples(id) ON DELETE SET NULL;

-- ── 3. SESSIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 4. KV STORE (couple-scoped) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.kv_store (
  couple_id  UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (couple_id, key)
);

-- ── 5. INDEXES ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sessions_token    ON public.sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user     ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_kv_couple         ON public.kv_store(couple_id);
CREATE INDEX IF NOT EXISTS idx_users_invite_code ON public.users(invite_code);
CREATE INDEX IF NOT EXISTS idx_users_email       ON public.users(email);

-- ── 6. ROW LEVEL SECURITY ───────────────────────────────────
-- Disable RLS for now (service role used from Edge Functions).
-- Re-enable with proper JWT auth if you move to Supabase Auth later.
ALTER TABLE public.users    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.couples  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.kv_store DISABLE ROW LEVEL SECURITY;

-- ── 7. HELPER FUNCTION: generate_invite_code ────────────────
CREATE OR REPLACE FUNCTION public.generate_invite_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code  TEXT := '';
  i     INT;
  attempts INT := 0;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..6 LOOP
      code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    END LOOP;
    -- Ensure uniqueness
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE invite_code = code) THEN
      RETURN code;
    END IF;
    attempts := attempts + 1;
    IF attempts > 100 THEN
      RAISE EXCEPTION 'Could not generate unique invite code';
    END IF;
  END LOOP;
END;
$$;

-- ── 8. CLEANUP: auto-expire old sessions ────────────────────
-- Optional: run this as a cron job in Supabase → Database → Extensions → pg_cron
-- SELECT cron.schedule('expire-sessions', '0 * * * *',
--   $$DELETE FROM public.sessions WHERE expires_at < now()$$);

-- ── DONE ────────────────────────────────────────────────────
-- After running this, go to:
--   Supabase → Settings → API
--   Copy "Project URL" and "anon public" key
--   Paste them into api/auth.js  (SUPA_URL and SUPA_ANON_KEY)
--   Also copy the "service_role" key for server-side calls
