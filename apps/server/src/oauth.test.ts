import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decodeOAuthCookie,
  encodeOAuthCookie,
  isTransactionExpired,
  oauthCallback,
  oauthDeps,
  oauthStart,
  playerLabel,
  stateEquals,
  transactionCorrelationHash,
  upsertTransaction,
  type AccountsEnv,
  type OAuthTransaction,
} from "./oauth.js";

/**
 * THE-39 unit tests — no Supabase, no network. The flow client is stubbed
 * through oauthDeps.flowClientFactory / oauthTestDeps so the start/callback
 * orchestration and the error matrix are exercised deterministically.
 */

const env: AccountsEnv = {
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_PUBLISHABLE_KEY: "unit-publishable",
  SUPABASE_SECRET_KEY: "unit-secret",
  FEATURE_ACCOUNTS: true,
};

const realFlowFactory = oauthDeps.flowClientFactory;

function stubFlowClient(behaviour: {
  linkIdentity?: (args: unknown) => Promise<{ data: unknown; error: unknown }>;
  signInWithOAuth?: (args: unknown) => Promise<{ data: unknown; error: unknown }>;
  exchangeCodeForSession?: (code: string, opts?: unknown) => Promise<{ data: unknown; error: unknown }>;
  setSession?: (tokens: unknown) => Promise<{ error: unknown }>;
  getSession?: () => Promise<{ data: { session: { access_token: string; refresh_token: string } | null } }>;
}) {
  oauthDeps.flowClientFactory = (_env, storage) =>
    ({
      auth: {
        setSession: behaviour.setSession ?? (async () => ({ error: null })),
        getSession:
          behaviour.getSession ??
          (async () => ({ data: { session: null } })),
        linkIdentity:
          behaviour.linkIdentity ??
          (async () => {
            // Emulate Auth JS writing the verifier through the adapter.
            await storage.setItem("sb-project-auth-token-code-verifier", "verifier-123");
            return { data: { url: "https://provider.example/auth?flow_id=flow-1", flowId: "flow-1" }, error: null };
          }),
        signInWithOAuth:
          behaviour.signInWithOAuth ??
          (async () => {
            await storage.setItem("sb-project-auth-token-code-verifier", "verifier-123");
            return { data: { url: "https://provider.example/auth?flow_id=flow-1" }, error: null };
          }),
        exchangeCodeForSession:
          behaviour.exchangeCodeForSession ??
          (async () => ({
            data: {
              session: { access_token: "new-at", refresh_token: "new-rt" },
              user: { id: "user-uuid-1", is_anonymous: false },
            },
            error: null,
          })),
      },
    }) as unknown as SupabaseClient;
}

function restore() {
  oauthDeps.flowClientFactory = realFlowFactory;
}

// Verify-client stub for the start flow's authoritative getUser lookup.
import { sessionDeps } from "./session.js";
const realVerifyFactory = sessionDeps.verifyClientFactory;

function stubVerifyClient(user: { id: string; is_anonymous: boolean } | null, opts?: { claimsError?: unknown }) {
  sessionDeps.verifyClientFactory = () =>
    ({
      auth: {
        getClaims: async (_token: string) =>
          opts?.claimsError
            ? { data: null, error: opts.claimsError }
            : { data: { claims: { sub: user?.id ?? "user-uuid-1" } }, error: null },
        refreshSession: async () => ({ data: { session: null }, error: { status: 400 } }),
        getUser: async () =>
          user
            ? { data: { user }, error: null }
            : { data: { user: null }, error: { status: 401 } },
      },
    }) as never;
}

function restoreVerify() {
  sessionDeps.verifyClientFactory = realVerifyFactory;
}

const tokens = { accessToken: "at-1", refreshToken: "rt-1" };

function tx(overrides: Partial<OAuthTransaction> = {}): OAuthTransaction {
  return {
    state: "state-abc",
    sdkFlowId: "flow-1",
    verifierStorageKey: "sb-project-auth-token-code-verifier",
    verifier: "verifier-123",
    intent: "convert",
    expectedPrincipalId: "user-uuid-1",
    provider: "google",
    returnTo: "/account",
    issuedAt: 1_000,
    ...overrides,
  };
}

