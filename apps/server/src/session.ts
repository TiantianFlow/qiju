import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * THE-37a — server-side Supabase anonymous-session lifecycle.
 *
 * Design contract (see the approved plan):
 * - The SECRET-key client is used for signInAnonymously ONLY, is constructed
 *   PER REQUEST, and carries a request-local Sb-Forwarded-For header. It is
 *   never a module-level singleton with global headers — that would forward
 *   one user's IP for every signup.
 * - The PUBLISHABLE-key client handles getClaims / refreshSession with tokens
 *   passed explicitly per call. It holds no session state.
 * - Every client: persistSession/autoRefreshToken/detectSessionInUrl = false.
 *   No client instance outlives a request with session state attached.
 */

export interface SessionEnv {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export type ResolveResult =
  | { kind: "ok"; principalId: string; rotated: SessionTokens | null }
  | { kind: "absent" }
  | { kind: "invalid" } // definitive: bad signature, unknown version, revoked refresh
  | { kind: "transient" }; // unknown: network/5xx/JWKS — preserve the cookie, fail closed

const COOKIE_ENVELOPE_VERSION = 1;

/** Session record persisted in the signed lv_session cookie (versioned envelope). */
interface CookieEnvelope {
  v: number;
  access_token: string;
  refresh_token: string;
}

export function encodeSessionCookie(tokens: SessionTokens): string {
  const envelope: CookieEnvelope = {
    v: COOKIE_ENVELOPE_VERSION,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  };
  return encodeURIComponent(JSON.stringify(envelope));
}

/**
 * Parse a cookie value that has already passed Fastify's signature check.
 * Returns null on any definitive structural problem (bad JSON, missing/unknown
 * version, missing tokens). Signature failure is handled by the caller.
 */
export function decodeSessionCookie(raw: string): SessionTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Partial<CookieEnvelope>;
  if (envelope.v !== COOKIE_ENVELOPE_VERSION) return null;
  if (typeof envelope.access_token !== "string" || typeof envelope.refresh_token !== "string") {
    return null;
  }
  return { accessToken: envelope.access_token, refreshToken: envelope.refresh_token };
}

/** True when a getClaims/refresh failure is inconclusive (network, 5xx, JWKS down). */
function isTransientError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const err = error as { status?: number; name?: string; code?: string; message?: string };
  // Conclusive HTTP rejections (bad token, revoked refresh) arrive as 4xx.
  if (typeof err.status === "number") {
    if (err.status >= 400 && err.status < 500) return false;
    return true; // 5xx and anything else HTTP-shaped is inconclusive
  }
  // AuthApiError without a status, fetch failures, timeouts: inconclusive.
  return true;
}

const AUTH_CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

/** Overridable seams for fault injection in tests; defaults are the real factories. */
export const sessionDeps: {
  verifyClientFactory: (env: SessionEnv) => SupabaseClient;
  mint: (env: SessionEnv, clientIp: string) => Promise<{ kind: "ok"; tokens: SessionTokens } | { kind: "transient" }>;
} = {
  verifyClientFactory: (env) => createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, AUTH_CLIENT_OPTIONS),
  mint: (env, clientIp) => mintAnonymousSession(env, clientIp),
};

/** Publishable-key client: getClaims + refreshSession only. Stateless by construction. */
export function createVerifyClient(env: SessionEnv): SupabaseClient {
  return sessionDeps.verifyClientFactory(env);
}

/**
 * Secret-key client: signInAnonymously ONLY. Constructed per request so the
 * Sb-Forwarded-For header is request-local. The secret key must never reach
 * the browser, a log line, or a test fixture.
 */
export function createSignupClient(env: SessionEnv, clientIp: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    ...AUTH_CLIENT_OPTIONS,
    global: { headers: { "Sb-Forwarded-For": clientIp } },
  });
}

/**
 * Single-flight refresh: concurrent requests holding the same expired cookie
 * share one refresh call. Each entry is deleted on settle so the map cannot
 * grow unboundedly and never retains credentials after a refresh completes.
 */
const inFlightRefreshes = new Map<string, Promise<SessionTokens | null>>();

