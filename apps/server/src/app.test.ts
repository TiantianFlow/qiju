import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { sessionDeps } from "./session.js";
import { ZERO_CAREER } from "./persistence.js";
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
  careerForUser: async () => ({ ...ZERO_CAREER }),
  leaderboardPage: async () => ({ rows: [], total: 0 }),
  snapshotExists: async () => false,
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
    expect(body).toEqual({
      matchesPlayed: 0,
      pocketBalance: ZERO_CAREER.pocketBalance,
      wins: 0,
      losses: 0,
      pushes: 0,
      bestDenseEconomicRank: null,
    });
    expect(body).not.toHaveProperty("totalFinalWealth");
    expect(body).not.toHaveProperty("appraiserRating");
    expect(body).not.toHaveProperty("tycoonTier");
  });

  it("GET /api/v1/me/career returns 503 (not a crash) when the store fails", async () => {
    const { persistenceDeps } = await import("./persistence.js");
    const real = persistenceDeps.storeFactory;
    persistenceDeps.storeFactory = () => ({
      insertMatch: async () => {},
      careerForUser: async () => {
        throw new Error("simulated store failure");
      },
      leaderboardPage: async () => ({ rows: [], total: 0 }),
      snapshotExists: async () => false,
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

  it("THE-44: production startup fails without an explicit CORS_ORIGIN", async () => {
    await expect(
      buildApp({
        NODE_ENV: "production",
        COOKIE_SECRET: "unit-test-secret-key-32chars!!",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
        // CORS_ORIGIN deliberately absent
      }),
    ).rejects.toThrow(/CORS_ORIGIN is required in production/);
  });

  it("THE-44: an unlisted Origin gets no credentialed CORS allowance on /api/v1/me/career", async () => {
    // Production-shaped CORS (explicit allowlist), dev NODE_ENV so the
    // startup guard doesn't fire — the assertion is about header behaviour.
    const listed = await buildApp({
      LOG_LEVEL: "silent",
      COOKIE_SECRET: "unit-test-secret-key",
      SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
      SUPABASE_SECRET_KEY: "unit-secret",
      CORS_ORIGIN: "https://app.example.com",
    });
    await listed.ready();
    try {
      const res = await listed.inject({
        method: "GET",
        url: "/api/v1/me/career",
        headers: { origin: "https://attacker.example" },
      });
      // An unlisted origin must not be reflected: without an
      // Access-Control-Allow-Origin match the browser blocks the response,
      // so the career payload is unreadable cross-origin with credentials.
      expect(res.headers["access-control-allow-origin"]).not.toBe("https://attacker.example");
      expect(res.headers["access-control-allow-origin"]).not.toBe("*");
      const preflight = await listed.inject({
        method: "OPTIONS",
        url: "/api/v1/me/career",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.headers["access-control-allow-origin"]).not.toBe("https://attacker.example");
      // The listed origin IS reflected (control: allowlist still works).
      const ok = await listed.inject({
        method: "GET",
        url: "/api/v1/me/career",
        headers: { origin: "https://app.example.com" },
      });
      expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    } finally {
      await listed.close();
    }
  });

  it("THE-39: with FEATURE_ACCOUNTS default-off, every accounts surface is absent (404), not merely disabled", async () => {
    // This app was built WITHOUT FEATURE_ACCOUNTS — the default-off flag.
    for (const [method, url] of [
      ["POST", "/api/v1/auth/oauth/start"],
      ["GET", "/api/v1/auth/oauth/callback"],
      ["GET", "/api/v1/me"],
      ["GET", "/api/v1/leaderboard"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url} should be 404 when the flag is off`).toBe(404);
    }
  });

  it("THE-39: FEATURE_ACCOUNTS requires PUBLIC_API_ORIGIN and WEB_ORIGIN at startup", async () => {
    await expect(
      buildApp({
        LOG_LEVEL: "silent",
        COOKIE_SECRET: "unit-test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
        FEATURE_ACCOUNTS: "true",
        // origins deliberately absent
      }),
    ).rejects.toThrow(/FEATURE_ACCOUNTS requires PUBLIC_API_ORIGIN and WEB_ORIGIN/);
  });

  it("THE-39 flag-on: start endpoint enforces header/body/returnTo; leaderboard paginates via the store", async () => {
    const { persistenceDeps } = await import("./persistence.js");
    const { oauthDeps } = await import("./oauth.js");
    const realStore = persistenceDeps.storeFactory;
    const realFlow = oauthDeps.flowClientFactory;
    persistenceDeps.storeFactory = () => ({
      insertMatch: async () => {},
      careerForUser: async () => ({ ...ZERO_CAREER }),
      leaderboardPage: async (offset: number, limit: number) => ({
        rows: [
          {
            userId: "aaaaaaaa-0000-0000-0000-000000000001",
            matchesPlayed: 2,
            wins: 1,
            losses: 0,
            pushes: 1,
            pocketBalance: 2_074_150,
            rank: offset + 1,
            total: 1,
          },
        ].slice(0, limit),
        total: 1,
      }),
      snapshotExists: async () => true,
    });
    oauthDeps.flowClientFactory = (_env, storage) =>
      ({
        auth: {
          setSession: async () => ({ error: null }),
          getSession: async () => ({ data: { session: null } }),
          signInWithOAuth: async () => {
            await storage.setItem("sb-x-auth-token-code-verifier", "v-123");
            return { data: { url: "https://provider.example/auth?flow_id=f1" }, error: null };
          },
          linkIdentity: async () => ({ data: null, error: { status: 400 } }),
          exchangeCodeForSession: async () => ({ data: null, error: { status: 400 } }),
        },
      }) as never;
    try {
      const flagged = await buildApp({
        LOG_LEVEL: "silent",
        COOKIE_SECRET: "unit-test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
        FEATURE_ACCOUNTS: "true",
        PUBLIC_API_ORIGIN: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com",
        PLAYER_LABEL_SECRET: "unit-label-secret-32chars!",
      });
      await flagged.ready();

      // start: missing custom header -> 400
      const noHeader = await flagged.inject({
        method: "POST",
        url: "/api/v1/auth/oauth/start",
        payload: { provider: "google" },
      });
      expect(noHeader.statusCode).toBe(400);

      // start: invalid provider -> 400
      const badProvider = await flagged.inject({
        method: "POST",
        url: "/api/v1/auth/oauth/start",
        headers: { "x-lotveil-request": "oauth" },
        payload: { provider: "github" },
      });
      expect(badProvider.statusCode).toBe(400);

      // start: returnTo outside the allowlist -> 400
      const badReturn = await flagged.inject({
        method: "POST",
        url: "/api/v1/auth/oauth/start",
        headers: { "x-lotveil-request": "oauth" },
        payload: { provider: "google", returnTo: "https://evil.example" },
      });
      expect(badReturn.statusCode).toBe(400);

      // start: happy path (no session -> login intent) -> 200 {redirectUrl}
      // plus the lv_oauth transaction cookie; lv_session untouched.
      const ok = await flagged.inject({
        method: "POST",
        url: "/api/v1/auth/oauth/start",
        headers: { "x-lotveil-request": "oauth" },
        payload: { provider: "google", returnTo: "/account" },
      });
      expect(ok.statusCode).toBe(200);
      const okBody = ok.json() as { redirectUrl: string };
      expect(okBody.redirectUrl).toContain("provider.example");
      expect(cookiePair(ok.headers["set-cookie"], "lv_oauth")).toBeTruthy();
      expect(cookiePair(ok.headers["set-cookie"], "lv_session")).toBeNull();

      // me: no session -> { principal: "none" } and NEVER mints.
      const me = await flagged.inject({ method: "GET", url: "/api/v1/me" });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { principal: string }).principal).toBe("none");
      expect(me.headers["set-cookie"]).toBeUndefined();

      // leaderboard: public, entries carry label + pocket and never a raw UUID.
      const board = await flagged.inject({ method: "GET", url: "/api/v1/leaderboard" });
      expect(board.statusCode).toBe(200);
      const boardBody = board.json() as {
        entries: Array<{
          playerLabel: string;
          rank: number;
          pocketBalance: number;
          wins: number;
          losses: number;
          pushes: number;
          matchesPlayed: number;
          isSelf: boolean;
        }>;
        total: number;
        nextOffset: number | null;
      };
      expect(boardBody.entries).toHaveLength(1);
      expect(boardBody.entries[0]!.playerLabel).toMatch(/^Player-[0-9A-F]{6}$/);
      expect(boardBody.entries[0]!.playerLabel).not.toContain("aaaaaaaa");
      expect(boardBody.entries[0]!.pocketBalance).toBe(2_074_150);
      expect(boardBody.entries[0]!.wins).toBe(1);
      expect(boardBody.entries[0]!.losses).toBe(0);
      expect(boardBody.entries[0]!.pushes).toBe(1);
      expect(boardBody.entries[0]!.matchesPlayed).toBe(2);
      expect(boardBody.entries[0]!.isSelf).toBe(false);
      expect(boardBody.entries[0]!).not.toHaveProperty("tycoonTier");
      expect(boardBody.entries[0]!).not.toHaveProperty("appraiserRating");
      expect(boardBody.entries[0]!).not.toHaveProperty("cumulativeRealizedProfit");
      expect(boardBody.total).toBe(1);
      expect(boardBody.nextOffset).toBeNull();

      // leaderboard: invalid pagination -> 400
      const badPage = await flagged.inject({ method: "GET", url: "/api/v1/leaderboard?limit=101" });
      expect(badPage.statusCode).toBe(400);

      await flagged.close();
    } finally {
      persistenceDeps.storeFactory = realStore;
      oauthDeps.flowClientFactory = realFlow;
    }
  });

  it("Verifier HIGH regression: OAuth start rotates, linkIdentity conflicts — the FAIL response carries the rotated lv_session", async () => {
    // Expired access token -> verifyTokens refresh rotates -> linkIdentity
    // reports identity_already_exists. The browser must receive the ROTATED
    // session, not be left holding the possibly-invalidated old refresh
    // token (the THE-42 career-detach class through another door).
    const realVerify = sessionDeps.verifyClientFactory;
    sessionDeps.verifyClientFactory = () =>
      ({
        auth: {
          getClaims: async (token: string) =>
            token === "expired-at"
              ? { data: null, error: { status: 401, message: "expired" } }
              : { data: { claims: { sub: "unit-user-uuid" } }, error: null },
          refreshSession: async () => ({
            data: { session: { access_token: "rotated-at", refresh_token: "rotated-rt" } },
            error: null,
          }),
          getUser: async () => ({
            data: { user: { id: "unit-user-uuid", is_anonymous: true } },
            error: null,
          }),
        },
      }) as never;
    const { oauthDeps } = await import("./oauth.js");
    const realFlow = oauthDeps.flowClientFactory;
    oauthDeps.flowClientFactory = () =>
      ({
        auth: {
          setSession: async () => ({ error: null }),
          getSession: async () => ({
            data: { session: { access_token: "rotated-at", refresh_token: "rotated-rt" } },
          }),
          linkIdentity: async () => ({
            data: null,
            error: { status: 422, code: "identity_already_exists" },
          }),
          exchangeCodeForSession: async () => ({ data: null, error: { status: 400 } }),
        },
      }) as never;
    try {
      const flagged = await buildApp({
        LOG_LEVEL: "silent",
        COOKIE_SECRET: "unit-test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
        FEATURE_ACCOUNTS: "true",
        PUBLIC_API_ORIGIN: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com",
      });
      await flagged.ready();
      const { encodeSessionCookie } = await import("./session.js");
      const envelope = encodeSessionCookie({ accessToken: "expired-at", refreshToken: "old-rt" });
      const signedValue = flagged.signCookie(envelope);
      const res = await flagged.inject({
        method: "POST",
        url: "/api/v1/auth/oauth/start",
        payload: { provider: "google", returnTo: "/account" },
        headers: {
          "x-lotveil-request": "oauth",
          cookie: `lv_session=${encodeURIComponent(signedValue)}`,
        },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe("ACCOUNT_ALREADY_EXISTS");
      // The rotated session MUST be written even though the flow failed.
      const rotatedPair = cookiePair(res.headers["set-cookie"], "lv_session");
      expect(rotatedPair).toBeTruthy();
      const unsigned = flagged.unsignCookie(decodeURIComponent(rotatedPair!.split("=")[1]!));
      expect(unsigned.valid).toBe(true);
      const { decodeSessionCookie } = await import("./session.js");
      const written = decodeSessionCookie(unsigned.value!)!;
      expect(written.refreshToken).toBe("rotated-rt");
      expect(written.refreshToken).not.toBe("old-rt");
      await flagged.close();
    } finally {
      sessionDeps.verifyClientFactory = realVerify;
      oauthDeps.flowClientFactory = realFlow;
    }
  });

  it("Verifier MEDIUM: a transient exchange failure consumes lv_oauth and 303-redirects with auth=restart (no raw JSON)", async () => {
    const { oauthDeps, encodeOAuthCookie } = await import("./oauth.js");
    const realFlow = oauthDeps.flowClientFactory;
    oauthDeps.flowClientFactory = () =>
      ({
        auth: {
          exchangeCodeForSession: async () => ({ data: null, error: { status: 500 } }),
        },
      }) as never;
    try {
      const flagged = await buildApp({
        LOG_LEVEL: "silent",
        COOKIE_SECRET: "unit-test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
        FEATURE_ACCOUNTS: "true",
        PUBLIC_API_ORIGIN: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com",
      });
      await flagged.ready();
      const transaction = {
        state: "state-transient",
        sdkFlowId: "flow-1",
        verifierStorageKey: "sb-x-auth-token-code-verifier",
        verifier: "v-123",
        intent: "login" as const,
        expectedPrincipalId: null,
        provider: "google" as const,
        returnTo: "/account",
        issuedAt: Date.now(),
      };
      const envelope = encodeOAuthCookie([transaction]);
      const signedValue = flagged.signCookie(envelope);
      const res = await flagged.inject({
        method: "GET",
        url: `/api/v1/auth/oauth/callback?code=c1&state=state-transient`,
        headers: { cookie: `lv_oauth=${encodeURIComponent(signedValue)}` },
      });
      // A redirect to the frontend restart page, NOT a raw 503 JSON blob.
      expect(res.statusCode).toBe(303);
      const location = res.headers.location as string;
      expect(location).toContain("https://app.example.com/account");
      expect(location).toContain("auth=restart");
      // lv_oauth consumed (cleared).
      const cleared = res.headers["set-cookie"];
      const headers = Array.isArray(cleared) ? cleared : cleared ? [cleared] : [];
      expect(headers.some((h) => h.startsWith("lv_oauth="))).toBe(true);
      await flagged.close();
    } finally {
      oauthDeps.flowClientFactory = realFlow;
    }
  });

  it("THE-42 regression: a 429 during refresh yields 503, no Set-Cookie, and no mint on the mint path", async () => {
    // Expired access token (401 from getClaims) + rate-limited refresh
    // (429). The ONLY mint path is demo-match creation; if the 429 were
    // misclassified as definitive, this request would mint a replacement
    // identity and overwrite lv_session — the career-loss bug.
    const real = sessionDeps.verifyClientFactory;
    let mintCalls = 0;
    const realMintFn = sessionDeps.mint;
    sessionDeps.verifyClientFactory = () =>
      ({
        auth: {
          getClaims: async () => ({ data: null, error: { status: 401, message: "token expired" } }),
          refreshSession: async () => ({
            data: { session: null },
            error: { status: 429, message: "rate limit exceeded" },
          }),
        },
      }) as never;
    sessionDeps.mint = async (...args: Parameters<typeof realMintFn>) => {
      mintCalls += 1;
      return realMintFn(...args);
    };
    try {
      const victim = await buildApp({
        LOG_LEVEL: "silent",
        ALLOW_FIXED_SEED: "true",
        COOKIE_SECRET: "unit-test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
        SUPABASE_SECRET_KEY: "unit-secret",
      });
      await victim.ready();
      // A structurally valid, correctly signed cookie whose tokens the
      // (fault-injected) verifier rejects with 401 then 429. Sign it with
      // the app's own cookie machinery so the signature validates.
      const { encodeSessionCookie } = await import("./session.js");
      const envelope = encodeSessionCookie({ accessToken: "expired-at", refreshToken: "rt" });
      const signedValue = victim.signCookie(envelope);
      const res = await victim.inject({
        method: "POST",
        url: "/api/v1/demo-matches",
        payload: { mode: "human-vs-ai" },
        headers: { cookie: `lv_session=${encodeURIComponent(signedValue)}` },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe("AUTH_TEMPORARILY_UNAVAILABLE");
      // THE-42's two load-bearing assertions: the cookie is preserved
      // byte-for-byte (no overwrite) and no replacement identity was minted.
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(mintCalls).toBe(0);
      await victim.close();
    } finally {
      sessionDeps.verifyClientFactory = real;
      sessionDeps.mint = realMintFn;
    }
  });
});
