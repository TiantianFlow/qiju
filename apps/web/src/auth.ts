import { API_BASE_URL, withApiCredentials } from "./config";

/**
 * THE-58 — browser client for the THE-39 accounts surface.
 *
 * Binding constraints (the-39-design.md, assignment):
 * - The browser never holds a Supabase token or client. Authentication is
 *   the server's httpOnly `lv_session` cookie; these requests are
 *   credentialed, nothing more.
 * - OAuth start is a credentialed JSON POST carrying `X-Lotveil-Request:
 *   oauth`, then top-level navigation to the returned provider URL. A fetch
 *   cannot turn a server 302 into top-level cross-origin navigation, and a
 *   cross-site form post would weaken CSRF protection — so neither exists.
 * - Every surface degrades silently while FEATURE_ACCOUNTS is off: the
 *   server answers 404 for /api/v1/me and /api/v1/leaderboard, which is
 *   "feature unavailable", never an error to log.
 * - Display identity is the server's `playerLabel` only. Never render raw
 *   UUIDs or provider display names.
 */

export interface MeResponse {
  principal: "guest" | "account" | "none";
  playerLabel: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  playerLabel: string;
  isSelf: boolean;
  appraiserRating: number;
  matchesPlayed: number;
  cumulativeRealizedProfit: number;
  tycoonTier: string;
}

export interface LeaderboardPage {
  entries: LeaderboardEntry[];
  total: number;
  nextOffset: number | null;
}

/** The six auth= outcomes the OAuth callback can 303 back with. */
export type AuthOutcome = "ok" | "cancelled" | "conflict" | "expired" | "restart" | "failed";

export const AUTH_OUTCOMES: readonly AuthOutcome[] = [
  "ok",
  "cancelled",
  "conflict",
  "expired",
  "restart",
  "failed",
];

/**
 * Read and validate the `auth=` callback outcome from the current URL,
 * removing it from the address bar (it is one-shot UI state, not part of
 * the location). Returns null when absent or not a known outcome.
 */
export function consumeAuthOutcome(
  search: string,
  pathname: string,
): { outcome: AuthOutcome | null; cleanUrl: string } {
  const params = new URLSearchParams(search);
  const raw = params.get("auth");
  if (raw === null) return { outcome: null, cleanUrl: `${pathname}${search}` };
  params.delete("auth");
  const rest = params.toString();
  const cleanUrl = rest ? `${pathname}?${rest}` : pathname;
  const outcome = (AUTH_OUTCOMES as readonly string[]).includes(raw) ? (raw as AuthOutcome) : null;
  return { outcome, cleanUrl };
}

/**
 * Fetch /api/v1/me. Returns null when the accounts feature is not deployed
 * (404 while the flag is off) or the request cannot complete — both are
 * "unknown", not an error worth surfacing or logging.
 */
export async function fetchMe(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = API_BASE_URL,
): Promise<MeResponse | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/me`, withApiCredentials());
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<MeResponse>;
    if (
      (data.principal === "guest" || data.principal === "account" || data.principal === "none") &&
      (typeof data.playerLabel === "string" || data.playerLabel === null)
    ) {
      return { principal: data.principal, playerLabel: data.playerLabel };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch one leaderboard page. Returns null when the feature is unavailable
 * or the request fails — the page then shows a quiet "unavailable" state
 * instead of console noise or a broken layout.
 */
export async function fetchLeaderboard(
  offset: number,
  limit: number,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = API_BASE_URL,
): Promise<LeaderboardPage | null> {
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/v1/leaderboard?offset=${offset}&limit=${limit}`,
      withApiCredentials(),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<LeaderboardPage>;
    if (!Array.isArray(data.entries) || typeof data.total !== "number") return null;
    return {
      entries: data.entries as LeaderboardEntry[],
      total: data.total,
      nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : null,
    };
  } catch {
    return null;
  }
}

/**
 * Begin the Google OAuth flow: one credentialed JSON POST with the required
 * custom header, then top-level navigation to the provider URL. Returns
 * false when the server refused the start (any non-2xx or malformed body);
 * the caller keeps the user on the page and shows a retryable notice.
 * `navigate` is injectable so unit tests run without a DOM.
 */
export async function startOAuthSignIn(
  returnTo: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = API_BASE_URL,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/v1/auth/oauth/start`,
      withApiCredentials({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lotveil-Request": "oauth",
        },
        body: JSON.stringify({ provider: "google", returnTo }),
      }),
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { redirectUrl?: unknown };
    if (typeof data.redirectUrl !== "string" || data.redirectUrl.length === 0) return false;
    navigate(data.redirectUrl);
    return true;
  } catch {
    return false;
  }
}
