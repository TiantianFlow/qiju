import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  // CI runners are shared and much slower than a dev machine; a single retry
  // absorbs environment timing stalls (observed: a round-advance poll
  // exceeding its 45s budget once on a fresh runner) without weakening any
  // assertion — a genuinely broken expectation fails every attempt.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    // Keep a trace for failed tests so CI failures are debuggable from the
    // uploaded artifacts without local reproduction.
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "node ../server/dist/main.js",
        url: "http://localhost:3000/health/live",
        reuseExistingServer: false,
        timeout: 30_000,
        env: { PORT: "3000", LOG_LEVEL: "warn" },
      },
});
