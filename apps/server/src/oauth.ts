import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createVerifyClient,
  verifyTokens,
  type CookieOptions,
  type SessionEnv,
  type SessionTokens,
} from "./session.js";

/**
 * THE-39 increment 2 — server-owned PKCE OAuth for guest conversion and
 * account sign-in, plus the pseudonymous display label.
 *
 * Design contract (the-39-design.md, binding decisions recorded in THE-39's
 * design-acceptance Linear comment):
 * - The browser NEVER receives a Supabase token. Start returns
 *   `{redirectUrl}` as JSON (a fetch cannot turn a 302 into top-level
 *   cross-origin navigation); the callback is a 303 to the frontend.
 * - A short-lived signed httpOnly `lv_oauth` transaction cookie carries the
 *   PKCE verifier, Auth JS flow id, state nonce, intent, expected principal,
 *   provider, and safe return path. Signed (the browser must not be able to
 *   change expectedPrincipal/provider/returnTo), not encrypted (a PKCE
 *   verifier is normally held by the user agent; httpOnly+Secure is the
 *   protection).
 * - Conflicts fail safe: identity/email collision preserves lv_session and
 *   every match_seats.user_id. NO automatic sign-in fallback, no merge.
 * - APPROVED EXCEPTION to THE-37a's persistSession:false rule: the OAuth
 *   flow client uses persistSession:true because Auth JS 2.112.2 silently
 *   replaces a custom storage adapter with private in-memory storage when
 *   it is false. Scoped to this client only; its adapter is request-local
 *   and never shared. Every other client keeps persistSession:false.
 * - Google is the ONLY provider for this ticket.
 */

export interface AccountsEnv extends SessionEnv {
  FEATURE_ACCOUNTS: boolean;
  PUBLIC_API_ORIGIN?: string | undefined;
  WEB_ORIGIN?: string | undefined;
  PLAYER_LABEL_SECRET?: string | undefined;
}

/** Overridable seam for fault injection in tests; default is the real factory. */
export const oauthDeps: {
  flowClientFactory: (env: SessionEnv, storage: SupportedStorage) => SupabaseClient;
} = {
  flowClientFactory: (env, storage) =>
    createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        flowType: "pkce",
        // Approved exception (see module docstring): Auth JS 2.112.2 honors
        // the custom storage adapter only when persistSession is true.
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage,
      },
    }),
};