describe("lv_oauth transaction cookie envelope", () => {
  it("round-trips a versioned envelope with transactions", () => {
    const encoded = encodeOAuthCookie([tx()]);
    expect(decodeURIComponent(encoded)).toContain('"v":1');
    expect(decodeOAuthCookie(encoded)).toEqual([tx()]);
  });

  it.each([
    ["missing version", encodeURIComponent(JSON.stringify({ transactions: [] }))],
    ["unknown version", encodeURIComponent(JSON.stringify({ v: 99, transactions: [] }))],
    ["malformed JSON", encodeURIComponent("{not json")],
    ["bad transaction shape", encodeURIComponent(JSON.stringify({ v: 1, transactions: [{ state: 1 }] }))],
  ])("treats %s as no transaction", (_label, raw) => {
    expect(decodeOAuthCookie(raw)).toBeNull();
  });

  it("upsert caps at two entries, newest wins on duplicate state, expired evicted", () => {
    const now = 10_000;
    const old = tx({ state: "old", issuedAt: now - 11 * 60 * 1000 }); // expired
    const a = tx({ state: "a", issuedAt: now - 1000 });
    const b = tx({ state: "b", issuedAt: now - 500 });
    const c = tx({ state: "c", issuedAt: now });
    expect(upsertTransaction([old, a], b, now).map((t) => t.state)).toEqual(["a", "b"]);
    expect(upsertTransaction([a, b], c, now).map((t) => t.state)).toEqual(["b", "c"]);
    // duplicate state: newest wins
    expect(upsertTransaction([a, b], tx({ state: "a", issuedAt: now }), now).map((t) => t.state)).toEqual(["b", "a"]);
  });

  it("stateEquals is constant-time and length-safe", () => {
    expect(stateEquals("abc", "abc")).toBe(true);
    expect(stateEquals("abc", "abd")).toBe(false);
    expect(stateEquals("abc", "abcd")).toBe(false);
  });

  it("isTransactionExpired honours the 10-minute TTL", () => {
    expect(isTransactionExpired(tx({ issuedAt: 1000 }), 1000 + 5 * 60 * 1000)).toBe(false);
    expect(isTransactionExpired(tx({ issuedAt: 1000 }), 1000 + 11 * 60 * 1000)).toBe(true);
  });
});

describe("playerLabel", () => {
  it("is deterministic, pseudonymous, and contains no raw UUID", () => {
    const a = playerLabel("user-uuid-1", "secret-key-material");
    const b = playerLabel("user-uuid-1", "secret-key-material");
    const c = playerLabel("user-uuid-2", "secret-key-material");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^Player-[0-9A-F]{6}$/);
    expect(a).not.toContain("user-uuid-1");
  });

  it("differs by secret (domain separation holds)", () => {
    expect(playerLabel("user-uuid-1", "secret-a")).not.toBe(playerLabel("user-uuid-1", "secret-b"));
  });
});

