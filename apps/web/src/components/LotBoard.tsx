import { useEffect, useMemo, useRef, useState } from "react";
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

interface PlacedObject {
  object: RevealedObject;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorOnly: boolean;
}

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
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const objectsById = useMemo(() => {
    const map = new Map<string, RevealedObject>();
    for (const obj of board.revealedObjects) map.set(obj.revealId, obj);
    return map;
  }, [board.revealedObjects]);

  const placed = useMemo<PlacedObject[]>(() => {
    const out: PlacedObject[] = [];
    for (const obj of board.revealedObjects) {
      if (obj.cells && obj.cells.length > 0) {
        const xs = obj.cells.map((c) => c.x);
        const ys = obj.cells.map((c) => c.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        out.push({
          object: obj,
          x: minX,
          y: minY,
          width: Math.max(...xs) - minX + 1,
          height: Math.max(...ys) - minY + 1,
          anchorOnly: false,
        });
      } else if (obj.anchor) {
        out.push({ object: obj, x: obj.anchor.x, y: obj.anchor.y, width: 1, height: 1, anchorOnly: true });
      }
    }
    return out;
  }, [board.revealedObjects]);

  const currentIds = useMemo(() => new Set(board.revealedObjects.map((o) => o.revealId)), [board.revealedObjects]);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const fresh = new Set<string>();
    for (const id of currentIds) {
      if (!seen.has(id)) fresh.add(id);
    }
    setSeen(new Set(currentIds));
    if (fresh.size > 0) {
      setRecentlyRevealed(fresh);
      const timer = setTimeout(() => setRecentlyRevealed(new Set()), 1800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [currentIds]);

  useEffect(() => {
    if (focusRevealId !== undefined) {
      setFocused(focusRevealId);
      cardRefs.current.get(focusRevealId)?.focus();
      onFocusHandled?.();
    }
  }, [focusRevealId, onFocusHandled]);

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
        {Array.from({ length: board.width * board.height }, (_, i) => (
          <div
            key={i}
            className="board-cell concealed"
            aria-hidden="true"
            data-testid={`bg-${i % board.width}-${Math.floor(i / board.width)}`}
          />
        ))}
        {placed.map(({ object, x, y, width, height, anchorOnly }) => {
          const classes = ["object-card"];
          if (anchorOnly) classes.push("anchor-only");
          if (object.tier) classes.push(TIER_CLASS[object.tier] ?? "");
          if (object.identity) classes.push("identity-known");
          if (recentlyRevealed.has(object.revealId)) classes.push("flash");
          if (focused === object.revealId) classes.push("focused");
          return (
            <button
              key={object.revealId}
              ref={(el) => {
                if (el) cardRefs.current.set(object.revealId, el);
                else cardRefs.current.delete(object.revealId);
              }}
              type="button"
              role="gridcell"
              className={classes.join(" ")}
              style={
                {
                  gridColumn: `${x + 1} / span ${width}`,
                  gridRow: `${y + 1} / span ${height}`,
                  "--obj-w": width,
                  "--obj-h": height,
                } as React.CSSProperties
              }
              aria-label={t(strings, "board.cell.revealed", { detail: describeObject(strings, object) })}
              data-testid={`object-${object.revealId}`}
              data-width={anchorOnly ? undefined : width}
              data-height={anchorOnly ? undefined : height}
              onClick={() => setFocused(object.revealId)}
            >
              {object.tier ? (
                <span className="tier-mark" aria-hidden="true">
                  {TIER_MARK[object.tier] ?? "?"}
                </span>
              ) : null}
              {object.category && !object.identity && !object.tier ? (
                <span className="object-category">{t(strings, `category.${object.category}`)}</span>
              ) : null}
              {object.identity ? (
                <span className="object-name">{t(strings, `item.${object.identity}.name`)}</span>
              ) : null}
              {object.exactValue !== undefined && !object.identity ? (
                <span className="object-value">{object.exactValue}</span>
              ) : null}
            </button>
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
            <button
              onClick={() => {
                const returnId = focusedObject.revealId;
                setFocused(null);
                requestAnimationFrame(() => {
                  cardRefs.current.get(returnId)?.focus();
                });
              }}
              aria-label={t(strings, "board.closeDetail")}
            >
              ×
            </button>
          </header>
          <dl>
            {focusedObject.cells ? (
              <>
                <dt>{t(strings, "board.dimensions")}</dt>
                <dd>
                  {rectOf(focusedObject.cells).width} × {rectOf(focusedObject.cells).height}
                </dd>
              </>
            ) : null}
            <dt>{t(strings, "intel.field.tier")}</dt>
            <dd>{focusedObject.tier ? t(strings, `tier.${focusedObject.tier}`) : t(strings, "board.unknown")}</dd>
            <dt>{t(strings, "intel.field.category")}</dt>
            <dd>
              {focusedObject.category
                ? t(strings, `category.${focusedObject.category}`)
                : t(strings, "board.unknown")}
            </dd>
            <dt>{t(strings, "intel.field.value")}</dt>
            <dd>
              {focusedObject.exactValue !== undefined
                ? focusedObject.exactValue
                : focusedObject.candidateSummary
                  ? t(strings, "table.valueRange", {
                      min: focusedObject.candidateSummary.minValue,
                      max: focusedObject.candidateSummary.maxValue,
                    })
                  : t(strings, "board.unknown")}
            </dd>
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

function rectOf(cells: Array<{ x: number; y: number }>): { width: number; height: number } {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  return { width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 };
}

function describeObject(strings: Strings, obj: RevealedObject): string {
  const parts: string[] = [];
  if (obj.identity) parts.push(t(strings, `item.${obj.identity}.name`));
  else if (obj.tier) parts.push(t(strings, `tier.${obj.tier}`));
  else if (obj.category) parts.push(t(strings, `category.${obj.category}`));
  else if (obj.cells) parts.push(t(strings, "board.shapeOnly"));
  else if (obj.exactValue !== undefined) parts.push(String(obj.exactValue));
  return parts.join(" ") || t(strings, "board.unidentified");
}
