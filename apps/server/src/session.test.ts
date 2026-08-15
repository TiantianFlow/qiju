import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  decodeSessionCookie,
  encodeSessionCookie,
  getClientIp,
  pendingRefreshCount,
  verifyTokens,
} from "./session.js";

function fakeVerifyClient(
  behaviour: Record<string, (args?: unknown) => Promise<unknown>>,
): never {
  return {
    auth: {
      getClaims: behaviour.getClaims ?? (async () => ({ data: null, error: null })),
      refreshSession: behaviour.refreshSession ?? (async () => ({ data: null, error: null })),
    },
  } as never;
}

const tokens = { accessToken: "at-1", refreshToken: "rt-1" };

describe("session cookie envelope", () => {
  it("round-trips a versioned envelope", () => {
    const encoded = encodeSessionCookie(tokens);
    expect(decodeURIComponent(encoded)).toContain('"v":1');
    expect(decodeSessionCookie(encoded)).toEqual(tokens);
  });

  it("stays far under the 4 KB cookie ceiling for realistic tokens", () => {
    // Supabase anonymous access JWTs are ~550-800 B; use a 2 KB stand-in to
    // prove ample headroom even for a much larger token.
    const big = {
      accessToken: `h.${"a".repeat(2048)}.s`,
      refreshToken: "r".repeat(64),
    };
    const encoded = encodeSessionCookie(big);
    // +64 approximates the signing suffix Fastify appends.
    expect(encoded.length + 64).toBeLessThan(4000);
  });

  it.each([
    ["missing version", encodeURIComponent(JSON.stringify({ access_token: "a", refresh_token: "b" }))],
    ["unknown version", encodeURIComponent(JSON.stringify({ v: 99, access_token: "a", refresh_token: "b" }))],
    ["malformed JSON", encodeURIComponent("{not json")],
    ["missing refresh token", encodeURIComponent(JSON.stringify({ v: 1, access_token: "a" }))],
  ])("treats %s as definitively invalid", (_label, raw) => {
    expect(decodeSessionCookie(raw)).toBeNull();
  });
});

