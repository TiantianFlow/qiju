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

// THE-37b unit-level store fake: records writes, serves zeroed aggregates.
// The SQL-backed store is covered by persistence.integration.test.ts.
const unitWrites: unknown[] = [];
const unitStore = {
  insertMatch: async (input: unknown) => {
    unitWrites.push(input);
  },
  careerForUser: async () => ({
    matchesPlayed: 0,
    totalFinalWealth: 0,
    totalRealizedProfit: 0,
    totalBonusReward: 0,
    bestDenseEconomicRank: null,
    averageFinalWealth: 0,
  }),
};
let realStoreFactory: unknown;

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
  // THE-37b: the unit app must never touch a database. The store seam is
  // replaced with an in-memory fake so the career endpoint and the
  // completion-boundary write are exercised without Supabase.
  const { persistenceDeps } = await import("./persistence.js");
  realStoreFactory = persistenceDeps.storeFactory;
  persistenceDeps.storeFactory = () => unitStore;
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
  const { persistenceDeps } = await import("./persistence.js");
  persistenceDeps.storeFactory = realStoreFactory as typeof persistenceDeps.storeFactory;
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
    // 37b persists completed matches to Supabase; the field is durable.
    expect(body.persistence).toBe("durable");
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

  it("GET /api/v1/me/career without a session is 401 AUTH_REQUIRED and mints nothing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/me/career" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe("AUTH_REQUIRED");
    expect(res.headers["set-cookie"]).toBeUndefined(); // never mints
  });

  it("GET /api/v1/me/career with a session returns the caller's aggregates", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai", seed: "career-unit-1" },
    });
    expect(created.statusCode).toBe(200);
    const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/career",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("matchesPlayed");
    expect(body).toHaveProperty("totalFinalWealth");
    expect(body).toHaveProperty("bestDenseEconomicRank");
  });

  it("GET /api/v1/me/career returns 503 (not a crash) when the store fails", async () => {
    const { persistenceDeps } = await import("./persistence.js");
    const real = persistenceDeps.storeFactory;
    persistenceDeps.storeFactory = () => ({
      insertMatch: async () => {},
      careerForUser: async () => {
        throw new Error("simulated store failure");
      },
    });
    try {
      const failing = await buildApp({
        LOG_LEVEL: "silent",
        ALLOW_FIXED_SEED: "true",
        COOKIE_SECRET: "unit-test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
      });
      await failing.ready();
      const created = await failing.inject({
        method: "POST",
        url: "/api/v1/demo-matches",
        payload: { mode: "human-vs-ai" },
      });
      const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
      const res = await failing.inject({
        method: "GET",
        url: "/api/v1/me/career",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe("TEMPORARY_STORAGE_FAILURE");
      await failing.close();
    } finally {
      persistenceDeps.storeFactory = real;
    }
  });
});