describe("oauthStart — intent selection and failure taxonomy", () => {
  it("no session -> login intent via signInWithOAuth with a captured verifier", async () => {
    stubFlowClient({});
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: null,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/api/v1/auth/oauth/callback",
        now: 5_000,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.transaction.intent).toBe("login");
        expect(outcome.transaction.expectedPrincipalId).toBeNull();
        expect(outcome.transaction.verifier).toBe("verifier-123");
        expect(outcome.transaction.sdkFlowId).toBe("flow-1");
        expect(outcome.redirectUrl).toContain("provider.example");
      }
    } finally {
      restore();
    }
  });

  it("anonymous session -> convert intent via linkIdentity with expectedPrincipalId", async () => {
    stubVerifyClient({ id: "user-uuid-1", is_anonymous: true });
    stubFlowClient({});
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: tokens,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/api/v1/auth/oauth/callback",
        now: 5_000,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.transaction.intent).toBe("convert");
        expect(outcome.transaction.expectedPrincipalId).toBe("user-uuid-1");
      }
    } finally {
      restore();
      restoreVerify();
    }
  });

  it("permanent session -> 409 ALREADY_AUTHENTICATED, no provider trip", async () => {
    stubVerifyClient({ id: "user-uuid-1", is_anonymous: false });
    let linkCalls = 0;
    stubFlowClient({
      linkIdentity: async () => {
        linkCalls += 1;
        return { data: null, error: null };
      },
    });
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: tokens,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/cb",
        now: 5_000,
      });
      expect(outcome).toEqual({ kind: "fail", http: 409, code: "ALREADY_AUTHENTICATED" });
      expect(linkCalls).toBe(0);
    } finally {
      restore();
      restoreVerify();
    }
  });

  it("definitively invalid presented cookie -> 401 SESSION_INVALID, no silent login", async () => {
    stubVerifyClient(null, { claimsError: { status: 401 } });
    let oauthCalls = 0;
    stubFlowClient({
      signInWithOAuth: async () => {
        oauthCalls += 1;
        return { data: null, error: null };
      },
    });
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: tokens,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/cb",
        now: 5_000,
      });
      expect(outcome).toEqual({ kind: "fail", http: 401, code: "SESSION_INVALID" });
      expect(oauthCalls).toBe(0);
    } finally {
      restore();
      restoreVerify();
    }
  });

  it("transient verification failure -> 503, cookie preserved (no transaction)", async () => {
    stubVerifyClient(null, { claimsError: { status: 503 } });
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: tokens,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/cb",
        now: 5_000,
      });
      expect(outcome).toEqual({ kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" });
    } finally {
      restoreVerify();
    }
  });

  it("identity_already_exists at link -> 409 ACCOUNT_ALREADY_EXISTS (fail safe)", async () => {
    stubVerifyClient({ id: "user-uuid-1", is_anonymous: true });
    stubFlowClient({
      linkIdentity: async () => ({ data: null, error: { status: 422, code: "identity_already_exists" } }),
    });
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: tokens,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/cb",
        now: 5_000,
      });
      expect(outcome).toEqual({ kind: "fail", http: 409, code: "ACCOUNT_ALREADY_EXISTS" });
    } finally {
      restore();
      restoreVerify();
    }
  });

  it("manual linking disabled -> 503 AUTH_LINKING_NOT_CONFIGURED", async () => {
    stubVerifyClient({ id: "user-uuid-1", is_anonymous: true });
    stubFlowClient({
      linkIdentity: async () => ({ data: null, error: { status: 400, code: "manual_linking_disabled" } }),
    });
    try {
      const outcome = await oauthStart(env, {
        provider: "google",
        returnTo: "/account",
        sessionTokens: tokens,
        presentedMalformedCookie: false,
        callbackUrl: "https://api.example/cb",
        now: 5_000,
      });
      expect(outcome).toEqual({ kind: "fail", http: 503, code: "AUTH_LINKING_NOT_CONFIGURED" });
    } finally {
      restore();
      restoreVerify();
    }
  });
});