describe("verifyTokens failure taxonomy", () => {
  it("returns the principal when claims verify", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => ({ data: { claims: { sub: "user-uuid-1" } }, error: null }),
    });
    const result = await verifyTokens(client, tokens);
    expect(result).toEqual({ kind: "ok", principalId: "user-uuid-1", rotated: null });
  });

  it("classifies a network-style getClaims failure as transient (never mints)", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => ({ data: null, error: { status: 500, message: "jwks unavailable" } }),
    });
    expect(await verifyTokens(client, tokens)).toEqual({ kind: "transient" });
  });

  it("classifies a thrown getClaims error as transient", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => {
        throw new Error("fetch failed");
      },
    });
    expect(await verifyTokens(client, tokens)).toEqual({ kind: "transient" });
  });

  it("refreshes on a definitive access-token rejection and rotates", async () => {
    let getClaimsCalls = 0;
    const client = fakeVerifyClient({
      getClaims: async (token) => {
        getClaimsCalls += 1;
        if (token === "at-1") {
          return { data: null, error: { status: 401, message: "token expired" } };
        }
        return { data: { claims: { sub: "user-uuid-1" } }, error: null };
      },
      refreshSession: async () => ({
        data: { session: { access_token: "at-2", refresh_token: "rt-2" } },
        error: null,
      }),
    });
    const result = await verifyTokens(client, tokens);
    expect(result).toEqual({
      kind: "ok",
      principalId: "user-uuid-1",
      rotated: { accessToken: "at-2", refreshToken: "rt-2" },
    });
    expect(getClaimsCalls).toBe(2);
  });

  it("classifies a conclusive 4xx refresh rejection as definitively invalid", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => ({ data: null, error: { status: 401, message: "expired" } }),
      refreshSession: async () => ({
        data: { session: null },
        error: { status: 400, code: "refresh_token_not_found" },
      }),
    });
    expect(await verifyTokens(client, tokens)).toEqual({ kind: "invalid" });
  });

  it("classifies a transient refresh failure as transient", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => ({ data: null, error: { status: 401, message: "expired" } }),
      refreshSession: async () => ({ data: { session: null }, error: { status: 503 } }),
    });
    expect(await verifyTokens(client, tokens)).toEqual({ kind: "transient" });
  });

  // THE-42 regression: a 429 (or 408) during refresh is NOT proof the
  // credential is dead. The old taxonomy treated every 4xx as definitive,
  // so a rate-limited refresh read as "invalid", requirePrincipal minted a
  // replacement identity, and the player silently lost their career.
  it.each([429, 408])(
    "THE-42: a %i refresh rejection is transient — never mints, never invalidates",
    async (status) => {
      const client = fakeVerifyClient({
        getClaims: async () => ({ data: null, error: { status: 401, message: "token expired" } }),
        refreshSession: async () => ({
          data: { session: null },
          error: { status, message: status === 429 ? "rate limit exceeded" : "request timeout" },
        }),
      });
      expect(await verifyTokens(client, tokens)).toEqual({ kind: "transient" });
    },
  );

  it("THE-42: a 429 from getClaims itself is transient, not definitive", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => ({ data: null, error: { status: 429, message: "rate limit" } }),
    });
    expect(await verifyTokens(client, tokens)).toEqual({ kind: "transient" });
  });

  it("single-flight: concurrent refreshes share one call and the map drains on settle", async () => {
    let refreshCalls = 0;
    const client = fakeVerifyClient({
      getClaims: async (token) =>
        token === "at-1"
          ? { data: null, error: { status: 401 } }
          : { data: { claims: { sub: "user-uuid-1" } }, error: null },
      refreshSession: async () => {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { data: { session: { access_token: "at-2", refresh_token: "rt-2" } }, error: null };
      },
    });
    const results = await Promise.all([
      verifyTokens(client, tokens),
      verifyTokens(client, tokens),
      verifyTokens(client, tokens),
    ]);
    for (const result of results) expect(result.kind).toBe("ok");
    expect(refreshCalls).toBe(1);
    // Entry deleted on settle: no unbounded growth, no retained credentials.
    expect(pendingRefreshCount()).toBe(0);
  });

  it("single-flight map drains after a rejected refresh too", async () => {
    const client = fakeVerifyClient({
      getClaims: async () => ({ data: null, error: { status: 401 } }),
      refreshSession: async () => {
        throw new Error("boom");
      },
    });
    expect(await verifyTokens(client, tokens)).toEqual({ kind: "transient" });
    expect(pendingRefreshCount()).toBe(0);
  });
});

describe("getClientIp trust boundary", () => {
  function requestWith(headers: Record<string, string>): FastifyRequest {
    return { ip: "10.9.9.9", headers } as unknown as FastifyRequest;
  }

  it("default is untrusted: socket peer wins, forwarding headers ignored", () => {
    const req = requestWith({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" });
    expect(getClientIp(req, false)).toBe("10.9.9.9");
  });

  it("trusted mode uses CF-Connecting-IP and never caller X-Forwarded-For", () => {
    const req = requestWith({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" });
    expect(getClientIp(req, true)).toBe("1.2.3.4");
  });

  it("trusted mode falls back to the socket peer when the header is absent", () => {
    const req = requestWith({});
    expect(getClientIp(req, true)).toBe("10.9.9.9");
  });
});

describe("signup client carries request-local Sb-Forwarded-For", () => {
  it("per-request construction, never a shared global header", async () => {
    const { createSignupClient } = await import("./session.js");
    const env = {
      SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_PUBLISHABLE_KEY: "publishable-test",
      SUPABASE_SECRET_KEY: "secret-test-value-not-logged",
    };
    const a = createSignupClient(env, "1.1.1.1");
    const b = createSignupClient(env, "2.2.2.2");
    expect(a).not.toBe(b);
    const headersOf = (client: unknown) =>
      (client as { headers: Record<string, string> }).headers;
    expect(headersOf(a)["Sb-Forwarded-For"]).toBe("1.1.1.1");
    expect(headersOf(b)["Sb-Forwarded-For"]).toBe("2.2.2.2");
    expect(headersOf(a)["apikey"]).toBeUndefined();
    // The verify client must never hold the secret key.
    const { createVerifyClient } = await import("./session.js");
    const verify = createVerifyClient(env);
    expect(headersOf(verify)["Sb-Forwarded-For"]).toBeUndefined();
  });
});
