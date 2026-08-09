import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests (*.integration.test.ts) run under vitest.integration.config.ts
    // and require a live local Supabase — they must never leak into the unit gate,
    // which is exactly what CI runs (`pnpm test`).
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    testTimeout: 20000,
  },
});
