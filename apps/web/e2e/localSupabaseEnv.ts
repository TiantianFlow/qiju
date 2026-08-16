import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE-58 — resolve the LOCAL Supabase stack's connection env for e2e.
 *
 * Why this exists: the accounts-on spec needs the same Supabase env the
 * flag-on server runs with (to mint fixture accounts and to sign the
 * lv_session cookie the way the server does). Previously that env had to be
 * passed in by hand via *_E2E variables, which is exactly the "opt-in flag
 * someone has to remember" failure mode that let the geometry assertions sit
 * dormant. The local stack already knows its own keys; `supabase status
 * -o env` prints them without any secret ever being committed.
 *
 * Secrets discipline: values are read into memory from the CLI's stdout and
 * never written to disk or logged. This module runs only inside Playwright's
 * Node process (config + specs), never in the browser bundle.
 */

export interface LocalSupabaseEnv {
  /** PostgREST/Auth base, e.g. http://127.0.0.1:54421 */
  apiUrl: string;
  /** Publishable (anon) key. */
  publishableKey: string;
  /** Secret (service-role) key — server-side fixture setup only. */
  secretKey: string;
  /** Direct Postgres connection string (auth.users flips PostgREST can't do). */
  dbUrl: string;
}

let cached: LocalSupabaseEnv | null | undefined;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/web/e2e -> apps/web -> apps -> repo root (supabase/config.toml lives there).
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/**
 * Return the local stack's env, or null when no local Supabase is running.
 * Result is memoized per process (Playwright config + each worker) so we pay
 * the CLI call at most once. Throws on a malformed/missing field — a running
 * stack whose status output we can't parse is a real problem, not a "skip".
 */
export function localSupabaseEnv(): LocalSupabaseEnv | null {
  if (cached !== undefined) return cached;
  let out: string;
  try {
    out = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
  } catch {
    cached = null; // no local stack (or CLI absent) — caller degrades, never errors
    return cached;
  }
  const get = (k: string): string => {
    const m = out.match(new RegExp(`^${k}=(.*)$`, "m"));
    if (!m || !m[1]) throw new Error(`supabase status -o env did not report ${k}`);
    // `-o env` shell-quotes every value ("..." with inner \" escapes); unwrap.
    let v = m[1].trim();
    const q = v.match(/^"(.*)"$/s);
    if (q) v = q[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return v;
  };
  cached = {
    apiUrl: get("API_URL"),
    publishableKey: get("PUBLISHABLE_KEY"),
    secretKey: get("SECRET_KEY"),
    dbUrl: get("DB_URL"),
  };
  return cached;
}
