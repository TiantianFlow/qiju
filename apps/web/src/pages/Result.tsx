import type { MatchView, Strings } from "../types";
import { t } from "../i18n";

export function ResultPage({
  strings,
  view,
  onRestart,
}: {
  strings: Strings;
  view: MatchView;
  onRestart: () => void;
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
          <p>
            {t(strings, "result.buyer")}: <strong>{acq.buyerSeatId}</strong> (
            {t(strings, labelKey)})
          </p>
          <p>
            {t(strings, "result.winningBid")}: <strong>{acq.winningBid}</strong>
          </p>
          <p>
            {t(strings, "result.actualValue")}: <strong>{actualValue}</strong>
          </p>
        </section>
      ) : (
        <p data-testid="result-nosale">{t(strings, "result.noSale")}</p>
      )}
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
                <td>{entry.realizedProfit}</td>
                <td>{entry.bonusReward}</td>
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
                  <td key={s}>{reveal.bids[s] ?? "—"}</td>
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
