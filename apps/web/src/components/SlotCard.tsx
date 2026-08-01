import type { Strings } from "../types";
import { t } from "../i18n";

const SHAPES: Record<string, Array<[number, number]>> = {
  single: [[0, 0]],
  domino_h: [
    [0, 0],
    [1, 0],
  ],
  domino_v: [
    [0, 0],
    [0, 1],
  ],
  line3: [
    [0, 0],
    [1, 0],
    [2, 0],
  ],
  corner3: [
    [0, 0],
    [0, 1],
    [1, 1],
  ],
  square4: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  corner4: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
  ],
  rect6: [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
};

export function ShapeGlyph({ shapeId, size = 30 }: { shapeId: string; size?: number }) {
  const cells = SHAPES[shapeId] ?? [];
  const cell = size / 3;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={shapeId} role="img">
      {cells.map(([x, y]) => (
        <rect
          key={`${x},${y}`}
          x={(x ?? 0) * cell + 1}
          y={(y ?? 0) * cell + 1}
          width={cell - 2}
          height={cell - 2}
          rx={2}
          className="shape-cell"
        />
      ))}
    </svg>
  );
}

export function SlotCard({
  strings,
  slot,
}: {
  strings: Strings;
  slot: {
    slotId: string;
    knownFields: Partial<{ tier: string; category: string; shape: string; identity: string; value: number }>;
    candidates: { candidateIds: string[]; minValue: number; maxValue: number; unweightedMeanValueFloor: number };
  };
}) {
  const k = slot.knownFields;
  return (
    <div className="slot-card" data-testid={`slot-${slot.slotId}`}>
      <div className="slot-head">
        <strong>{slot.slotId}</strong>
        {k.shape ? <ShapeGlyph shapeId={k.shape} /> : <span className="unknown-shape">?</span>}
      </div>
      <dl className="slot-fields">
        {k.identity !== undefined ? (
          <>
            <dt>{t(strings, "intel.field.identity")}</dt>
            <dd>{t(strings, `item.${k.identity}.name`)}</dd>
          </>
        ) : null}
        {k.tier !== undefined && k.identity === undefined ? (
          <>
            <dt>{t(strings, "intel.field.tier")}</dt>
            <dd>{t(strings, `tier.${k.tier}`)}</dd>
          </>
        ) : null}
        {k.category !== undefined && k.identity === undefined ? (
          <>
            <dt>{t(strings, "intel.field.category")}</dt>
            <dd>{t(strings, `category.${k.category}`)}</dd>
          </>
        ) : null}
        {k.value !== undefined && k.identity === undefined ? (
          <>
            <dt>{t(strings, "intel.field.value")}</dt>
            <dd>{k.value}</dd>
          </>
        ) : null}
      </dl>
      {k.identity === undefined ? (
        <div className="slot-candidates" title={t(strings, "table.catalogRange")}>
          <span>{t(strings, "table.candidates", { count: slot.candidates.candidateIds.length })}</span>
          <span>{t(strings, "table.valueRange", { min: slot.candidates.minValue, max: slot.candidates.maxValue })}</span>
        </div>
      ) : (
        <div className="slot-candidates">
          <span>{k.value}</span>
        </div>
      )}
    </div>
  );
}
