import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
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
