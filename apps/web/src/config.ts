/**
 * Backend API base URL. Empty string means "same origin" (relative paths) —
 * used for local dev (Vite proxy) and same-origin production deploys. A
 * non-empty value (e.g. https://api.example.com) is used when the frontend
 * and backend are deployed to different origins (Cloudflare Pages + Railway).
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_URL || "";

/** True when the API lives on a different origin than the page — callers must send cookies explicitly. */
export const IS_CROSS_ORIGIN_API: boolean = API_BASE_URL !== "";

/**
 * Merges `credentials: "include"` into a fetch init when the API is
 * cross-origin, so the guest-session cookie is sent; omits the key entirely
 * otherwise (rather than `undefined`, which `exactOptionalPropertyTypes`
 * treats differently from an absent key).
 */
export function withApiCredentials(init: RequestInit = {}): RequestInit {
  return IS_CROSS_ORIGIN_API ? { ...init, credentials: "include" } : init;
}
