import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { sessionDeps } from "./session.js";
import type { FastifyInstance } from "fastify";

/**
 * Unit gate — the suite CI runs. Must be fully self-contained: no Supabase
 * env, no network. The identity layer is stubbed through the sessionDeps
 * seam; the REAL lifecycle (mint, verify, refresh against auth.users) is
 * covered by identity.integration.test.ts under test:integration.
 */

let app: FastifyInstance;

const realMint = sessionDeps.mint;
const realVerifyFactory = sessionDeps.verifyClientFactory;

beforeAll(async () => {
  // Deterministic fake: mint returns fixed tokens; getClaims resolves them
  // to a fixed principal. No Supabase involved.
  sessionDeps.mint = async () => ({
    kind: "ok",
    tokens: { accessToken: "unit-at", refreshToken: "unit-rt" },
  });
  sessionDeps.verifyClientFactory = () =>
    ({
      auth: {
        getClaims: async (token: string) =>
          token === "unit-at"
            ? { data: { claims: { sub: "unit-user-uuid" } }, error: null }
            : { data: null, error: { status: 401, message: "bad token" } },
        refreshSession: async () => ({ data: { session: null }, error: { status: 400 } }),
      },
    }) as never;
  app = await buildApp({
    LOG_LEVEL: "silent",
    ALLOW_FIXED_SEED: "true",
    COOKIE_SECRET: "unit-test-secret-key",
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
    SUPABASE_SECRET_KEY: "unit-secret",
  });
  await app.ready();
});

afterAll(async () => {
  sessionDeps.mint = realMint;
  sessionDeps.verifyClientFactory = realVerifyFactory;
  await app.close();
});

function cookiePair(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    const first = header.split(";")[0]!;
    const eq = first.indexOf("=");
    if (first.slice(0, eq) === name) return first;
  }
  return null;
}

describe("server unit", () => {
  it("health and capabilities are available", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    const cap = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(cap.statusCode).toBe(200);
    const body = cap.json() as { locales: string[]; defaultLocale: string; persistence: string };
    expect(body.locales).toEqual(["zh-CN", "en"]);
    expect(body.defaultLocale).toBe("zh-CN");
    // 37a changes identity only; match data stays in memory until 37b.
    expect(body.persistence).toBe("in-memory");
  });

  it("creates a human-vs-ai match and issues a session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai", seed: "itest" },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiePair(res.headers["set-cookie"], "lv_session")).toBeTruthy();
    const body = res.json() as { matchId: string };
    expect(body.matchId).toBeTruthy();
  });

  it("rejects schema-invalid create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown match view is 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/matches/nope/view" });
    expect(res.statusCode).toBe(404);
  });

  it("content endpoint serves both locales with identical key sets", async () => {
    const zh = await app.inject({ method: "GET", url: "/api/v1/content/content.synthetic.v2/zh-CN" });
    const en = await app.inject({ method: "GET", url: "/api/v1/content/content.synthetic.v2/en" });
    expect(zh.statusCode).toBe(200);
    expect(en.statusCode).toBe(200);
    const zhBody = zh.json() as { strings: Record<string, string>; catalog: Array<{ id: string }> };
    const enBody = en.json() as { strings: Record<string, string>; catalog: Array<{ id: string }> };
    const zhKeys = Object.keys(zhBody.strings).sort();
    const enKeys = Object.keys(enBody.strings).sort();
    expect(zhKeys).toEqual(enKeys);
    // v2's Round-5 high-variance catalog: 30 procedural color variants + 11 named collectibles.
    expect(zhBody.catalog.length).toBe(41);
    expect(enBody.catalog.length).toBe(41);
  });
});