async function refreshSessionSingleFlight(
  client: SupabaseClient,
  refreshToken: string,
): Promise<SessionTokens | null> {
  const existing = inFlightRefreshes.get(refreshToken);
  if (existing) return existing;
  const promise = (async (): Promise<SessionTokens | null> => {
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (error) {
      if (isTransientError(error)) throw error;
      return null; // definitive rejection (e.g. refresh token revoked)
    }
    if (!data.session) return null;
    return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
  })();
  inFlightRefreshes.set(refreshToken, promise);
  const settled = promise.finally(() => {
    inFlightRefreshes.delete(refreshToken);
  });
  // Detach a catch so the derived promise cannot surface as unhandled;
  // callers await the original promise.
  settled.catch(() => {});
  return promise;
}

/** Test-only: assert the single-flight map drains after settle. */
export function pendingRefreshCount(): number {
  return inFlightRefreshes.size;
}

/**
 * Verify a presented session. Refreshes when the access token is rejected.
 * Throws nothing; the outcome is expressed in the ResolveResult kind.
 */
export async function verifyTokens(
  client: SupabaseClient,
  tokens: SessionTokens,
): Promise<ResolveResult> {
  try {
    const { data, error } = await client.auth.getClaims(tokens.accessToken);
    if (!error && data?.claims?.sub) {
      return { kind: "ok", principalId: data.claims.sub as string, rotated: null };
    }
    if (error && isTransientError(error)) return { kind: "transient" };
  } catch {
    return { kind: "transient" };
  }
  // Access token definitively rejected — try the refresh token.
  try {
    const rotated = await refreshSessionSingleFlight(client, tokens.refreshToken);
    if (!rotated) return { kind: "invalid" };
    const { data, error } = await client.auth.getClaims(rotated.accessToken);
    if (error || !data?.claims?.sub) {
      return error && isTransientError(error) ? { kind: "transient" } : { kind: "invalid" };
    }
    return { kind: "ok", principalId: data.claims.sub as string, rotated };
  } catch {
    return { kind: "transient" };
  }
}

/**
 * Mint a new anonymous session via the per-request secret-key client.
 * Any failure here is inconclusive by construction — a signup that did not
 * complete tells us nothing about an existing identity — so it is transient.
 */
export async function mintAnonymousSession(
  env: SessionEnv,
  clientIp: string,
): Promise<{ kind: "ok"; tokens: SessionTokens } | { kind: "transient" }> {
  const client = createSignupClient(env, clientIp);
  try {
    const { data, error } = await client.auth.signInAnonymously();
    if (error || !data.session) return { kind: "transient" };
    return {
      kind: "ok",
      tokens: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token },
    };
  } catch {
    return { kind: "transient" };
  }
}

/** Test-only seam: wrap a verify client so every call fails inconclusively. */
export function failingVerifyClient(): SupabaseClient {
  return {
    auth: {
      getClaims: async () => {
        throw new Error("fault-injected: auth unreachable");
      },
      refreshSession: async () => {
        throw new Error("fault-injected: auth unreachable");
      },
    },
  } as unknown as SupabaseClient;
}

export interface CookieOptions {
  production: boolean;
  domain?: string;
}

function cookieOptions(opts: CookieOptions): Parameters<FastifyReply["setCookie"]>[2] {
  return {
    httpOnly: true,
    path: "/",
    signed: true,
    sameSite: opts.production ? "none" : "lax",
    secure: opts.production,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

export function setSessionCookie(reply: FastifyReply, tokens: SessionTokens, opts: CookieOptions): void {
  reply.setCookie("lv_session", encodeSessionCookie(tokens), cookieOptions(opts));
}

export function clearLegacyGuestCookie(reply: FastifyReply, opts: CookieOptions): void {
  reply.clearCookie("lv_guest", {
    path: "/",
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
}

/**
 * Resolve the client IP under the declared trust boundary. DEFAULT IS
 * UNTRUSTED: without the explicit switch, the socket peer is returned and
 * caller-supplied forwarding headers are ignored entirely. Whether trusted
 * mode can be safely enabled in production is an unresolved infra decision
 * (requires Cloudflare-proxied backend ingress AND direct Railway ingress
 * blocked or validated) — it is not settled by this code.
 */
export function getClientIp(request: FastifyRequest, trustCfConnectingIp: boolean): string {
  if (trustCfConnectingIp) {
    const cf = request.headers["cf-connecting-ip"];
    const value = Array.isArray(cf) ? cf[0] : cf;
    if (value) return value;
  }
  return request.ip;
}
