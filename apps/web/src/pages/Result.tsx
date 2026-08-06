import type { CatalogItem, Locale, MatchView, Strings } from "../types";
import { t } from "../i18n";
import { formatNumber } from "../format";
import { LotBoardView } from "../components/LotBoard";

export function ResultPage({
  strings,
  locale,
  view,
  onRestart,
  catalog,
}: {
  strings: Strings;
  locale: Locale;
  view: MatchView;
  onRestart: () => void;
  catalog?: CatalogItem[];
}) {
  const result = view.result;
  if (!result) return null;
  const acq = result.acquisition;
  const actualValue = acq.buyerSeatId
    ? result.economic.find((e) => e.seatId === acq.buyerSeatId)!.finalWealth -
      view.startingBudget +
      (acq.winningBid ?? 0)
    : 0;
  const buyerProfit = acq.buyerSeatId
    ? result.economic.find((e) => e.seatId === acq.buyerSeatId)!.realizedProfit
    : 0;
  const labelKey =
    buyerProfit > 0
      ? "result.label.bargain"
      : buyerProfit < 0
        ? "result.label.overbid"
        : "result.label.fair";

  return (
    <main className="result">
      <h2>{t(strings, "result.title")}</h2>
      {acq.buyerSeatId ? (
        <section className="result-summary" data-testid="result-summary">
          <p data-testid="result-sold">
            {t(strings, "result.buyer")}: <strong data-testid="result-buyer">{acq.buyerSeatId}</strong> (
            {t(strings, labelKey)})
          </p>
          <p>
            {t(strings, "result.winningBid")}:{" "}
            <strong data-testid="result-winning-bid">{formatNumber(acq.winningBid ?? 0, locale)}</strong>
          </p>
          <p>
            {t(strings, "result.actualValue")}: <strong>{formatNumber(actualValue, locale)}</strong>
          </p>
        </section>
      ) : (
        <p data-testid="result-nosale">{t(strings, "result.noSale")}</p>
      )}
      {view.board ? (
        <section data-testid="result-board">
          <h3>{t(strings, "result.lotBoard")}</h3>
          <LotBoardView strings={strings} locale={locale} board={view.board} catalog={catalog} />
        </section>
      ) : null}
      <section>
        <h3>{t(strings, "result.economic")}</h3>
        <table>
          <thead>
            <tr>
              <th></th>
              <th>{t(strings, "result.profit")}</th>
              <th>{t(strings, "result.bonus")}</th>
              <th>{t(strings, "result.rank")}</th>
            </tr>
          </thead>
          <tbody>
            {result.economic.map((entry) => (
              <tr key={entry.seatId} data-testid={`result-${entry.seatId}`}>
                <td>
                  {entry.seatId}
                  {view.mySeat && entry.seatId === view.mySeat.seatId ? ` (${t(strings, "table.you")})` : ""}
                </td>
                <td>{formatNumber(entry.realizedProfit, locale)}</td>
                <td>{formatNumber(entry.bonusReward, locale)}</td>
                <td>{entry.denseEconomicRank}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="history">
        <h4>{t(strings, "table.history")}</h4>
        <table>
          <tbody>
            {view.reveals.map((reveal) => (
              <tr key={`${reveal.kind}-${reveal.round}`}>
                <td>{reveal.kind === "tiebreak" ? "TB" : reveal.round}</td>
                {["seat1", "seat2", "seat3", "seat4"].map((s) => (
                  <td key={s}>{reveal.bids[s] !== undefined ? formatNumber(reveal.bids[s], locale) : "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <button onClick={onRestart} data-testid="restart">
        {t(strings, "result.restart")}
      </button>
    </main>
  );
}
