import { useState } from "react";
import type { Locale, Strings } from "../types";
import { persistLocale, t } from "../i18n";
import { API_BASE_URL, withApiCredentials } from "../config";
import type { MeResponse } from "../auth";

export function HomePage({
  strings,
  locale,
  onLocale,
  onCreated,
  allowFixedSeed,
  productName,
  me,
  onNavigate,
}: {
  strings: Strings;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onCreated: (matchId: string, mode: "human-vs-ai" | "all-ai", seed: string) => void;
  allowFixedSeed: boolean;
  productName: { "zh-CN": string; en: string };
  me: MeResponse | null;
  onNavigate: (path: string) => void;
}) {
  const [seed, setSeed] = useState("");
  const [showSeed, setShowSeed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (mode: "human-vs-ai" | "all-ai") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/demo-matches`,
        withApiCredentials({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, ...(seed ? { seed } : {}) }),
        }),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { matchId: string; seed: string };
      onCreated(data.matchId, mode, data.seed);
    } catch {
      setError("error.fatal");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <h1>{productName[locale]}</h1>
      <p className="tagline">{t(strings, "app.tagline")}</p>
      {error ? <p role="alert">{t(strings, error)}</p> : null}
      <div className="home-actions">
        <button disabled={busy} onClick={() => void create("human-vs-ai")} data-testid="play-vs-ai">
          {t(strings, "home.playVsAi")}
        </button>
        <button disabled={busy} onClick={() => void create("all-ai")} data-testid="watch-demo">
          {t(strings, "home.watchDemo")}
        </button>
      </div>
      {allowFixedSeed ? (
        <div className="seed-row">
          <button type="button" className="link" onClick={() => setShowSeed((v) => !v)}>
            {t(strings, "home.seedOptional")}
          </button>
          {showSeed ? (
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="seed"
              aria-label={t(strings, "home.seedOptional")}
              data-testid="seed-input"
            />
          ) : null}
        </div>
      ) : null}
      <div className="locale-row">
        <label htmlFor="locale-select">{t(strings, "home.language")}</label>
        <select
          id="locale-select"
          value={locale}
          onChange={(e) => {
            const next = e.target.value as Locale;
            persistLocale(next);
            onLocale(next);
          }}
          data-testid="locale-select"
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </div>
      {/*
       * THE-58: account entry. Deliberately quiet while the feature is dark:
       * /api/v1/me 404s, `me` stays null, and this row is hidden entirely —
       * no dead buttons for a feature that is not on.
       */}
      {me ? (
        <div className="account-row" data-testid="home-account-row">
          <button
            type="button"
            className="link"
            onClick={() => onNavigate("/account")}
            data-testid="home-account-link"
          >
            {me.principal === "account"
              ? `${t(strings, "account.title")} · ${me.playerLabel ?? ""}`
              : t(strings, "account.signInGoogle")}
          </button>
          <button
            type="button"
            className="link"
            onClick={() => onNavigate("/leaderboard")}
            data-testid="home-leaderboard-link"
          >
            {t(strings, "leaderboard.title")}
          </button>
        </div>
      ) : null}
      <p className="app-version" data-testid="app-version">v{__APP_VERSION__}</p>
    </main>
  );
}
