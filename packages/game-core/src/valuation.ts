import type { CompiledRuleRuntime, MatchState } from "./state.js";
import type { ItemDef, SlotId, TierId } from "./types.js";
import { parseRectangularShapeId } from "./types.js";

function footprintCells(item: ItemDef): number {
  if (item.footprint) return item.footprint.width * item.footprint.height;
  const rect = parseRectangularShapeId(item.shapeId);
  if (rect) return rect.width * rect.height;
  return 1;
}

/** Lowest catalog value among items of the given tier. */
export function tierFloor(runtime: CompiledRuleRuntime, tier: TierId): number {
  let min = Number.POSITIVE_INFINITY;
  for (const item of runtime.catalogSorted) {
    if (item.tier === tier) min = Math.min(min, item.value);
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Per-cell scrap floor: minimum catalog value divided by that item's footprint cells.
 * Used for shape-known / fully unknown cell contributions.
 */
export function cellFloor(runtime: CompiledRuleRuntime): number {
  let min = Number.POSITIVE_INFINITY;
  for (const item of runtime.catalogSorted) {
    const cells = Math.max(1, footprintCells(item));
    min = Math.min(min, Math.floor(item.value / cells));
  }
  return Number.isFinite(min) ? min : 0;
}

type KnowledgeMap = Map<SlotId, Partial<Record<string, unknown>>>;

/**
 * Conservative lower-bound lot estimate from legally visible knowledge only.
 *
 * estimatedValue =
 *   Σ Identified V_i
 * + Σ TierKnownOnly TierFloor(T_j)
 * + Σ ShapeKnownOnly (cells × CellFloor)
 *
 * Fully unknown cells contribute 0 (community-allowed; avoids double-counting
 * when tier is known without footprint).
 */
export function estimateConservativeValue(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  knowledge: KnowledgeMap,
): number {
  const lot = state.lot;
  if (!lot) return 0;

  const board = lot.board;
  const placementBySlot = new Map(board?.placements.map((p) => [p.slotId, p]) ?? []);
  const scrap = cellFloor(runtime);
  const completed = state.phase.kind === "completed";

  let total = 0;

  for (const slot of lot.slots) {
    const fields = knowledge.get(slot.slotId) ?? {};
    const placement = placementBySlot.get(slot.slotId);
    const cellCount = placement?.cells.length ?? 0;
    const item = runtime.catalog.get(slot.itemId);

    if (completed) {
      total += item?.value ?? 0;
      continue;
    }

    const identityKnown = fields.identity !== undefined;
    const valueKnown = fields.value !== undefined;
    const tierKnown = fields.tier !== undefined || identityKnown;
    const shapeKnown = fields.shape !== undefined || identityKnown;

    if (identityKnown || valueKnown) {
      if (valueKnown) total += fields.value as number;
      else {
        const id = fields.identity as ItemDef["id"];
        total += runtime.catalog.get(id)?.value ?? item?.value ?? 0;
      }
      continue;
    }

    if (tierKnown) {
      const floor = tierFloor(runtime, fields.tier as TierId);
      // Keep monotonicity vs a prior shape-only contribution on the same object.
      total += shapeKnown && cellCount > 0 ? Math.max(floor, cellCount * scrap) : floor;
      continue;
    }

    if (shapeKnown && cellCount > 0) {
      total += cellCount * scrap;
    }
  }

  return total;
}