describe("oauthCallback — error matrix", () => {
  const snapshotExists = async () => true;

  it("missing state/cookie -> expired flow, no exchange attempted", async () => {
    let exchanges = 0;
    stubFlowClient({
      exchangeCodeForSession: async () => {
        exchanges += 1;
        return { data: null, error: null };
      },
    });
    try {
      const result = await oauthCallback(env, {
        code: "code-1",
        state: null,
        providerError: null,
        providerErrorCode: null,
        transactions: [tx()],
        now: 2_000,
        snapshotExists,
      });
      expect(result.kind).toBe("expired");
      expect(exchanges).toBe(0);
    } finally {
      restore();
    }
  });

  it("state mismatch -> expired (constant-time, one-time semantics left to caller)", async () => {
    const result = await oauthCallback(env, {
      code: "code-1",
      state: "wrong-state",
      providerError: null,
      providerErrorCode: null,
      transactions: [tx()],
      now: 2_000,
      snapshotExists,
    });
    expect(result.kind).toBe("expired");
  });

  it("provider denial -> cancelled, lv_session preserved", async () => {
    const result = await oauthCallback(env, {
      code: null,
      state: "state-abc",
      providerError: "access_denied",
      providerErrorCode: null,
      transactions: [tx()],
      now: 2_000,
      snapshotExists,
    });
    expect(result.kind).toBe("cancelled");
  });

  it("identity conflict at callback -> conflict (fail safe)", async () => {
    const result = await oauthCallback(env, {
      code: null,
      state: "state-abc",
      providerError: "server_error",
      providerErrorCode: "identity_already_exists",
      transactions: [tx()],
      now: 2_000,
      snapshotExists,
    });
    expect(result.kind).toBe("conflict");
  });

  it("missing code -> failed flow", async () => {
    const result = await oauthCallback(env, {
      code: null,
      state: "state-abc",
      providerError: null,
      providerErrorCode: null,
      transactions: [tx()],
      now: 2_000,
      snapshotExists,
    });
    expect(result.kind).toBe("failed");
  });

  it("exchange 4xx (PKCE mismatch) -> restart; 5xx/network -> transient", async () => {
    stubFlowClient({
      exchangeCodeForSession: async () => ({ data: null, error: { status: 400, code: "bad_code" } }),
    });
    try {
      const result = await oauthCallback(env, {
        code: "code-1",
        state: "state-abc",
        providerError: null,
        providerErrorCode: null,
        transactions: [tx()],
        now: 2_000,
        snapshotExists,
      });
      expect(result.kind).toBe("restart");
    } finally {
      restore();
    }
    stubFlowClient({
      exchangeCodeForSession: async () => ({ data: null, error: { status: 500 } }),
    });
    try {
      const result = await oauthCallback(env, {
        code: "code-1",
        state: "state-abc",
        providerError: null,
        providerErrorCode: null,
        transactions: [tx()],
        now: 2_000,
        snapshotExists,
      });
      expect(result.kind).toBe("transient");
    } finally {
      restore();
    }
  });

  it("convert success requires principal match + permanent + snapshot", async () => {
    stubFlowClient({});
    try {
      const ok = await oauthCallback(env, {
        code: "code-1",
        state: "state-abc",
        providerError: null,
        providerErrorCode: null,
        transactions: [tx()],
        now: 2_000,
        snapshotExists,
      });
      expect(ok.kind).toBe("success");
      if (ok.kind === "success") {
        expect(ok.tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
      }
    } finally {
      restore();
    }
  });

  it("convert with a mismatched principal -> invariant failure, tokens NOT returned", async () => {
    stubFlowClient({
      exchangeCodeForSession: async () => ({
        data: {
          session: { access_token: "new-at", refresh_token: "new-rt" },
          user: { id: "SOMEONE-ELSE", is_anonymous: false },
        },
        error: null,
      }),
    });
    try {
      const result = await oauthCallback(env, {
        code: "code-1",
        state: "state-abc",
        providerError: null,
        providerErrorCode: null,
        transactions: [tx()],
        now: 2_000,
        snapshotExists,
      });
      expect(result.kind).toBe("failed");
      expect(result).not.toHaveProperty("tokens");
    } finally {
      restore();
    }
  });

  it("convert with a missing snapshot -> failed (fail-closed contract)", async () => {
    stubFlowClient({});
    try {
      const result = await oauthCallback(env, {
        code: "code-1",
        state: "state-abc",
        providerError: null,
        providerErrorCode: null,
        transactions: [tx()],
        now: 2_000,
        snapshotExists: async () => false,
      });
      expect(result.kind).toBe("failed");
    } finally {
      restore();
    }
  });
});

describe("log redaction helper", () => {
  it("transactionCorrelationHash is one-way and stable", () => {
    const h1 = transactionCorrelationHash("state-abc");
    const h2 = transactionCorrelationHash("state-abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
    expect(h1).not.toContain("state-abc");
  });
});
