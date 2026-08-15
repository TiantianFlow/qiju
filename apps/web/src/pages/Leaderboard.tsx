import { useCallback, useEffect, useState } from "react";
import type { Locale, Strings } from "../types";
import { t } from "../i18n";
import { formatNumber } from "../format";
import { fetchLeaderboard, type LeaderboardPage as Page } from "../auth";

const PAGE_SIZE = 50;

/**
 * THE-58 leaderboard page: offset pagination, isSelf highlighting, Tycoon
 * tier column. Server rounds nothing for display — full-precision values
 * are formatted here. Flag-off (404) renders a quiet unavailable state,
 * never console noise or a broken table.
 */
export function LeaderboardPage({
  strings,
  locale,
  offset,
  onOffset,
  onNavigate,
}: {
  strings: Strings;
  locale: Locale;
  offset: number;
  onOffset: (offset: number) => void;
  onNavigate: (path: string) => void;
}) {
  const [page, setPage] = useState<Page | null | "error">(null);

  const load = useCallback(async (at: number) => {
    const result = await fetchLeaderboard(at, PAGE_SIZE);
    setPage(result ?? "error");
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  return (
    <main className="leaderboard" data-testid="leaderboard-page">
      <header className="page-bar">
        <button type="button" className="link" onClick={() => onNavigate("/")} data-testid="leaderboard-back-home">
          {t(strings, "leaderboard.backHome")}
        </button>
        <h1>{t(strings, "leaderboard.title")}</h1>
        <button type="button" className="link" onClick={() => onNavigate("/account")} data-testid="leaderboard-account-link">
          {t(strings, "leaderboard.accountLink")}
        </button>
      </header>

      {page === "error" ? (
        <p className="muted" role="status" data-testid="leaderboard-unavailable">
          {t(strings, "leaderboard.unavailable")}
        </p>
      ) : page === null ? (
        <p className="muted">{t(strings, "common.loading")}</p>
      ) : (
        <>
          {page.entries.length === 0 ? (
            <p className="muted" data-testid="leaderboard-empty">
              {t(strings, "leaderboard.empty")}
            </p>
          ) : (
            <div className="leaderboard-scroll" data-testid="leaderboard-scroll">
              <table className="leaderboard-table" data-testid="leaderboard-table">
                <thead>
                  <tr>
                    <th scope="col">{t(strings, "leaderboard.col.rank")}</th>
                    <th scope="col">{t(strings, "leaderboard.col.player")}</th>
                    <th scope="col">{t(strings, "leaderboard.col.rating")}</th>
                    <th scope="col">{t(strings, "leaderboard.col.matches")}</th>
                    <th scope="col">{t(strings, "leaderboard.col.profit")}</th>
                    <th scope="col">{t(strings, "leaderboard.col.tier")}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.entries.map((entry) => (
                    <tr
                      key={entry.rank}
                      className={entry.isSelf ? "is-self" : undefined}
                      data-testid={`leaderboard-row-${entry.rank}`}
                    >
                      <td className="col-rank">{formatNumber(entry.rank, locale)}</td>
                      <td className="col-player">
                        {entry.playerLabel}
                        {entry.isSelf ? (
                          <span className="self-badge" data-testid="leaderboard-self-badge">
                            {t(strings, "leaderboard.self")}
                          </span>
                        ) : null}
                      </td>
                      <td className="col-num">
                        {formatNumber(Math.round(entry.appraiserRating), locale)}
                      </td>
                      <td className="col-num">{formatNumber(entry.matchesPlayed, locale)}</td>
                      <td className="col-num">
                        {formatNumber(Math.round(entry.cumulativeRealizedProfit), locale)}
                      </td>
                      <td>{entry.tycoonTier}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="leaderboard-pager" data-testid="leaderboard-pager">
            <button
              disabled={offset <= 0}
              onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
              data-testid="leaderboard-prev"
            >
              {t(strings, "leaderboard.prev")}
            </button>
            <span className="leaderboard-page-status" data-testid="leaderboard-page-status">
              {t(strings, "leaderboard.pageStatus", {
                from: page.entries.length > 0 ? offset + 1 : 0,
                to: offset + page.entries.length,
                total: page.total,
              })}
            </span>
            <button
              disabled={page.nextOffset === null}
              onClick={() => page.nextOffset !== null && onOffset(page.nextOffset)}
              data-testid="leaderboard-next"
            >
              {t(strings, "leaderboard.next")}
            </button>
            <button onClick={() => void load(offset)} data-testid="leaderboard-refresh">
              {t(strings, "leaderboard.refresh")}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
