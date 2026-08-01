import { useEffect, useMemo, useState } from "react";
import type { LotBoard, RevealedObject, Strings } from "../types";
import { t } from "../i18n";

const TIER_CLASS: Record<string, string> = {
  documented: "tier-documented",
  scarce: "tier-scarce",
  exceptional: "tier-exceptional",
  singular: "tier-singular",
};

const TIER_MARK: Record<string, string> = {
  documented: "●",
  scarce: "◆",
  exceptional: "▲",
  singular: "★",
};

export function LotBoardView({
  strings,
  board,
  focusRevealId,
  onFocusHandled,
}: {
  strings: Strings;
  board: LotBoard;
  focusRevealId?: string | undefined;
  onFocusHandled?: (() => void) | undefined;
}) {
  const [recentlyRevealed, setRecentlyRevealed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(focusRevealId ?? null);

  const objectsById = useMemo(() => {
    const map = new Map<string, RevealedObject>();
    for (const obj of board.revealedObjects) map.set(obj.revealId, obj);
    return map;
  }, [board.revealedObjects]);

  const prevIds = useMemo(() => new Set(board.revealedObjects.map((o) => o.revealId)), [board.revealedObjects]);

  const [seen, setSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const fresh = new Set<string>();
    for (const id of prevIds) {
      if (!seen.has(id)) fresh.add(id);
    }
    setSeen(new Set(prevIds));
    if (fresh.size > 0) {
      setRecentlyRevealed(fresh);
      const timer = setTimeout(() => setRecentlyRevealed(new Set()), 1800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [prevIds]);

  useEffect(() => {
    if (focusRevealId !== undefined) {
      setFocused(focusRevealId);
      onFocusHandled?.();
    }
  }, [focusRevealId, onFocusHandled]);

  const cellInfo = useMemo(() => {
    const map = new Map<number, { objectId: string; isAnchor: boolean }>();
    for (const obj of board.revealedObjects) {
      if (obj.cells) {
        for (const c of obj.cells) {
          map.set(c.y * board.width + c.x, { objectId: obj.revealId, isAnchor: false });
        }
      }
      if (obj.anchor) {
        map.set(obj.anchor.y * board.width + obj.anchor.x, { objectId: obj.revealId, isAnchor: true });
      }
    }
    return map;
  }, [board.revealedObjects, board.width]);

  const focusedObject = focused ? objectsById.get(focused) : undefined;

  return (
    <div className="lot-board-wrap">
      <div
        className="lot-board"
        role="grid"
        aria-label={t(strings, "board.ariaLabel")}
        data-testid="lot-board"
        style={{ "--board-w": board.width, "--board-h": board.height } as React.CSSProperties}
      >
        {Array.from({ length: board.width * board.height }, (_, i) => {
          const x = i % board.width;
          const y = Math.floor(i / board.width);
          const info = cellInfo.get(i);
          const obj = info ? objectsById.get(info.objectId) : undefined;
          const classes = ["board-cell", "concealed"];
          if (obj) {
            classes.push("revealed");
            if (obj.cells) classes.push("shape-known");
            if (obj.tier) classes.push(TIER_CLASS[obj.tier] ?? "");
            if (obj.identity) classes.push("identity-known");
            if (recentlyRevealed.has(obj.revealId)) classes.push("flash");
            if (focused === obj.revealId) classes.push("focused");
          }
          return (
            <div
              key={`${x},${y}`}
              role="gridcell"
              aria-label={
                obj
                  ? t(strings, "board.cell.revealed", { detail: describeObject(strings, obj) })
                  : t(strings, "board.cell.concealed")
              }
              className={classes.join(" ")}
              data-testid={`cell-${x}-${y}`}
              onClick={obj ? () => setFocused(obj.revealId) : undefined}
            >
              {obj && info?.isAnchor && obj.tier ? (
                <span className="tier-mark" aria-hidden="true">
                  {TIER_MARK[obj.tier] ?? "?"}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {focusedObject ? (
        <aside className="object-detail" data-testid="object-detail" aria-live="polite">
          <header>
            <strong>
              {focusedObject.identity
                ? t(strings, `item.${focusedObject.identity}.name`)
                : t(strings, "board.unidentified")}
            </strong>
            <button onClick={() => setFocused(null)} aria-label={t(strings, "board.closeDetail")}>
              ×
            </button>
          </header>
          <dl>
            {focusedObject.tier ? (
              <>
                <dt>{t(strings, "intel.field.tier")}</dt>
                <dd>{t(strings, `tier.${focusedObject.tier}`)}</dd>
              </>
            ) : null}
            {focusedObject.category ? (
              <>
                <dt>{t(strings, "intel.field.category")}</dt>
                <dd>{t(strings, `category.${focusedObject.category}`)}</dd>
              </>
            ) : null}
            {focusedObject.exactValue !== undefined ? (
              <>
                <dt>{t(strings, "intel.field.value")}</dt>
                <dd>{focusedObject.exactValue}</dd>
              </>
            ) : focusedObject.candidateSummary ? (
              <>
                <dt>{t(strings, "table.catalogRange")}</dt>
                <dd>
                  {t(strings, "table.candidates", {
                    count: focusedObject.candidateSummary.candidateIds.length,
                  })}{" "}
                  {t(strings, "table.valueRange", {
                    min: focusedObject.candidateSummary.minValue,
                    max: focusedObject.candidateSummary.maxValue,
                  })}
                </dd>
              </>
            ) : null}
          </dl>
        </aside>
      ) : null}
      {board.aggregateFacts.length > 0 ? (
        <ul className="aggregate-facts" aria-label={t(strings, "board.aggregates")}>
          {board.aggregateFacts.map((fact, i) => (
            <li key={`${fact.dimension}-${fact.key}-${fact.round}-${i}`}>
              {fact.metric === "count" && fact.dimension === "tier"
                ? t(strings, "intel.aggregate.countTier", {
                    key: t(strings, `tier.${fact.key}`),
                    value: fact.value,
                  })
                : fact.metric === "count"
                  ? t(strings, "intel.aggregate.count", {
                      key: t(strings, `category.${fact.key}`),
                      value: fact.value,
                    })
                  : t(strings, "intel.aggregate.mean", {
                      key: t(strings, `category.${fact.key}`),
                      value: fact.value,
                    })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function describeObject(strings: Strings, obj: RevealedObject): string {
  const parts: string[] = [];
  if (obj.identity) parts.push(t(strings, `item.${obj.identity}.name`));
  else if (obj.tier) parts.push(t(strings, `tier.${obj.tier}`));
  else if (obj.cells) parts.push(t(strings, "board.shapeOnly"));
  else if (obj.exactValue !== undefined) parts.push(String(obj.exactValue));
  return parts.join(" ") || t(strings, "board.unidentified");
}
