import { useState } from "react";
import type { IntelRecordView, MatchView, PublicEvent, Strings } from "../types";
import type { MatchConnection } from "../connection";
import { t } from "../i18n";
import { SlotCard } from "../components/SlotCard";
import { LotBoardView } from "../components/LotBoard";
import { useCountdown } from "../hooks";

function formatEventDescription(strings: Strings, event: PublicEvent): string {
  const params: Record<string, string | number> = { ...event.params };
  if (typeof params.tier === "string") params.tier = t(strings, `tier.${params.tier}`);
  if (typeof params.category === "string") params.category = t(strings, `category.${params.category}`);
  if (event.localizationKey.startsWith("event.intel.aggregate.")) {
    if (typeof params.key === "string") {
      const prefix = event.localizationKey === "event.intel.aggregate.countTier" ? "tier" : "category";
      params.key = t(strings, `${prefix}.${params.key}`);
    }
  }
  return t(strings, event.localizationKey, params);
}

function EventFeed({
  strings,
  events,
  onFocusObject,
}: {
  strings: Strings;
  events: PublicEvent[];
  onFocusObject: (revealId: string) => void;
}) {
  if (events.length === 0) return null;
  return (
    <section className="event-feed" data-testid="event-feed" aria-label={t(strings, "event.feed.title")}>
      <h4>{t(strings, "event.feed.title")}</h4>
      <ol>
        {events.map((event) => (
          <li key={event.id} data-testid={`event-${event.id}`}>
            <span className="event-round">R{event.round}</span>
            <span className="event-source">{t(strings, `event.source.${event.sourceKind}`)}</span>
            {event.revealIds.length > 0 ? (
              <button className="event-link" onClick={() => onFocusObject(event.revealIds[0]!)}>
                {formatEventDescription(strings, event)}
              </button>
            ) : (
              <span className="event-text">{formatEventDescription(strings, event)}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function IntelList({
  strings,
  records,
  title,
  hideSlotIds,
}: {
  strings: Strings;
  records: IntelRecordView[];
  title: string;
  hideSlotIds?: boolean;
}) {
  if (records.length === 0) return null;
  return (
    <section className="intel-list">
      <h4>{title}</h4>
      <ul>
        {records.map((record, i) => (
          <li key={i}>{describeIntel(strings, record, hideSlotIds === true)}</li>
        ))}
      </ul>
    </section>
  );
}

function describeIntel(strings: Strings, record: IntelRecordView, hideSlotId: boolean): string {
  const fact = record.fact;
  if (fact.kind === "exhausted") return "…";
  if (fact.kind === "aggregate") {
    if (fact.metric === "count" && fact.dimension === "category") {
      return t(strings, "intel.aggregate.count", {
        key: t(strings, `category.${fact.key}`),
        value: fact.value,
      });
    }
    if (fact.metric === "count" && fact.dimension === "tier") {
      return t(strings, "intel.aggregate.countTier", {
        key: t(strings, `tier.${fact.key}`),
        value: fact.value,
      });
    }
    return t(strings, "intel.aggregate.mean", {
      key: t(strings, `category.${fact.key}`),
      value: fact.value,
    });
  }
  const slot = hideSlotId ? t(strings, "board.unidentified") : fact.slotId;
  switch (fact.field) {
    case "tier":
      return `${slot}: ${t(strings, "intel.field.tier")} = ${t(strings, `tier.${fact.tier}`)}`;
    case "category":
      return `${slot}: ${t(strings, "intel.field.category")} = ${t(strings, `category.${fact.category}`)}`;
    case "shape":
      return `${slot}: ${t(strings, "intel.field.shape")} = ${fact.shapeId}`;
    case "identity":
      return `${slot}: ${t(strings, `item.${fact.itemId}.name`)}`;
    case "value":
      return `${slot}: ${t(strings, "intel.field.value")} = ${fact.value}`;
    default:
      return slot;
  }
}

export function TablePage({
  strings,
  view,
  connection,
  isObserver,
  seed,
}: {
  strings: Strings;
  view: MatchView;
  connection: MatchConnection;
  isObserver: boolean;
  seed: string | null;
}) {
  const [bidInput, setBidInput] = useState("");
  const [focusRevealId, setFocusRevealId] = useState<string | undefined>(undefined);
  const remaining = useCountdown(connection.deadlineAtMs);
  const my = view.mySeat;
  const window = view.window;
  const legal = view.legalActions;
  const canBid =
    !isObserver &&
    window &&
    my &&
    !my.currentBidLocked &&
    legal?.actions.some((a) => a.kind === "submit_bid");
  const canLock =
    !isObserver && window && my?.currentBid !== undefined && !my.currentBidLocked;
  const toolAction = legal?.actions.find((a) => a.kind === "use_tool");

  const submitBid = (amount: number) => {
    if (!window) return;
    connection.sendCommand({ type: "submit_bid", amount, actionWindowId: window.actionWindowId });
  };

  return (
    <main className="table">
      <header className="table-head">
        <h2>
          {view.phase === "tiebreak"
            ? t(strings, "table.tiebreak")
            : t(strings, "table.round", { round: view.round })}
        </h2>
        {isObserver && connection.demo.presentation ? (
          <span className="presentation" data-testid="presentation">
            {t(strings, `presentation.${connection.demo.presentation.kind}`)}
          </span>
        ) : null}
        {remaining !== null ? (
          <span className="deadline" role="timer" data-testid="deadline">
            {t(strings, "table.deadline", { seconds: remaining })}
          </span>
        ) : null}
        {isObserver && seed ? (
          <span className="seed-display">
            {t(strings, "demo.seed")}: <code>{seed}</code>
          </span>
        ) : null}
      </header>

      {connection.lastRejection ? (
        <p role="alert" className="error">
          {connection.lastRejection}
        </p>
      ) : null}

      <section className="slots-grid">
        {view.board ? (
          <LotBoardView
            strings={strings}
            board={view.board}
            focusRevealId={focusRevealId}
            onFocusHandled={() => setFocusRevealId(undefined)}
          />
        ) : (
          view.slots.map((slot) => <SlotCard key={slot.slotId} strings={strings} slot={slot} />)
        )}
      </section>

      <div className="table-columns">
        <div>
          {view.publicEvents && view.publicEvents.length > 0 ? (
            <EventFeed
              strings={strings}
              events={view.publicEvents}
              onFocusObject={(id) => setFocusRevealId(id)}
            />
          ) : null}
          <IntelList
            strings={strings}
            records={view.publicIntel}
            title={t(strings, "intel.public.title")}
            hideSlotIds={view.board !== undefined}
          />
          {my ? (
            <IntelList
              strings={strings}
              records={my.privateIntel}
              title={t(strings, "intel.private.title")}
              hideSlotIds={view.board !== undefined}
            />
          ) : null}
        </div>

        {!isObserver && my ? (
          <section className="actions" aria-label="actions">
            {toolAction && toolAction.kind === "use_tool" && window ? (
              <div className="tool-row">
                {toolAction.toolIds?.map((toolId) => (
                  <button
                    key={toolId}
                    onClick={() =>
                      connection.sendCommand({
                        type: "use_tool",
                        toolId,
                        actionWindowId: window.actionWindowId,
                      })
                    }
                    data-testid={`tool-${toolId}`}
                  >
                    {t(strings, `${toolId}.name`)}
                  </button>
                ))}
              </div>
            ) : null}
            {canBid ? (
              <div className="bid-row">
                <label htmlFor="bid-input">{t(strings, "table.yourBid")}</label>
                <input
                  id="bid-input"
                  type="number"
                  min={0}
                  max={view.startingBudget}
                  value={bidInput}
                  onChange={(e) => setBidInput(e.target.value)}
                  data-testid="bid-input"
                />
                <button
                  onClick={() => submitBid(Math.max(0, Math.min(view.startingBudget, Number(bidInput) || 0)))}
                  data-testid="submit-bid"
                >
                  {t(strings, "table.submitBid")}
                </button>
                <button onClick={() => submitBid(0)} data-testid="pass-bid">
                  {t(strings, "table.pass")}
                </button>
              </div>
            ) : null}
            {my.currentBid !== undefined ? (
              <p className="current-bid">
                {t(strings, "table.yourBid")}: <strong>{my.currentBid}</strong>
              </p>
            ) : null}
            {canLock ? (
              <button
                onClick={() =>
                  window &&
                  connection.sendCommand({
                    type: "lock_bid",
                    actionWindowId: window.actionWindowId,
                  })
                }
                data-testid="lock-bid"
              >
                {t(strings, "table.lockBid")}
              </button>
            ) : null}
            {my.currentBidLocked ? <p>{t(strings, "table.waitingReveal")}</p> : null}
          </section>
        ) : null}
      </div>

      <section className="history">
        <h4>{t(strings, "table.history")}</h4>
        {view.reveals.length === 0 ? (
          <p>{t(strings, "table.noHistory")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                {["seat1", "seat2", "seat3", "seat4"].map((s) => (
                  <th key={s}>{s}</th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.reveals.map((reveal) => (
                <tr key={`${reveal.kind}-${reveal.round}`}>
                  <td>{reveal.kind === "tiebreak" ? "TB" : reveal.round}</td>
                  {["seat1", "seat2", "seat3", "seat4"].map((s) => (
                    <td key={s}>{reveal.bids[s] ?? "—"}</td>
                  ))}
                  <td>
                    {reveal.outcome === "sold"
                      ? t(strings, "reveal.sold", {
                          seat: reveal.buyerSeatId ?? "?",
                          amount: reveal.winningBid ?? 0,
                        })
                      : reveal.outcome === "continue"
                        ? t(strings, "reveal.continue")
                        : reveal.outcome === "tiebreak"
                          ? t(strings, "reveal.tiebreak")
                          : t(strings, "reveal.noSale")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
