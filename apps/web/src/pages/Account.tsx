import { useState } from "react";
import type { Locale, Strings } from "../types";
import { t } from "../i18n";
import { formatNumber } from "../format";
import { API_BASE_URL, withApiCredentials } from "../config";
import { startOAuthSignIn, type AuthOutcome, type MeResponse } from "../auth";

interface Career {
  matchesPlayed: number;
  totalFinalWealth: number;
  totalRealizedProfit: number;
  totalBonusReward: number;
  bestDenseEconomicRank: number | null;
  averageFinalWealth: number;
}

/**
 * THE-58 account page: session status from /api/v1/me, OAuth start, the
 * six callback outcomes (one-shot via the App), and the caller's career
 * aggregates. Identity shown is the server's playerLabel — never a raw
 * UUID, never a provider name.
 *
 * Feature-flag-off behavior: `me` is null (404), so status/career quietly
 * render "none"/hidden and the sign-in button fails silently on its 404
 * with a retryable notice — no console noise, no dead-end layout.
 */
export function AccountPage({
  strings,
  locale,
  me,
  outcome,
  onNavigate,
  onOutcomeConsumed,
}: {
  strings: Strings;
  locale: Locale;
  me: MeResponse | null;
  outcome: AuthOutcome | null;
  onNavigate: (path: string) => void;
  onOutcomeConsumed: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [career, setCareer] = useState<Career | null | "error">(null);
  const [careerRequested, setCareerRequested] = useState(false);

  const showSignIn = me?.principal !== "account";

  const signIn = async () => {
    setStarting(true);
    setStartFailed(false);
    const ok = await startOAuthSignIn("/account");
    // On success the browser navigates away; a resolved promise with false
    // means the start was refused (e.g. flag off) — stay put, say so.
    if (!ok) {
      setStarting(false);
      setStartFailed(true);
    }
  };

  // Lazy career load: only when the page is shown and a session exists.
  // me=account and me=guest both have a cookie; "none"/null do not (or the
  // endpoint 404s while dark — then career must not even be attempted).
  if (me && me.principal !== "none" && !careerRequested) {
    setCareerRequested(true);
    void (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/me/career`, withApiCredentials());
        if (!res.ok) {
          setCareer("error");
          return;
        }
        setCareer((await res.json()) as Career);
      } catch {
        setCareer("error");
      }
    })();
  }

  return (
    <main className="account" data-testid="account-page">
      <header className="page-bar">
        <button type="button" className="link" onClick={() => onNavigate("/")} data-testid="account-back-home">
          {t(strings, "account.backHome")}
        </button>
        <h1>{t(strings, "account.title")}</h1>
      </header>

      {outcome ? (
        <div
          className={`auth-notice auth-outcome-${outcome}`}
          role={outcome === "conflict" || outcome === "failed" ? "alert" : "status"}
          data-testid={`auth-outcome-${outcome}`}
        >
          <p>{t(strings, `account.auth.${outcome}`)}</p>
          <button type="button" className="link" onClick={onOutcomeConsumed} data-testid="auth-outcome-dismiss">
            ×
          </button>
        </div>
      ) : null}

      <section className="account-status" data-testid="account-status">
        <p className="account-principal" data-testid="account-principal">
          {t(strings, `account.status.${me?.principal ?? "none"}`)}
        </p>
        {me?.playerLabel ? (
          <p className="account-label" data-testid="account-player-label">
            {t(strings, "account.playerLabel", { label: me.playerLabel })}
          </p>
        ) : null}
        {showSignIn ? (
          <div className="account-signin">
            <button
              disabled={starting}
              onClick={() => void signIn()}
              data-testid="sign-in-google"
            >
              {t(strings, "account.signInGoogle")}
            </button>
            <p className="account-signin-hint">
              {t(
                strings,
                me?.principal === "guest" ? "account.signInHint.guest" : "account.signInHint.none",
              )}
            </p>
            {startFailed ? (
              <p className="error" role="alert" data-testid="sign-in-start-failed">
                {t(strings, "account.signInStartFailed")}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {me && me.principal !== "none" ? (
        <section className="account-career" data-testid="account-career">
          <h2>{t(strings, "account.career.title")}</h2>
          {career === "error" ? (
            <p className="muted" data-testid="career-unavailable">
              {t(strings, "account.career.unavailable")}
            </p>
          ) : career ? (
            <dl className="career-grid" data-testid="career-stats">
              <dt>{t(strings, "account.career.matchesPlayed")}</dt>
              <dd data-testid="career-matches">{formatNumber(career.matchesPlayed, locale)}</dd>
              <dt>{t(strings, "account.career.totalRealizedProfit")}</dt>
              <dd data-testid="career-profit">{formatNumber(career.totalRealizedProfit, locale)}</dd>
              <dt>{t(strings, "account.career.totalFinalWealth")}</dt>
              <dd>{formatNumber(career.totalFinalWealth, locale)}</dd>
              <dt>{t(strings, "account.career.totalBonusReward")}</dt>
              <dd>{formatNumber(career.totalBonusReward, locale)}</dd>
            </dl>
          ) : (
            <p className="muted">{t(strings, "common.loading")}</p>
          )}
          {me.principal === "guest" ? (
            <p className="account-signin-hint">{t(strings, "account.career.guestHint")}</p>
          ) : null}
        </section>
      ) : null}

      <p className="account-links">
        <button
          type="button"
          className="link"
          onClick={() => onNavigate("/leaderboard")}
          data-testid="account-leaderboard-link"
        >
          {t(strings, "account.leaderboardLink")}
        </button>
      </p>
    </main>
  );
}
