import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { computeVersionString } from "./src/version";

// THE-29: derive the displayed version from git at config/build time so it
// auto-increments per same-day commit with no manual counter to bump.
function appVersion(): string {
  try {
    const out = execSync("git log --format=%ct", { encoding: "utf8" }).trim();
    const timestamps = out ? out.split("\n").map((s) => Number.parseInt(s, 10)) : [];
    return computeVersionString(timestamps);
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
  },
});