export const OAUTH_PROVIDERS = ["google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Small allowlist of safe in-app return paths (never an arbitrary URL). */
export const RETURN_TO_ALLOWLIST = ["/", "/account", "/leaderboard"] as const;

export const OAUTH_COOKIE = "lv_oauth";
const OAUTH_ENVELOPE_VERSION = 1;
const MAX_TRANSACTIONS = 2; // two tabs; newest wins on duplicate state
const TRANSACTION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OAuthTransaction {
  state: string;
  sdkFlowId: string;
  verifierStorageKey: string;
  verifier: string;
  intent: "convert" | "login";
  expectedPrincipalId: string | null;
  provider: OAuthProvider;
  returnTo: string;
  issuedAt: number;
}

interface OAuthCookieEnvelope {
  v: number;
  transactions: OAuthTransaction[];
}

// ---------------------------------------------------------------------------
// Transaction cookie encode/decode (envelope is signed by Fastify; these
// helpers only handle structure).
// ---------------------------------------------------------------------------

export function encodeOAuthCookie(transactions: OAuthTransaction[]): string {
  const envelope: OAuthCookieEnvelope = { v: OAUTH_ENVELOPE_VERSION, transactions };
  return encodeURIComponent(JSON.stringify(envelope));
}

/** Parse a signature-verified cookie value. Null on any structural problem. */
export function decodeOAuthCookie(raw: string): OAuthTransaction[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Partial<OAuthCookieEnvelope>;
  if (envelope.v !== OAUTH_ENVELOPE_VERSION || !Array.isArray(envelope.transactions)) return null;
  for (const t of envelope.transactions) {
    if (
      typeof t !== "object" ||
      t === null ||
      typeof (t as OAuthTransaction).state !== "string" ||
      typeof (t as OAuthTransaction).sdkFlowId !== "string" ||
      typeof (t as OAuthTransaction).verifierStorageKey !== "string" ||
      typeof (t as OAuthTransaction).verifier !== "string" ||
      ((t as OAuthTransaction).intent !== "convert" && (t as OAuthTransaction).intent !== "login") ||
      typeof (t as OAuthTransaction).provider !== "string" ||
      typeof (t as OAuthTransaction).returnTo !== "string" ||
      typeof (t as OAuthTransaction).issuedAt !== "number"
    ) {
      return null;
    }
  }
  return envelope.transactions as OAuthTransaction[];
}

/** Constant-time state comparison (the callback's CSRF binding). */
export function stateEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Read the transaction list from the request, verifying the signature.
 * Returns null when the cookie is absent, unsigned, or malformed — callers
 * treat all three as "no transaction" (400 / expired-flow page).
 */
export function readOAuthTransactions(request: FastifyRequest): OAuthTransaction[] | null {
  const raw = request.cookies[OAUTH_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return decodeOAuthCookie(unsigned.value);
}

/** Add/refresh a transaction, evicting expired and capping the list. */
export function upsertTransaction(
  existing: OAuthTransaction[] | null,
  next: OAuthTransaction,
  now: number,
): OAuthTransaction[] {
  const live = (existing ?? []).filter((t) => now - t.issuedAt <= TRANSACTION_TTL_MS);
  const withoutDup = live.filter((t) => !stateEquals(t.state, next.state));
  withoutDup.push(next);
  return withoutDup.slice(-MAX_TRANSACTIONS);
}

export function isTransactionExpired(t: OAuthTransaction, now: number): boolean {
  return now - t.issuedAt > TRANSACTION_TTL_MS;
}

export function setOAuthCookie(
  reply: FastifyReply,
  transactions: OAuthTransaction[],
  opts: CookieOptions,
): void {
  reply.setCookie(OAUTH_COOKIE, encodeOAuthCookie(transactions), {
    httpOnly: true,
    path: "/api/v1/auth/oauth",
    signed: true,
    sameSite: opts.production ? "none" : "lax",
    secure: opts.production,
    maxAge: Math.floor(TRANSACTION_TTL_MS / 1000),
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
}

export function clearOAuthCookie(reply: FastifyReply, opts: CookieOptions): void {
  reply.clearCookie(OAUTH_COOKIE, {
    path: "/api/v1/auth/oauth",
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
}

// ---------------------------------------------------------------------------
// Request-local Auth JS storage adapter. Holds ONLY the PKCE verifier slot
// for one transaction; never shared between users or requests.
// ---------------------------------------------------------------------------

export interface VerifierSlot {
  storageKey: string;
  verifier: string;
}

export function createFlowStorage(seed?: VerifierSlot): {
  storage: SupportedStorage;
  capture: () => VerifierSlot | null;
} {
  const memory = new Map<string, string>();
  if (seed) memory.set(seed.storageKey, seed.verifier);
  const storage: SupportedStorage = {
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => {
      memory.set(key, value);
    },
    removeItem: async (key) => {
      memory.delete(key);
    },
  };
  return {
    storage,
    // Auth JS writes the PKCE verifier under a key it names internally
    // (an SDK integration detail — pin the dependency or re-test on
    // upgrade). We capture whichever slot it wrote.
    capture: () => {
      for (const [storageKey, verifier] of memory) {
        if (storageKey.includes("code-verifier")) return { storageKey, verifier };
      }
      const first = memory.entries().next();
      if (first.done) return null;
      return { storageKey: first.value[0], verifier: first.value[1] };
    },
  };
}

// ---------------------------------------------------------------------------
// Display identity: stable pseudonymous label, HMAC-derived. No raw UUIDs,
// no provider display names, no editable profiles.
// ---------------------------------------------------------------------------

export function playerLabel(userId: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update("lotveil:leaderboard-player-label:v1")
    .update(":")
    .update(userId)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return `Player-${digest}`;
}

// ---------------------------------------------------------------------------
// Start flow.
// ---------------------------------------------------------------------------

export type StartFailureCode =
  | "INVALID_REQUEST"
  | "ALREADY_AUTHENTICATED"
  | "SESSION_INVALID"
  | "AUTH_TEMPORARILY_UNAVAILABLE"
  | "AUTH_LINKING_NOT_CONFIGURED"
  | "ACCOUNT_ALREADY_EXISTS";

export type StartOutcome =
  | { kind: "ok"; redirectUrl: string; transaction: OAuthTransaction; rotated: SessionTokens | null }
  | { kind: "fail"; http: number; code: StartFailureCode };

export interface StartParams {
  provider: OAuthProvider;
  returnTo: string;
  /** Decoded lv_session tokens when the cookie was present and well-formed. */
  sessionTokens: SessionTokens | null;
  /** True when a cookie was presented but failed signature/structure checks. */
  presentedMalformedCookie: boolean;
  callbackUrl: string;
  now: number;
}

interface AuthJsError {
  status?: number;
  code?: string;
  message?: string;
}

/** Supabase/Auth JS codes that mean "this identity or email is taken". */
const CONFLICT_CODES = new Set([
  "identity_already_exists",
  "email_exists",
  "user_already_exists",
  "identity_linked_to_another_user",
]);

function isMisconfiguration(err: AuthJsError): boolean {
  const code = err.code ?? "";
  return (
    code === "manual_linking_disabled" ||
    code === "provider_disabled" ||
    code === "validation_failed" || // redirect URL not allowlisted
    /manual linking/i.test(err.message ?? "")
  );
}

/**
 * Orchestrate an OAuth start. Never throws; the outcome is expressed in
 * StartOutcome. Never mutates lv_session except to rotate it when setSession
 * rotated the underlying tokens (returned via `rotated` for the caller to
 * persist alongside the transaction cookie).
 */
export async function oauthStart(
  env: AccountsEnv,
  params: StartParams,
): Promise<StartOutcome> {
  const verifyClient = createVerifyClient(env);
  let intent: "convert" | "login";
  let expectedPrincipalId: string | null = null;
  let rotated: SessionTokens | null = null;

  if (params.sessionTokens) {
    // A cookie was presented. Resolve it with the existing taxonomy — but
    // NEVER fall through to a silent login on definitive invalidity (no
    // silent new-account flow over a presented-but-dead session).
    const resolved = await verifyTokens(verifyClient, params.sessionTokens);
    if (resolved.kind === "transient") {
      return { kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" };
    }
    if (resolved.kind !== "ok") {
      // invalid (or the unreachable absent): a presented-but-dead session
      // must not silently start a new-account flow.
      return { kind: "fail", http: 401, code: "SESSION_INVALID" };
    }
    // ok — effective tokens may have rotated during verification.
    const effective = resolved.rotated ?? params.sessionTokens;
    if (resolved.rotated) rotated = resolved.rotated;

    // Authoritative status: never trust a potentially stale JWT's
    // is_anonymous claim.
    const { data: userData, error: userError } = await verifyClient.auth.getUser(
      effective.accessToken,
    );
    if (userError) {
      const err = userError as AuthJsError;
      const transient =
        typeof err.status === "number"
          ? err.status === 408 || err.status === 429 || err.status >= 500
          : true;
      return transient
        ? { kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" }
        : { kind: "fail", http: 401, code: "SESSION_INVALID" };
    }
    const user = userData.user;
    if (!user) return { kind: "fail", http: 401, code: "SESSION_INVALID" };
    // Invariant: the returned user id must match the verified token subject.
    if (user.id !== resolved.principalId) {
      return { kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" };
    }
    if (user.is_anonymous === false) {
      // Already permanent — no provider trip needed.
      return { kind: "fail", http: 409, code: "ALREADY_AUTHENTICATED" };
    }
    intent = "convert";
    expectedPrincipalId = user.id;
  } else if (params.presentedMalformedCookie) {
    // A presented-but-unreadable cookie is definitive invalidity: explicit
    // recovery required, not a silent new-account flow.
    return { kind: "fail", http: 401, code: "SESSION_INVALID" };
  } else {
    intent = "login";
  }

  // Build the request-scoped flow client and its verifier capture.
  const flow = createFlowStorage();
  const client = oauthDeps.flowClientFactory(env, flow.storage);
  const redirectTo = `${params.callbackUrl}?state=__STATE__`; // placeholder replaced below

  if (intent === "convert") {
    const tokens = params.sessionTokens!;
    const effective = rotated ?? tokens;
    // Seed the client with the anonymous session. If this rotates the
    // session (refresh), the caller must persist the rotation to lv_session.
    const { error: setError } = await client.auth.setSession({
      access_token: effective.accessToken,
      refresh_token: effective.refreshToken,
    });
    if (setError) {
      const err = setError as AuthJsError;
      if (isMisconfiguration(err)) {
        return { kind: "fail", http: 503, code: "AUTH_LINKING_NOT_CONFIGURED" };
      }
      const transient =
        typeof err.status === "number"
          ? err.status === 408 || err.status === 429 || err.status >= 500
          : true;
      return transient
        ? { kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" }
        : { kind: "fail", http: 401, code: "SESSION_INVALID" };
    }
    const { data: sessData } = await client.auth.getSession();
    if (
      sessData.session &&
      (sessData.session.access_token !== effective.accessToken ||
        sessData.session.refresh_token !== effective.refreshToken)
    ) {
      rotated = {
        accessToken: sessData.session.access_token,
        refreshToken: sessData.session.refresh_token,
      };
    }
  }

  const state = randomBytes(32).toString("base64url");
  const redirectUrl = redirectTo.replace("__STATE__", encodeURIComponent(state));

  const options = { redirectTo: redirectUrl, skipBrowserRedirect: true };
  const { data, error } =
    intent === "convert"
      ? await client.auth.linkIdentity({ provider: params.provider, options })
      : await client.auth.signInWithOAuth({ provider: params.provider, options });

  if (error) {
    const err = error as AuthJsError;
    if (isMisconfiguration(err)) {
      return { kind: "fail", http: 503, code: "AUTH_LINKING_NOT_CONFIGURED" };
    }
    if (err.code && CONFLICT_CODES.has(err.code)) {
      // Fail safe: the guest cookie and every match_seats.user_id stay
      // untouched. No automatic sign-in fallback, no merge.
      return { kind: "fail", http: 409, code: "ACCOUNT_ALREADY_EXISTS" };
    }
    const transient =
      typeof err.status === "number"
        ? err.status === 408 || err.status === 429 || err.status >= 500
        : true;
    if (transient) return { kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" };
    // linkIdentity rejecting the current token definitively.
    return { kind: "fail", http: 401, code: "SESSION_INVALID" };
  }

  const providerUrl = (data as { url?: string } | null)?.url;
  if (!providerUrl) {
    // No URL means nothing to navigate to — treat as misconfiguration.
    return { kind: "fail", http: 503, code: "AUTH_LINKING_NOT_CONFIGURED" };
  }
  const flowId =
    (data as { flowId?: string } | null)?.flowId ??
    extractFlowId(providerUrl);
  const slot = flow.capture();
  if (!slot) {
    // The adapter contract failed (SDK upgrade changed storage behaviour).
    return { kind: "fail", http: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE" };
  }

  return {
    kind: "ok",
    redirectUrl: providerUrl,
    transaction: {
      state,
      sdkFlowId: flowId ?? "",
      verifierStorageKey: slot.storageKey,
      verifier: slot.verifier,
      intent,
      expectedPrincipalId,
      provider: params.provider,
      returnTo: params.returnTo,
      issuedAt: params.now,
    },
    rotated,
  };
}

/** Auth JS 2.112.x embeds the flow id in the provider URL query for OAuth. */
function extractFlowId(providerUrl: string): string | null {
  try {
    return new URL(providerUrl).searchParams.get("flow_id");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Callback flow.
// ---------------------------------------------------------------------------

export type CallbackResult =
  | { kind: "success"; tokens: SessionTokens; transaction: OAuthTransaction }
  | {
      kind: "cancelled" | "conflict" | "expired" | "restart" | "failed";
      code: string;
      /** lv_session must be preserved on every non-success path. */
    }
  | { kind: "transient" };

export interface CallbackParams {
  code: string | null;
  state: string | null;
  /** Provider error fields Supabase may append to the redirect. */
  providerError: string | null;
  providerErrorCode: string | null;
  transactions: OAuthTransaction[] | null;
  now: number;
  /** Snapshot-existence check, injected so unit tests need no database. */
  snapshotExists: (userId: string) => Promise<boolean>;
}

/**
 * Validate the transaction, exchange the code, and enforce the conversion
 * invariants. Never throws; never returns tokens for the wrong principal.
 */
export async function oauthCallback(
  env: AccountsEnv,
  params: CallbackParams,
): Promise<CallbackResult> {
  const transactions = params.transactions;
  if (!transactions || transactions.length === 0 || !params.state) {
    return { kind: "expired", code: "missing_or_malformed_state" };
  }
  const tx = transactions.find(
    (t) => !isTransactionExpired(t, params.now) && stateEquals(t.state, params.state!),
  );
  if (!tx) return { kind: "expired", code: "state_not_found_or_expired" };

  // The state is one-time: the caller consumes the transaction for every
  // outcome from here on (success, failure, replay).

  // Provider denial: nonfatal cancel, lv_session preserved.
  if (params.providerError) {
    if (params.providerErrorCode && CONFLICT_CODES.has(params.providerErrorCode)) {
      return { kind: "conflict", code: params.providerErrorCode };
    }
    return { kind: "cancelled", code: params.providerError };
  }
  if (!params.code) return { kind: "failed", code: "missing_code" };

  // Reconstruct a request-local adapter seeded with only this transaction's
  // verifier slot and exchange the code (PKCE binds the code to it).
  const flow = createFlowStorage({
    storageKey: tx.verifierStorageKey,
    verifier: tx.verifier,
  });
  const client = oauthDeps.flowClientFactory(env, flow.storage);
  const { data, error } = tx.sdkFlowId
    ? await client.auth.exchangeCodeForSession(params.code, { flowId: tx.sdkFlowId })
    : await client.auth.exchangeCodeForSession(params.code);

  if (error || !data.session || !data.user) {
    const err = (error ?? {}) as AuthJsError;
    if (err.code && CONFLICT_CODES.has(err.code)) {
      return { kind: "conflict", code: err.code };
    }
    const transient =
      error != null &&
      (typeof err.status === "number"
        ? err.status === 408 || err.status === 429 || err.status >= 500
        : true);
    if (transient) {
      // The code's outcome is uncertain (the identity may already be
      // linked); the caller still consumes the transaction — the trigger
      // snapshot and /api/v1/me recovery cover a committed conversion.
      return { kind: "transient" };
    }
    return { kind: "restart", code: err.code ?? "exchange_failed" };
  }

  const tokens: SessionTokens = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };

  if (tx.intent === "convert") {
    // Invariants, all required before lv_session is overwritten:
    // 1. session+user returned (checked above);
    // 2. returned user id IS the expected principal;
    // 3. the user is permanent (or an authoritative lookup proves it);
    // 4. the conversion snapshot exists.
    if (data.user.id !== tx.expectedPrincipalId) {
      return { kind: "failed", code: "principal_mismatch" };
    }
    if (data.user.is_anonymous !== false) {
      const verifyClient = createVerifyClient(env);
      const { data: userData, error: userError } = await verifyClient.auth.getUser(
        tokens.accessToken,
      );
      if (userError || !userData.user || userData.user.is_anonymous !== false) {
        return { kind: "failed", code: "not_permanent_after_conversion" };
      }
    }
    const snapshot = await params.snapshotExists(data.user.id);
    if (!snapshot) {
      // Fail-closed contract: a conversion is not visible as successful
      // unless its audit record exists.
      return { kind: "failed", code: "snapshot_missing" };
    }
  }

  return { kind: "success", tokens, transaction: tx };
}

/** One-way correlation hash for logs: never log state/verifier/code. */
export function transactionCorrelationHash(state: string): string {
  return createHmac("sha256", "lotveil:oauth-log-correlation:v1")
    .update(state)
    .digest("hex")
    .slice(0, 12);
}
