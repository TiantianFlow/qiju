import { defineConfig } from "@playwright/test";
import { localSupabaseEnv } from "./e2e/localSupabaseEnv";

/**
 * THE-58 — two projects so a plain `pnpm test:e2e` exercises BOTH the dark
 * and the flag-on accounts surfaces, with no opt-in env var to remember.
 *
 *   default     — every spec EXCEPT accounts-on, against a flag-OFF server
 *                 (3000 when Playwright spawns it; E2E_NO_SERVER/E2E_BASE_URL
 *                 still override for a manually-run server, e.g. port 3001).
 *   accounts-on — ONLY e2e/accounts-on.spec.ts, against a Playwright-managed
 *                 server started with FEATURE_ACCOUNTS=true on port 3002,
 *                 fed the LOCAL Supabase stack's env. That project is what
 *                 makes the width × locale geometry assertions actually RUN
 *                 rather than skip — the THE-9 regression gate.
 *
 * The accounts-on project is only wired when a local Supabase stack is
 * reachable (its spec skips without one regardless — there is no Auth to
 * mint fixture accounts against). FEATURE_ACCOUNTS=true is set ONLY on the
 * throwaway server process Playwright spawns here; never on any shared or
 * hosted target.
 *
 * Reach, stated precisely: `pnpm test:e2e` is NOT in CI yet (CI runs lint,
 * build, typecheck and `pnpm test` only). This makes the geometry gate a
 * LOCAL gate now; it becomes a CI gate when THE-21 lands.
 */

const supabase = localSupabaseEnv();

// Port 3000 belongs to the primary checkout's own dev/e2e flow; 3001 is the
// documented manual flag-off port. The flag-on project uses 3002, clear of both.
const ACCOUNTS_ON_PORT = 3002;
const ACCOUNTS_ON_BASE = `http://localhost:${ACCOUNTS_ON_PORT}`;

const projects: NonNullable<Parameters<typeof defineConfig>[0]["projects"]> = [
  {
    name: "default",
    testIgnore: /accounts-on\.spec\.ts/,
  },
];

const webServer: NonNullable<Parameters<typeof defineConfig>[0]["webServer"]> = [];

if (process.env.E2E_NO_SERVER) {
  // Manual flag-off server (E2E_BASE_URL, e.g. port 3001) for the default project.
} else {
  webServer.push({
    command: "node ../server/dist/main.js",
    url: "http://localhost:3000/health/live",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: "3000",
      LOG_LEVEL: "warn",
      // The server schema requires Supabase env even flag-off (identity is
      // THE-37a, not gated). Prefer the running local stack; fall back to
      // inert placeholders when none is up so the dark-surface tests (which
      // never complete a real identity call) still boot the server.
      SUPABASE_URL: supabase?.apiUrl ?? "http://127.0.0.1:54421",
      SUPABASE_PUBLISHABLE_KEY: supabase?.publishableKey ?? "e2e-off-no-stack",
      SUPABASE_SECRET_KEY: supabase?.secretKey ?? "e2e-off-no-stack",
    },
  });
}

if (supabase) {
  projects.push({
    name: "accounts-on",
    testMatch: /accounts-on\.spec\.ts/,
    use: { baseURL: ACCOUNTS_ON_BASE },
  });
  webServer.push({
    command: "node ../server/dist/main.js",
    url: `${ACCOUNTS_ON_BASE}/health/live`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(ACCOUNTS_ON_PORT),
      LOG_LEVEL: "warn",
      FEATURE_ACCOUNTS: "true",
      SUPABASE_URL: supabase.apiUrl,
      SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
      SUPABASE_SECRET_KEY: supabase.secretKey,
      PUBLIC_API_ORIGIN: ACCOUNTS_ON_BASE,
      WEB_ORIGIN: ACCOUNTS_ON_BASE,
      // The spec signs lv_session with this same dev secret (adoptSession).
      COOKIE_SECRET: "dev-only-insecure-secret-change-me",
    },
  });
}

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
  },
  projects,
  webServer,
});
