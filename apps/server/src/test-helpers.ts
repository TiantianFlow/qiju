import { createClient } from "@supabase/supabase-js";

/**
 * THE-37a integration tests run against local Supabase (project "qiju").
 * The stack must be up: `supabase start`. Keys are read from the shell
 * environment only — never hard-code or commit them.
 */
export function requireSupabaseEnv(): {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
} {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
    throw new Error(
      "integration tests require SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY " +
        "in the shell environment (run `supabase start`, then export from `supabase status -o env`)",
    );
  }
  return { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY };
}

export function appEnv(): Record<string, string> {
  return {
    ...requireSupabaseEnv(),
    LOG_LEVEL: "silent",
    ALLOW_FIXED_SEED: "true",
    COOKIE_SECRET: "integration-test-secret-key",
  };
}

/** Server-side assertion helper: the admin API proves a durable auth.users row. */
export async function getAuthUser(
  env: { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string },
  userId: string,
): Promise<{ id: string; is_anonymous: boolean } | null> {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return { id: data.user.id, is_anonymous: data.user.is_anonymous ?? false };
}

/** Pull a named cookie pair (`name=value`) out of a Set-Cookie header array. */
export function cookiePair(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    const first = header.split(";")[0]!;
    const eq = first.indexOf("=");
    if (first.slice(0, eq) === name) return first;
  }
  return null;
}

/**
 * Extract the DECODED cookie value from a Set-Cookie header. The wire form of
 * lv_session is URI-encoded by the cookie serializer; tests must decode it
 * before unsignCookie / decodeSessionCookie, which expect the plain value.
 */
export function cookieValueDecoded(setCookie: string | string[] | undefined, name: string): string | null {
  const pair = cookiePair(setCookie, name);
  if (!pair) return null;
  return decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
}
