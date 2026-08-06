import { estimateConservativeValue, estimateExpectedValue } from "./valuation.js";
import { canonicalHash } from "./prng-hash.js";
import { Xoshiro128StarStar, deriveStreamSeed } from "./prng.js";
import type {
  AggregateFactView,
  CandidateRange,
  CompiledRuleRuntime,
  DecisionWindowState,
  DomainEvent,
  EconomicResultEntry,
  GameCommand,
  IntelFactPayload,
  IntelRecord,
  IntelVisibility,
  LegalActionSet,
  LotBoardView,
  MatchResult,
  MatchState,
  PublicEventView,
  PublicIntelRecordView,
  PublicView,
  RequestedEffect,
  RevealedObjectView,
  RoundRevealRecord,
  SeatId,
  SeatObservation,
  SelectorRuntime,
  SlotPublicView,
  TransitionResult,
  TrainingUtilityEntry,
  WindowKind,
} from "./state.js";
import {
  CATEGORY_IDS,
  SEAT_IDS,
  TIER_IDS,
  type CategoryId,
  type GeneratedLot,
  type IntelFieldKind,
  type ItemDef,
  type ItemId,
  type LotPlacement,
  type ProfileId,
  type SlotId,
  type TierId,
} from "./types.js";

const MULTIPLIERS: ReadonlyArray<{ numerator: number; denominator: number }> = [
  { numerator: 2, denominator: 1 },
  { numerator: 8, denominator: 5 },
  { numerator: 13, denominator: 10 },
  { numerator: 11, denominator: 10 },
];

interface EngineRng {
  stream(path: string): Xoshiro128StarStar;
}

function createEngineRng(state: MatchState): EngineRng {
  return {
    stream(path: string): Xoshiro128StarStar {
      const existing = state.streams[path];
      if (existing) {
        return new Xoshiro128StarStar(
          deriveStreamSeed([state.seed, state.contentHash, path]),
          0,
        ).restore(existing);
      }
      return new Xoshiro128StarStar(deriveStreamSeed([state.seed, state.contentHash, path]));
    },
  };
}

function persistStream(state: MatchState, path: string, rng: Xoshiro128StarStar): void {
  const snap = rng.snapshot();
  state.streams[path] = { path, state: snap.state, draws: snap.draws };
}

export function generateLotWithStreams(
  runtime: CompiledRuleRuntime,
  state: MatchState,
): GeneratedLot {
  const engineRng = createEngineRng(state);
  const profileRng = engineRng.stream("lot/profile");
  const themeRng = engineRng.stream("lot/theme");
  const drawRng = engineRng.stream("lot/catalog-draw");

  const profiles = runtime.lotPolicy.profiles;
  let totalProfileWeight = 0;
  for (const p of profiles) totalProfileWeight += p.drawWeight;
  let pick = profileRng.nextBelow(totalProfileWeight);
  let profile = profiles[0];
  for (const p of profiles) {
    if (pick < p.drawWeight) {
      profile = p;
      break;
    }
    pick -= p.drawWeight;
  }
  if (!profile) throw new Error("no profile");

  const pairs: Array<[CategoryId, CategoryId]> = [];
  for (let i = 0; i < CATEGORY_IDS.length; i++) {
    for (let j = i + 1; j < CATEGORY_IDS.length; j++) {
      pairs.push([CATEGORY_IDS[i]!, CATEGORY_IDS[j]!]);
    }
  }
  const theme = pairs[themeRng.nextBelow(pairs.length)]!;

  const tierWeightOf = (tier: TierId): number => {
    const idx = TIER_IDS.indexOf(tier);
    return profile.tierWeights[idx] ?? 1;
  };

  const remaining = [...runtime.catalogSorted];
  const slots: Array<{ slotId: SlotId; itemId: ItemId }> = [];
  let actualValue = 0;
  const boost = runtime.lotPolicy.themeBoostFactor;

  let itemCount = runtime.lotPolicy.slotCount ?? 0;
  let countRng: Xoshiro128StarStar | null = null;
  if (runtime.lotPolicy.countMin !== undefined && runtime.lotPolicy.countMax !== undefined) {
    countRng = engineRng.stream("lot/count");
    itemCount =
      runtime.lotPolicy.countMin +
      countRng.nextBelow(runtime.lotPolicy.countMax - runtime.lotPolicy.countMin + 1);
  }

  for (let s = 1; s <= itemCount; s++) {
    let totalWeight = 0;
    const weights = remaining.map((item) => {
      const w = tierWeightOf(item.tier) * (theme.includes(item.category) ? boost : 1);
      totalWeight += w;
      return w;
    });
    let roll = drawRng.nextBelow(totalWeight);
    let chosenIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      if (roll < weights[i]!) {
        chosenIdx = i;
        break;
      }
      roll -= weights[i]!;
    }
    const chosen = remaining.splice(chosenIdx, 1)[0]!;
    const slotId = `S${String(s).padStart(2, "0")}` as SlotId;
    slots.push({ slotId, itemId: chosen.id });
    actualValue += chosen.value;
  }

  persistStream(state, "lot/profile", profileRng);
  persistStream(state, "lot/theme", themeRng);
  persistStream(state, "lot/catalog-draw", drawRng);
  if (countRng) persistStream(state, "lot/count", countRng);

  let board: GeneratedLot["board"];
  const boardPolicy = runtime.lotPolicy.board;
  if (boardPolicy) {
    const layoutRng = engineRng.stream("lot/layout");
    board = {
      width: boardPolicy.width,
      height: boardPolicy.height,
      placements: layoutBoard(runtime, slots, boardPolicy, layoutRng),
    };
    persistStream(state, "lot/layout", layoutRng);

    const tokenRng = engineRng.stream("lot/reveal-tokens");
    const tokenBySlot: Record<string, string> = {};
    for (const slot of slots) {
      const a = tokenRng.nextBelow(0xffffffff);
      const b = tokenRng.nextBelow(0xffff);
      tokenBySlot[slot.slotId] = `obj.${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(4, "0")}`;
    }
    state.revealTokenBySlot = tokenBySlot;
    persistStream(state, "lot/reveal-tokens", tokenRng);
  }

  return {
    generatorId: boardPolicy
      ? runtime.manifest.contentBundleId === "content.synthetic.v2"
        ? "synthetic.v2"
        : "synthetic.v1"
      : "synthetic.v0",
    hiddenProfile: profile.id as ProfileId,
    hiddenThemeCategories: theme,
    slots,
    actualValue,
    ...(board ? { board } : {}),
  };
}

function layoutBoard(
  runtime: CompiledRuleRuntime,
  slots: Array<{ slotId: SlotId; itemId: ItemId }>,
  policy: { width: number; height: number; maxAttempts: number },
  rng: Xoshiro128StarStar,
): LotPlacement[] {
  const rects = slots.map((slot) => {
    const item = runtime.catalog.get(slot.itemId);
    if (!item) throw new Error(`unknown item ${slot.itemId}`);
    const fp = item.footprint ?? footprintFromShape(item.shapeId);
    return { slotId: slot.slotId, width: fp.width, height: fp.height };
  });
  const order = [...rects].sort((a, b) => b.width * b.height - a.width * a.height || a.slotId.localeCompare(b.slotId));
  const cellsTotal = rects.reduce((a, r) => a + r.width * r.height, 0);
  if (cellsTotal > policy.width * policy.height) {
    throw new Error(`layout infeasible: ${cellsTotal} cells > board ${policy.width * policy.height}`);
  }

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const placements = tryBacktrackingLayout(order, policy, rng);
    if (placements) {
      const bySlot = new Map(placements.map((p) => [p.slotId, p]));
      return slots.map((s) => bySlot.get(s.slotId)!);
    }
  }
  throw new Error(`layout failed after ${policy.maxAttempts} backtracking attempts`);
}

function footprintFromShape(shapeId: string): { width: number; height: number } {
  const shape = SHAPE_DEF_LOOKUP.get(shapeId);
  if (!shape) throw new Error(`unknown shape ${shapeId}`);
  const maxX = Math.max(...shape.cells.map((c) => c.x));
  const maxY = Math.max(...shape.cells.map((c) => c.y));
  return { width: maxX + 1, height: maxY + 1 };
}

function tryBacktrackingLayout(
  order: Array<{ slotId: SlotId; width: number; height: number }>,
  policy: { width: number; height: number },
  rng: Xoshiro128StarStar,
): LotPlacement[] | null {
  const occupied = new Uint8Array(policy.width * policy.height);
  const placements: LotPlacement[] = [];

  const fits = (anchorX: number, anchorY: number, w: number, h: number): boolean => {
    if (anchorX + w > policy.width || anchorY + h > policy.height) return false;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (occupied[(anchorY + dy) * policy.width + (anchorX + dx)]) return false;
      }
    }
    return true;
  };
  const fill = (anchorX: number, anchorY: number, w: number, h: number, v: number): void => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        occupied[(anchorY + dy) * policy.width + (anchorX + dx)] = v;
      }
    }
  };

  const place = (index: number): boolean => {
    if (index === order.length) return true;
    const rect = order[index]!;
    const candidates: Array<{ x: number; y: number }> = [];
    for (let y = 0; y <= policy.height - rect.height; y++) {
      for (let x = 0; x <= policy.width - rect.width; x++) {
        if (fits(x, y, rect.width, rect.height)) candidates.push({ x, y });
      }
    }
    // Dense clustering (Slice 2): candidates are already row-major (y then x)
    // from the scan above. Shuffle only within each same-row run instead of
    // across the whole board, so placement stays biased toward the topmost
    // open rows — objects cluster near the top of the showcase rather than
    // scattering across empty rows that would tip off the board's true extent.
    let runStart = 0;
    for (let i = 1; i <= candidates.length; i++) {
      if (i === candidates.length || candidates[i]!.y !== candidates[runStart]!.y) {
        for (let k = i - 1; k > runStart; k--) {
          const j = runStart + rng.nextBelow(k - runStart + 1);
          const tmp = candidates[k]!;
          candidates[k] = candidates[j]!;
          candidates[j] = tmp;
        }
        runStart = i;
      }
    }
    for (const c of candidates) {
      fill(c.x, c.y, rect.width, rect.height, 1);
      const cells: Array<{ x: number; y: number }> = [];
      for (let dy = 0; dy < rect.height; dy++) {
        for (let dx = 0; dx < rect.width; dx++) {
          cells.push({ x: c.x + dx, y: c.y + dy });
        }
      }
      placements.push({ slotId: rect.slotId, anchor: { x: c.x, y: c.y }, cells });
      if (place(index + 1)) return true;
      placements.pop();
      fill(c.x, c.y, rect.width, rect.height, 0);
    }
    return false;
  };

  return place(0) ? placements : null;
}

const SHAPE_DEF_LOOKUP: Map<string, { id: string; cells: Array<{ x: number; y: number }> }> =
  new Map();

export function registerShapes(shapes: Array<{ id: string; cells: Array<{ x: number; y: number }> }>): void {
  for (const shape of shapes) {
    SHAPE_DEF_LOOKUP.set(shape.id, shape);
  }
}

export function createMatch(input: {
  matchId: string;
  seed: string;
  runtime: CompiledRuleRuntime;
  deadlineDelayMs?: number;
}): MatchState {
  return {
    matchId: input.matchId,
    revision: 0,
    seed: input.seed,
    ruleManifest: input.runtime.manifest,
    ruleManifestHash: input.runtime.manifestHash,
    contentHash: input.runtime.contentHash,
    phase: { kind: "setup" },
    seats: SEAT_IDS.map((seatId) => ({
      seatId,
      setupLocked: false,
      toolCharges: {},
    })),
    round: 0,
    loadoutsRevealed: false,
    intel: [],
    reveals: [],
    streams: {},
    toolUseOrdinal: {},
    ...(input.deadlineDelayMs !== undefined ? { deadlineDelayMs: input.deadlineDelayMs } : {}),
  };
}

function cloneState(state: MatchState): MatchState {
  return structuredClone(state);
}

function allSetupLocked(state: MatchState): boolean {
  return state.seats.every((s) => s.setupLocked);
}

function knowledgeOf(
  state: MatchState,
  viewer: SeatId | "public",
): Map<SlotId, Partial<Record<IntelFieldKind, unknown>>> {
  const map = new Map<SlotId, Partial<Record<IntelFieldKind, unknown>>>();
  if (!state.lot) return map;
  for (const slot of state.lot.slots) {
    map.set(slot.slotId, {});
  }
  for (const record of state.intel) {
    const vis = record.visibility;
    const visible =
      vis.kind === "public" || (viewer !== "public" && vis.kind === "seat" && vis.seatId === viewer);
    if (!visible) continue;
    if (record.fact.kind === "field") {
      const entry = map.get(record.fact.slotId);
      if (!entry) continue;
      applyFieldFact(entry, record.fact);
    }
  }
  return map;
}

function applyFieldFact(
  entry: Partial<Record<IntelFieldKind, unknown>>,
  fact: Extract<IntelFactPayload, { kind: "field" }>,
): void {
  const runtime0 = CATALOG_LOOKUP;
  if (fact.field === "identity" && fact.itemId) {
    const item = runtime0?.get(fact.itemId);
    if (item) {
      entry.identity = fact.itemId;
      entry.tier = item.tier;
      entry.category = item.category;
      entry.shape = item.shapeId;
      entry.value = item.value;
      return;
    }
  }
  switch (fact.field) {
    case "tier":
      if (fact.tier) entry.tier = fact.tier;
      break;
    case "category":
      if (fact.category) entry.category = fact.category;
      break;
    case "shape":
      if (fact.shapeId) entry.shape = fact.shapeId;
      break;
    case "identity":
      if (fact.itemId) entry.identity = fact.itemId;
      break;
    case "value":
      if (fact.value !== undefined) entry.value = fact.value;
      break;
  }
}

let CATALOG_LOOKUP: Map<ItemId, ItemDef> | null = null;

function setCatalogLookup(runtime: CompiledRuleRuntime): void {
  CATALOG_LOOKUP = runtime.catalog;
}

export function candidatesForSlot(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  viewer: SeatId | "public",
  slotId: SlotId,
): CandidateRange {
  const knowledge = knowledgeOf(state, viewer).get(slotId) ?? {};
  const confirmedElsewhere = new Set<ItemId>();
  const allKnowledge = knowledgeOf(state, viewer);
  for (const [otherSlot, fields] of allKnowledge) {
    if (otherSlot === slotId) continue;
    if (typeof fields.identity === "string") confirmedElsewhere.add(fields.identity as ItemId);
  }

  let candidates = runtime.catalogSorted.filter((item) => {
    if (confirmedElsewhere.has(item.id)) return false;
    if (knowledge.identity !== undefined) return item.id === knowledge.identity;
    if (knowledge.tier !== undefined && item.tier !== knowledge.tier) return false;
    if (knowledge.category !== undefined && item.category !== knowledge.category) return false;
    if (knowledge.shape !== undefined && item.shapeId !== knowledge.shape) return false;
    if (knowledge.value !== undefined && item.value !== knowledge.value) return false;
    return true;
  });

  if (candidates.length === 0) {
    candidates = runtime.catalogSorted.filter((item) => item.id === knowledge.identity);
  }

  const values = candidates.map((c) => c.value);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    candidateIds: candidates.map((c) => c.id),
    minValue: values.length ? Math.min(...values) : 0,
    maxValue: values.length ? Math.max(...values) : 0,
    unweightedMeanValueFloor: values.length ? Math.floor(sum / values.length) : 0,
  };
}

export interface FieldFactOut {
  kind: "field";
  slotId: SlotId;
  field: IntelFieldKind;
  tier?: TierId;
  category?: CategoryId;
  shapeId?: string;
  itemId?: ItemId;
  value?: number;
}

function fieldFactForSlot(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  slotId: SlotId,
  field: IntelFieldKind,
): FieldFactOut {
  const slot = state.lot?.slots.find((s) => s.slotId === slotId);
  if (!slot) throw new Error(`unknown slot ${slotId}`);
  const item = runtime.catalog.get(slot.itemId);
  if (!item) throw new Error(`unknown item ${slot.itemId}`);
  switch (field) {
    case "tier":
      return { kind: "field", slotId, field, tier: item.tier };
    case "category":
      return { kind: "field", slotId, field, category: item.category };
    case "shape":
      return { kind: "field", slotId, field, shapeId: item.shapeId };
    case "identity":
      return { kind: "field", slotId, field, itemId: item.id };
    case "value":
      return { kind: "field", slotId, field, value: item.value };
  }
}

export function executeSelector(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  selector: SelectorRuntime,
  viewer: SeatId | "public",
  rng: Xoshiro128StarStar,
): IntelFactPayload[] {
  if (!state.lot) return [{ kind: "exhausted" }];
  const knowledge = knowledgeOf(state, viewer);

  const unknownSlots = (field: IntelFieldKind): SlotId[] => {
    const out: SlotId[] = [];
    for (const slot of state.lot!.slots) {
      const known = knowledge.get(slot.slotId) ?? {};
      if (known[field] === undefined) out.push(slot.slotId);
    }
    return out.sort();
  };

  const pickN = (candidates: SlotId[], count: number): SlotId[] => {
    const pool = [...candidates];
    const chosen: SlotId[] = [];
    while (chosen.length < count && pool.length > 0) {
      const idx = rng.nextBelow(pool.length);
      chosen.push(pool.splice(idx, 1)[0]!);
    }
    return chosen;
  };

  switch (selector.kind) {
    case "randomUnknown": {
      const candidates = unknownSlots(selector.field);
      if (candidates.length === 0) return [{ kind: "exhausted" }];
      const chosen = pickN(candidates, selector.count);
      return chosen.map((slotId) => fieldFactForSlot(runtime, state, slotId, selector.field));
    }
    case "randomMatchingTierCount": {
      if (!state.lot) return [{ kind: "exhausted" }];
      const tiersPresent = new Map<TierId, number>();
      for (const slot of state.lot.slots) {
        const item = runtime.catalog.get(slot.itemId)!;
        tiersPresent.set(item.tier, (tiersPresent.get(item.tier) ?? 0) + 1);
      }
      const unknownTiers = [...tiersPresent.keys()]
        .filter((tier) => {
          for (const slot of state.lot!.slots) {
            const item = runtime.catalog.get(slot.itemId)!;
            if (item.tier !== tier) continue;
            const known = knowledge.get(slot.slotId) ?? {};
            if (known.tier === undefined) return true;
          }
          return false;
        })
        .sort();
      if (unknownTiers.length === 0) return [{ kind: "exhausted" }];
      const pool = [...unknownTiers];
      const chosen: TierId[] = [];
      while (chosen.length < selector.distinctTiers && pool.length > 0) {
        const idx = rng.nextBelow(pool.length);
        chosen.push(pool.splice(idx, 1)[0]!);
      }
      return chosen.map((tier) => ({
        kind: "aggregate" as const,
        metric: "count" as const,
        dimension: "tier" as const,
        key: tier,
        value: tiersPresent.get(tier) ?? 0,
      }));
    }
    case "randomExistingCategoryCount": {
      const categories = new Map<CategoryId, number>();
      for (const slot of state.lot.slots) {
        const item = runtime.catalog.get(slot.itemId)!;
        categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
      }
      const keys = [...categories.keys()].sort();
      if (keys.length === 0) return [{ kind: "exhausted" }];
      const chosen = keys[rng.nextBelow(keys.length)]!;
      return [
        {
          kind: "aggregate",
          metric: "count",
          dimension: "category",
          key: chosen,
          value: categories.get(chosen) ?? 0,
        },
      ];
    }
    case "randomExistingCategoryMeanValue": {
      const byCategory = new Map<CategoryId, number[]>();
      for (const slot of state.lot.slots) {
        const item = runtime.catalog.get(slot.itemId)!;
        const arr = byCategory.get(item.category) ?? [];
        arr.push(item.value);
        byCategory.set(item.category, arr);
      }
      const keys = [...byCategory.keys()].sort();
      if (keys.length === 0) return [{ kind: "exhausted" }];
      const chosen = keys[rng.nextBelow(keys.length)]!;
      const values = byCategory.get(chosen)!;
      const mean = Math.floor(values.reduce((a, b) => a + b, 0) / values.length);
      return [
        {
          kind: "aggregate",
          metric: "meanValueFloor",
          dimension: "category",
          key: chosen,
          value: mean,
        },
      ];
    }
  }
}

function pushIntel(
  state: MatchState,
  events: DomainEvent[],
  facts: IntelFactPayload[],
  visibility: IntelVisibility,
  sourceId: string,
  round: number,
  effectInstanceId: string,
): void {
  for (const fact of facts) {
    const record: IntelRecord = {
      fact,
      visibility,
      sourceId,
      round,
      effectInstanceId,
      revision: state.revision + 1,
    };
    state.intel.push(record);
    events.push({
      seq: 0,
      type: fact.kind === "exhausted" ? "intel.exhausted" : "intel.revealed",
      schemaVersion: 1,
      visibility: visibility.kind === "public" ? "public" : visibility.seatId,
      payload: { fact: fact as unknown as Record<string, unknown>, sourceId, round, effectInstanceId },
    });
  }
}

function startAuction(state: MatchState, runtime: CompiledRuleRuntime, events: DomainEvent[]): void {
  const lot = generateLotWithStreams(runtime, state);
  state.lot = lot;
  state.loadoutsRevealed = true;
  events.push({
    seq: 0,
    type: "lot.created",
    schemaVersion: 1,
    visibility: "audit",
    payload: { slotCount: lot.slots.length, actualValue: lot.actualValue, hiddenProfile: lot.hiddenProfile },
  });
  events.push({
    seq: 0,
    type: "loadouts.revealed",
    schemaVersion: 1,
    visibility: "public",
    payload: {
      loadouts: state.seats.map((s) => ({
        seatId: s.seatId,
        analystId: s.analystId,
        toolPackageId: s.toolPackageId,
      })),
    },
  });

  const engineRng = createEngineRng(state);
  for (const seat of state.seats) {
    const analyst = seat.analystId ? runtime.analysts.get(seat.analystId) : undefined;
    if (!analyst) continue;
    for (const binding of analyst.effects) {
      if (binding.trigger !== "auction_start") continue;
      const path = `intel/analyst/${seat.seatId}/${binding.effect.id}`;
      const rng = engineRng.stream(path);
      const facts = executeSelector(runtime, state, binding.effect.selector, seat.seatId, rng);
      persistStream(state, path, rng);
      pushIntel(
        state,
        events,
        facts,
        { kind: "seat", seatId: seat.seatId },
        analyst.id,
        0,
        `${analyst.id}:start`,
      );
    }
  }
  state.phase = { kind: "auction" };
  openRoundWindow(state, runtime, events, 1);
}

function openRoundWindow(
  state: MatchState,
  runtime: CompiledRuleRuntime,
  events: DomainEvent[],
  round: number,
): void {
  state.round = round;
  const engineRng = createEngineRng(state);

  if (runtime.publicIntelPool && runtime.publicIntelPool.length > 0) {
    const effectPath = `intel/public/round/${round}/effect`;
    const effectRng = engineRng.stream(effectPath);
    let total = 0;
    for (const entry of runtime.publicIntelPool) total += entry.weight;
    let pick = effectRng.nextBelow(total);
    let chosen = runtime.publicIntelPool[0]!;
    for (const entry of runtime.publicIntelPool) {
      if (pick < entry.weight) {
        chosen = entry;
        break;
      }
      pick -= entry.weight;
    }
    persistStream(state, effectPath, effectRng);

    const targetPath = `intel/public/round/${round}/target`;
    const targetRng = engineRng.stream(targetPath);
    const facts = executeSelector(runtime, state, chosen.selector, "public", targetRng);
    persistStream(state, targetPath, targetRng);
    pushIntel(state, events, facts, { kind: "public" }, chosen.id, round, `${chosen.id}:r${round}`);
  } else {
    const publicEffect = runtime.publicIntelSchedule?.[round - 1];
    if (publicEffect) {
      const path = `intel/public/round/${round}`;
      const rng = engineRng.stream(path);
      const facts = executeSelector(runtime, state, publicEffect.selector, "public", rng);
      persistStream(state, path, rng);
      pushIntel(state, events, facts, { kind: "public" }, publicEffect.id, round, `${publicEffect.id}:r${round}`);
    }
  }

  for (const seat of state.seats) {
    const analyst = seat.analystId ? runtime.analysts.get(seat.analystId) : undefined;
    if (!analyst) continue;
    for (const binding of analyst.effects) {
      if (binding.trigger !== `round_${round}_start`) continue;
      const path = `intel/analyst/${seat.seatId}/${binding.effect.id}:r${round}`;
      const rng = engineRng.stream(path);
      const facts = executeSelector(runtime, state, binding.effect.selector, seat.seatId, rng);
      persistStream(state, path, rng);
      pushIntel(
        state,
        events,
        facts,
        { kind: "seat", seatId: seat.seatId },
        analyst.id,
        round,
        `${analyst.id}:r${round}`,
      );
    }
  }

  const windowId = `w-round-${round}`;
  state.window = {
    actionWindowId: windowId,
    kind: "round",
    round,
    participants: [...SEAT_IDS],
    toolUsed: {},
    bids: {},
  };
  events.push({
    seq: 0,
    type: "round.window.opened",
    schemaVersion: 1,
    visibility: "public",
    payload: { actionWindowId: windowId, round, kind: "round" },
  });
}

function openTiebreakWindow(
  state: MatchState,
  events: DomainEvent[],
  participants: SeatId[],
): void {
  const windowId = "w-tiebreak-1";
  state.phase = { kind: "tiebreak" };
  state.window = {
    actionWindowId: windowId,
    kind: "tiebreak",
    round: 6,
    participants: [...participants].sort(),
    toolUsed: {},
    bids: {},
  };
  events.push({
    seq: 0,
    type: "tiebreak.window.opened",
    schemaVersion: 1,
    visibility: "public",
    payload: { actionWindowId: windowId, round: 6, participants: [...participants].sort() },
  });
}

function allParticipantsLocked(window: DecisionWindowState): boolean {
  return window.participants.every((p) => window.bids[p]?.locked === true);
}

function closeWindowAndReveal(
  state: MatchState,
  runtime: CompiledRuleRuntime,
  events: DomainEvent[],
): void {
  const window = state.window;
  if (!window || !state.lot) return;

  for (const p of window.participants) {
    if (!window.bids[p]) {
      window.bids[p] = { amount: 0, locked: false, source: "deadline-default" };
    }
  }

  const bidsRecord: Record<SeatId, number> = { seat1: 0, seat2: 0, seat3: 0, seat4: 0 };
  for (const seatId of SEAT_IDS) {
    const b = window.bids[seatId];
    if (b) bidsRecord[seatId] = b.amount;
  }

  const reveal: RoundRevealRecord = {
    round: window.round,
    kind: window.kind,
    bids: bidsRecord,
    toolUsed: { ...window.toolUsed },
    outcome: "continue",
    revision: state.revision + 1,
  };

  const sorted = [...window.participants]
    .map((seatId) => ({ seatId, amount: window.bids[seatId]?.amount ?? 0 }))
    .sort((a, b) => b.amount - a.amount || a.seatId.localeCompare(b.seatId));

  const top = sorted[0]!;
  const second = sorted[1];
  const tiedTop = sorted.filter((e) => e.amount === top.amount);
  const uniqueTop = tiedTop.length === 1;

  events.push({
    seq: 0,
    type: "bids.revealed",
    schemaVersion: 1,
    visibility: "public",
    payload: { round: window.round, kind: window.kind, bids: bidsRecord, toolUsed: { ...window.toolUsed } },
  });

  state.window = undefined;

  if (window.kind === "round" && window.round <= 4) {
    if (uniqueTop && top.amount > 0) {
      const sAmount = second?.amount ?? 0;
      const mult = MULTIPLIERS[window.round - 1]!;
      const passes = sAmount === 0 || top.amount * mult.denominator > sAmount * mult.numerator;
      if (passes) {
        reveal.outcome = "sold";
        reveal.buyerSeatId = top.seatId;
        reveal.winningBid = top.amount;
        state.reveals.push(reveal);
        settleMatch(state, runtime, events, top.seatId, top.amount, window.round);
        return;
      }
    }
    reveal.outcome = "continue";
    state.reveals.push(reveal);
    openRoundWindow(state, runtime, events, window.round + 1);
    return;
  }

  if (window.kind === "round" && window.round === 5) {
    if (uniqueTop) {
      reveal.outcome = "sold";
      reveal.buyerSeatId = top.seatId;
      reveal.winningBid = top.amount;
      state.reveals.push(reveal);
      settleMatch(state, runtime, events, top.seatId, top.amount, window.round);
      return;
    }
    reveal.outcome = "tiebreak";
    state.reveals.push(reveal);
    openTiebreakWindow(state, events, tiedTop.map((e) => e.seatId));
    return;
  }

  if (uniqueTop) {
    reveal.outcome = "sold";
    reveal.buyerSeatId = top.seatId;
    reveal.winningBid = top.amount;
    state.reveals.push(reveal);
    settleMatch(state, runtime, events, top.seatId, top.amount, window.round);
  } else {
    reveal.outcome = "no_sale";
    state.reveals.push(reveal);
    settleNoSale(state, runtime, events);
  }
}

function settleMatch(
  state: MatchState,
  runtime: CompiledRuleRuntime,
  events: DomainEvent[],
  buyerSeatId: SeatId,
  winningBid: number,
  settlementRound: number,
): void {
  const lot = state.lot!;
  const budget = runtime.config.startingBudget;
  const V = lot.actualValue;
  const P = winningBid;
  const overbidLoss = Math.max(0, P - V);
  const bonus = Math.floor(overbidLoss / 10);

  const economic: EconomicResultEntry[] = SEAT_IDS.map((seatId) => {
    const isBuyer = seatId === buyerSeatId;
    const R = isBuyer ? 0 : bonus;
    const W = budget - (isBuyer ? P : 0) + (isBuyer ? V : 0) + R;
    return {
      seatId,
      finalWealth: W,
      realizedProfit: W - budget,
      bonusReward: R,
      denseEconomicRank: 0,
    };
  });

  assignDenseRanks(economic);

  const sumW = economic.reduce((a, e) => a + e.finalWealth, 0);
  const training: TrainingUtilityEntry[] = economic.map((e) => ({
    seatId: e.seatId,
    utilityNumerator: 4 * e.finalWealth - sumW,
    utilityDenominator: 4 * budget,
  }));

  const result: MatchResult = {
    acquisition: {
      buyerSeatId,
      winningBid: P,
      settlementRound,
    },
    economic,
    training,
  };

  state.phase = { kind: "completed", result };
  events.push({
    seq: 0,
    type: "match.completed",
    schemaVersion: 1,
    visibility: "public",
    payload: {
      acquisition: result.acquisition as unknown as Record<string, unknown>,
      economic: economic as unknown as Record<string, unknown>[],
      actualValue: V,
    },
  });
}

function settleNoSale(state: MatchState, runtime: CompiledRuleRuntime, events: DomainEvent[]): void {
  const budget = runtime.config.startingBudget;
  const economic: EconomicResultEntry[] = SEAT_IDS.map((seatId) => ({
    seatId,
    finalWealth: budget,
    realizedProfit: 0,
    bonusReward: 0,
    denseEconomicRank: 1,
  }));
  const training: TrainingUtilityEntry[] = SEAT_IDS.map((seatId) => ({
    seatId,
    utilityNumerator: 0,
    utilityDenominator: 4 * budget,
  }));
  const result: MatchResult = {
    acquisition: { noSaleReason: "tiebreak_tie" },
    economic,
    training,
  };
  state.phase = { kind: "completed", result };
  events.push({
    seq: 0,
    type: "match.completed",
    schemaVersion: 1,
    visibility: "public",
    payload: {
      acquisition: result.acquisition as unknown as Record<string, unknown>,
      economic: economic as unknown as Record<string, unknown>[],
      actualValue: state.lot?.actualValue ?? 0,
    },
  });
}

function assignDenseRanks(economic: EconomicResultEntry[]): void {
  const sorted = [...economic].sort((a, b) => b.finalWealth - a.finalWealth);
  let rank = 0;
  let prev: number | null = null;
  const rankBySeat = new Map<SeatId, number>();
  for (const entry of sorted) {
    if (prev === null || entry.finalWealth < prev) {
      rank += 1;
      prev = entry.finalWealth;
    }
    rankBySeat.set(entry.seatId, rank);
  }
  for (const entry of economic) {
    entry.denseEconomicRank = rankBySeat.get(entry.seatId)!;
  }
}

export function legalActions(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  seatId: SeatId,
): LegalActionSet {
  const seat = state.seats.find((s) => s.seatId === seatId);
  if (!seat || state.phase.kind === "completed") {
    return { seatId, actions: [{ kind: "wait" }] };
  }

  if (state.phase.kind === "setup") {
    const actions: LegalActionSet["actions"] = [];
    if (!seat.setupLocked) {
      actions.push({
        kind: "select_loadout",
        analystIds: [...runtime.analysts.keys()],
        toolPackageIds: [...runtime.toolPackages.keys()],
      });
      if (seat.analystId && seat.toolPackageId) {
        actions.push({ kind: "lock_setup" });
      }
    }
    return { seatId, actions: actions.length ? actions : [{ kind: "wait" }] };
  }

  const window = state.window;
  if (!window || !window.participants.includes(seatId)) {
    return { seatId, actions: [{ kind: "wait" }] };
  }

  const bidState = window.bids[seatId];
  if (bidState?.locked) {
    return { seatId, actionWindowId: window.actionWindowId, actions: [{ kind: "wait" }] };
  }

  const actions: LegalActionSet["actions"] = [];
  if (window.kind === "round") {
    const pkg = seat.toolPackageId ? runtime.toolPackages.get(seat.toolPackageId) : undefined;
    if (pkg && !window.toolUsed[seatId]) {
      const usable: string[] = [];
      for (const tool of pkg.tools) {
        const charges = seat.toolCharges[tool.id] ?? 0;
        if (charges >= 1) continue;
        if (toolCanReveal(runtime, state, seatId, tool.effect.selector)) {
          usable.push(tool.id);
        }
      }
      if (usable.length > 0) {
        actions.push({ kind: "use_tool", toolIds: usable });
      }
    }
  }
  actions.push({ kind: "submit_bid", min: 0, max: runtime.config.startingBudget });
  actions.push({ kind: "lock_bid" });
  return { seatId, actionWindowId: window.actionWindowId, actions };
}

function toolCanReveal(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  seatId: SeatId,
  selector: SelectorRuntime,
): boolean {
  if (!state.lot) return false;
  const knowledge = knowledgeOf(state, seatId);
  switch (selector.kind) {
    case "randomUnknown": {
      for (const slot of state.lot.slots) {
        const known = knowledge.get(slot.slotId) ?? {};
        if (known[selector.field] === undefined) return true;
      }
      return false;
    }
    case "randomMatchingTierCount": {
      for (const slot of state.lot.slots) {
        const known = knowledge.get(slot.slotId) ?? {};
        if (known.tier === undefined) return true;
      }
      return false;
    }
    case "randomExistingCategoryCount":
    case "randomExistingCategoryMeanValue":
      return true;
  }
}

export function transition(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: GameCommand,
): TransitionResult {
  setCatalogLookup(runtime);
  if (state.phase.kind === "completed") {
    return { kind: "rejected", code: "MATCH_NOT_ACTIVE" };
  }

  switch (command.kind) {
    case "select_loadout":
      return handleSelectLoadout(runtime, state, command);
    case "lock_setup":
      return handleLockSetup(runtime, state, command);
    case "use_tool":
      return handleUseTool(runtime, state, command);
    case "submit_bid":
      return handleSubmitBid(runtime, state, command);
    case "lock_bid":
      return handleLockBid(runtime, state, command);
    case "deadline_reached":
      return handleDeadline(runtime, state, command);
  }
}

function accepted(
  state: MatchState,
  events: DomainEvent[],
  effects: RequestedEffect[],
): TransitionResult {
  state.revision += 1;
  let seq = state.revision * 1000;
  for (const e of events) {
    e.seq = seq++;
  }
  return { kind: "accepted", nextState: state, events, effects };
}

function handleSelectLoadout(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: Extract<GameCommand, { kind: "select_loadout" }>,
): TransitionResult {
  if (state.phase.kind !== "setup") return { kind: "rejected", code: "ACTION_ILLEGAL" };
  const seat = state.seats.find((s) => s.seatId === command.seatId);
  if (!seat) return { kind: "rejected", code: "COMMAND_SCHEMA_INVALID" };
  if (seat.setupLocked) return { kind: "rejected", code: "ACTION_ALREADY_LOCKED" };
  if (!runtime.analysts.has(command.analystId) || !runtime.toolPackages.has(command.toolPackageId)) {
    return { kind: "rejected", code: "ACTION_ILLEGAL" };
  }
  const next = cloneState(state);
  const nextSeat = next.seats.find((s) => s.seatId === command.seatId)!;
  nextSeat.analystId = command.analystId;
  nextSeat.toolPackageId = command.toolPackageId;
  return accepted(
    next,
    [
      {
        seq: 0,
        type: "loadout.selected",
        schemaVersion: 1,
        visibility: command.seatId,
        payload: { seatId: command.seatId, analystId: command.analystId, toolPackageId: command.toolPackageId },
      },
    ],
    [],
  );
}

function handleLockSetup(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: Extract<GameCommand, { kind: "lock_setup" }>,
): TransitionResult {
  if (state.phase.kind !== "setup") return { kind: "rejected", code: "ACTION_ILLEGAL" };
  const seat = state.seats.find((s) => s.seatId === command.seatId);
  if (!seat) return { kind: "rejected", code: "COMMAND_SCHEMA_INVALID" };
  if (seat.setupLocked) return { kind: "rejected", code: "ACTION_ALREADY_LOCKED" };
  if (!seat.analystId || !seat.toolPackageId) return { kind: "rejected", code: "ACTION_ILLEGAL" };

  const next = cloneState(state);
  const nextSeat = next.seats.find((s) => s.seatId === command.seatId)!;
  nextSeat.setupLocked = true;
  const events: DomainEvent[] = [
    {
      seq: 0,
      type: "setup.locked",
      schemaVersion: 1,
      visibility: "public",
      payload: { seatId: command.seatId },
    },
  ];
  const effects: RequestedEffect[] = [];
  if (allSetupLocked(next)) {
    startAuction(next, runtime, events);
    const windowId = next.window?.actionWindowId;
    if (windowId) {
      effects.push({ kind: "schedule_deadline", actionWindowId: windowId, delayMs: next.deadlineDelayMs ?? 0 });
      for (const seatId of SEAT_IDS) {
        effects.push({ kind: "request_agent_decision", seatId, observationRevision: next.revision + 1 });
      }
    }
    effects.push({ kind: "publish_views", affectedViewers: "all" });
  }
  return accepted(next, events, effects);
}

function handleUseTool(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: Extract<GameCommand, { kind: "use_tool" }>,
): TransitionResult {
  const window = state.window;
  if (!window || window.actionWindowId !== command.actionWindowId) {
    return { kind: "rejected", code: "ACTION_WINDOW_MISMATCH" };
  }
  if (window.kind !== "round") return { kind: "rejected", code: "ACTION_ILLEGAL" };
  if (!window.participants.includes(command.seatId)) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  const seat = state.seats.find((s) => s.seatId === command.seatId)!;
  if (window.bids[command.seatId]?.locked) return { kind: "rejected", code: "ACTION_ALREADY_LOCKED" };
  if (window.toolUsed[command.seatId]) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  const pkg = seat.toolPackageId ? runtime.toolPackages.get(seat.toolPackageId) : undefined;
  const tool = pkg?.tools.find((t) => t.id === command.toolId);
  if (!pkg || !tool) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  if ((seat.toolCharges[tool.id] ?? 0) >= 1) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  if (!toolCanReveal(runtime, state, command.seatId, tool.effect.selector)) {
    return { kind: "rejected", code: "ACTION_ILLEGAL" };
  }

  const next = cloneState(state);
  const nextWindow = next.window!;
  const nextSeat = next.seats.find((s) => s.seatId === command.seatId)!;
  nextSeat.toolCharges[tool.id] = 1;
  nextWindow.toolUsed[command.seatId] = tool.id;

  const ordinal = (next.toolUseOrdinal[command.seatId] ?? 0) + 1;
  next.toolUseOrdinal[command.seatId] = ordinal;
  const path = `intel/tool/${command.seatId}/${ordinal}`;
  const engineRng = createEngineRng(next);
  const rng = engineRng.stream(path);
  const facts = executeSelector(runtime, next, tool.effect.selector, command.seatId, rng);
  persistStream(next, path, rng);

  const events: DomainEvent[] = [
    {
      seq: 0,
      type: "tool.used",
      schemaVersion: 1,
      visibility: "public",
      payload: { seatId: command.seatId, toolId: tool.id, round: nextWindow.round },
    },
  ];
  pushIntel(
    next,
    events,
    facts,
    { kind: "seat", seatId: command.seatId },
    tool.id,
    nextWindow.round,
    `${tool.id}:u${ordinal}`,
  );
  return accepted(next, events, []);
}

function handleSubmitBid(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: Extract<GameCommand, { kind: "submit_bid" }>,
): TransitionResult {
  const window = state.window;
  if (!window || window.actionWindowId !== command.actionWindowId) {
    return { kind: "rejected", code: "ACTION_WINDOW_MISMATCH" };
  }
  if (!window.participants.includes(command.seatId)) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  if (window.bids[command.seatId]?.locked) return { kind: "rejected", code: "ACTION_ALREADY_LOCKED" };
  if (
    !Number.isSafeInteger(command.amount) ||
    command.amount < 0 ||
    command.amount > runtime.config.startingBudget
  ) {
    return { kind: "rejected", code: "ACTION_ILLEGAL" };
  }
  const next = cloneState(state);
  const nextWindow = next.window!;
  nextWindow.bids[command.seatId] = { amount: command.amount, locked: false, source: "explicit" };
  return accepted(
    next,
    [
      {
        seq: 0,
        type: "bid.submitted",
        schemaVersion: 1,
        visibility: command.seatId,
        payload: { seatId: command.seatId, amount: command.amount, round: nextWindow.round },
      },
    ],
    [],
  );
}

function handleLockBid(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: Extract<GameCommand, { kind: "lock_bid" }>,
): TransitionResult {
  const window = state.window;
  if (!window || window.actionWindowId !== command.actionWindowId) {
    return { kind: "rejected", code: "ACTION_WINDOW_MISMATCH" };
  }
  if (!window.participants.includes(command.seatId)) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  const bid = window.bids[command.seatId];
  if (!bid) return { kind: "rejected", code: "ACTION_ILLEGAL" };
  if (bid.locked) return { kind: "rejected", code: "ACTION_ALREADY_LOCKED" };

  const next = cloneState(state);
  const nextWindow = next.window!;
  nextWindow.bids[command.seatId] = { ...nextWindow.bids[command.seatId]!, locked: true };
  const events: DomainEvent[] = [
    {
      seq: 0,
      type: "bid.locked",
      schemaVersion: 1,
      visibility: "public",
      payload: { seatId: command.seatId, round: nextWindow.round },
    },
  ];
  const effects: RequestedEffect[] = [];
  if (allParticipantsLocked(nextWindow)) {
    closeWindowAndReveal(next, runtime, events);
    if (next.window) {
      effects.push({
        kind: "schedule_deadline",
        actionWindowId: next.window.actionWindowId,
        delayMs: next.deadlineDelayMs ?? 0,
      });
      for (const seatId of next.window.participants) {
        effects.push({ kind: "request_agent_decision", seatId, observationRevision: next.revision + 1 });
      }
    } else {
      effects.push({ kind: "finalize_replay", matchId: next.matchId });
    }
    effects.push({ kind: "publish_views", affectedViewers: "all" });
  }
  return accepted(next, events, effects);
}

function handleDeadline(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  command: Extract<GameCommand, { kind: "deadline_reached" }>,
): TransitionResult {
  const window = state.window;
  if (!window) return { kind: "rejected", code: "ACTION_WINDOW_CLOSED" };
  if (window.actionWindowId !== command.actionWindowId) {
    return { kind: "rejected", code: "ACTION_WINDOW_MISMATCH" };
  }
  const next = cloneState(state);
  const events: DomainEvent[] = [
    {
      seq: 0,
      type: "round.deadline",
      schemaVersion: 1,
      visibility: "public",
      payload: { actionWindowId: command.actionWindowId, round: next.window?.round },
    },
  ];
  const effects: RequestedEffect[] = [];
  closeWindowAndReveal(next, runtime, events);
  if (next.window) {
    effects.push({
      kind: "schedule_deadline",
      actionWindowId: next.window.actionWindowId,
      delayMs: next.deadlineDelayMs ?? 0,
    });
    for (const seatId of next.window.participants) {
      effects.push({ kind: "request_agent_decision", seatId, observationRevision: next.revision + 1 });
    }
  } else {
    effects.push({ kind: "finalize_replay", matchId: next.matchId });
  }
  effects.push({ kind: "publish_views", affectedViewers: "all" });
  return accepted(next, events, effects);
}

export function observePublic(runtime: CompiledRuleRuntime, state: MatchState): PublicView {
  return projectView(runtime, state, "public") as PublicView;
}

export function observeSeat(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  seatId: SeatId,
): SeatObservation {
  const base = projectView(runtime, state, seatId);
  const seat = state.seats.find((s) => s.seatId === seatId)!;
  const window = state.window;
  const bidState = window?.bids[seatId];
  const privateIntel = state.intel
    .filter((r) => r.visibility.kind === "seat" && r.visibility.seatId === seatId)
    .map((r) => projectIntelRecord(state, r, state.lot?.generatorId === "synthetic.v2" && state.phase.kind !== "completed"));
  return {
    ...base,
    viewer: seatId,
    mySeat: {
      seatId,
      ...(seat.analystId ? { analystId: seat.analystId } : {}),
      ...(seat.toolPackageId ? { toolPackageId: seat.toolPackageId } : {}),
      setupLocked: seat.setupLocked,
      toolCharges: { ...seat.toolCharges },
      ...(bidState ? { currentBid: bidState.amount, currentBidLocked: bidState.locked } : {}),
      privateIntel,
    },
    legalActions: legalActions(runtime, state, seatId),
  };
}

function projectView(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  viewer: SeatId | "public",
): Omit<SeatObservation, "mySeat" | "legalActions"> | PublicView {
  setCatalogLookup(runtime);
  const knowledge = knowledgeOf(state, viewer);
  const isV2 = state.lot?.generatorId === "synthetic.v2";
  const concealSlots = isV2 && state.phase.kind !== "completed";
  const slots: SlotPublicView[] = concealSlots
    ? []
    : (state.lot?.slots ?? []).map((slot) => {
        const fields = knowledge.get(slot.slotId) ?? {};
        return {
          slotId: slot.slotId,
          knownFields: {
            ...(fields.tier !== undefined ? { tier: fields.tier as TierId } : {}),
            ...(fields.category !== undefined ? { category: fields.category as CategoryId } : {}),
            ...(fields.shape !== undefined ? { shape: fields.shape as string } : {}),
            ...(fields.identity !== undefined ? { identity: fields.identity as ItemId } : {}),
            ...(fields.value !== undefined ? { value: fields.value as number } : {}),
          },
          candidates: candidatesForSlot(runtime, state, viewer, slot.slotId),
        };
      });

  const publicIntel = state.intel
    .filter((r) => r.visibility.kind === "public")
    .map((r) => projectIntelRecord(state, r, concealSlots));
  const window = state.window;
  const result = state.phase.kind === "completed" ? state.phase.result : undefined;

  const board = projectBoard(runtime, state, viewer, knowledge);
  const publicEvents = projectPublicEvents(state);
  // Once the match is complete there's no more uncertainty — the true sum
  // IS the expected value, and estimateConservativeValue's completed-phase
  // branch already computes that exact total straight from the catalog
  // (bypassing per-viewer intel, which may be incomplete for objects no one
  // ever inspected). Pre-completion, use the real expected-value estimate:
  // same formula the agents use to size bids, so the HUD and the agents can
  // never drift apart. Board takes precedence over the legacy flat slots
  // list when both are present, matching how agents already read observations.
  const estimatedValue =
    state.phase.kind === "completed"
      ? estimateConservativeValue(runtime, state, knowledge)
      : board
        ? estimateExpectedValue(board.revealedObjects)
        : estimateExpectedValue(
            slots.map((s) => ({
              ...(s.knownFields.value !== undefined ? { exactValue: s.knownFields.value } : {}),
              candidateSummary: s.candidates,
            })),
          );

  return {
    viewer,
    matchId: state.matchId,
    revision: state.revision,
    phase: state.phase.kind,
    round: state.round,
    ruleBundleId: state.ruleManifest.ruleBundleId,
    contentBundleId: state.ruleManifest.contentBundleId,
    startingBudget: runtime.config.startingBudget,
    estimatedValue,
    slots,
    ...(board ? { board } : {}),
    publicIntel,
    publicEvents,
    ...(state.loadoutsRevealed
      ? {
          loadouts: state.seats.map((s) => ({
            seatId: s.seatId,
            analystId: s.analystId!,
            toolPackageId: s.toolPackageId!,
          })),
        }
      : {}),
    ...(window
      ? {
          window: {
            actionWindowId: window.actionWindowId,
            kind: window.kind as WindowKind,
            round: window.round,
            participants: [...window.participants],
            lockedSeats: window.participants.filter((p) => window.bids[p]?.locked),
            toolUsedBySeat: { ...window.toolUsed },
          },
        }
      : {}),
    reveals: [...state.reveals],
    ...(result ? { result } : {}),
  } as Omit<SeatObservation, "mySeat" | "legalActions"> | PublicView;
}

export function hashState(state: MatchState): string {
  return canonicalHash(state as unknown as Record<string, unknown>);
}
function projectBoard(
  runtime: CompiledRuleRuntime,
  state: MatchState,
  viewer: SeatId | "public",
  knowledge: Map<SlotId, Partial<Record<IntelFieldKind, unknown>>>,
): LotBoardView | undefined {
  const board = state.lot?.board;
  if (!board || !state.lot) return undefined;

  const placementBySlot = new Map<SlotId, LotPlacement>();
  for (const p of board.placements) placementBySlot.set(p.slotId, p);

  const revealedObjects: RevealedObjectView[] = [];
  const completed = state.phase.kind === "completed";
  for (const slot of state.lot.slots) {
    const fields = knowledge.get(slot.slotId) ?? {};
    const placement = placementBySlot.get(slot.slotId);
    if (!placement) continue;

    if (completed) {
      const item = runtime.catalog.get(slot.itemId)!;
      revealedObjects.push({
        revealId: state.revealTokenBySlot?.[slot.slotId] ?? `obj.${slot.slotId}`,
        anchor: placement.anchor,
        cells: placement.cells,
        tier: item.tier,
        category: item.category,
        identity: item.id,
        exactValue: item.value,
        candidateSummary: candidatesForSlot(runtime, state, viewer, slot.slotId),
      });
      continue;
    }

    const shapeKnown = fields.shape !== undefined || fields.identity !== undefined;
    const tierKnown = fields.tier !== undefined || fields.identity !== undefined;
    const categoryKnown = fields.category !== undefined || fields.identity !== undefined;
    const identityKnown = fields.identity !== undefined;
    const valueKnown = fields.value !== undefined || fields.identity !== undefined;
    const anyKnown = shapeKnown || tierKnown || categoryKnown || identityKnown || valueKnown;
    if (!anyKnown) continue;

    const revealed: RevealedObjectView = {
      revealId: state.revealTokenBySlot?.[slot.slotId] ?? `obj.${slot.slotId}`,
      ...((tierKnown || categoryKnown || valueKnown || identityKnown || shapeKnown)
        ? { anchor: placement.anchor }
        : {}),
      ...(shapeKnown ? { cells: placement.cells } : {}),
      ...(fields.tier !== undefined ? { tier: fields.tier as TierId } : {}),
      ...(fields.category !== undefined ? { category: fields.category as CategoryId } : {}),
      ...(identityKnown ? { identity: fields.identity as ItemId } : {}),
      ...(fields.value !== undefined ? { exactValue: fields.value as number } : {}),
      candidateSummary: candidatesForSlot(runtime, state, viewer, slot.slotId),
    };
    revealedObjects.push(revealed);
  }

  const aggregateFacts: AggregateFactView[] = [];
  for (const record of state.intel) {
    if (record.fact.kind !== "aggregate") continue;
    const vis = record.visibility;
    const visible =
      vis.kind === "public" || (viewer !== "public" && vis.kind === "seat" && vis.seatId === viewer);
    if (!visible) continue;
    aggregateFacts.push({
      metric: record.fact.metric,
      dimension: record.fact.dimension,
      key: record.fact.key,
      value: record.fact.value,
      round: record.round,
      visibility: vis.kind === "public" ? "public" : vis.seatId,
    });
  }

  return {
    schemaVersion: 1,
    width: board.width,
    height: board.height,
    concealedCells: board.width * board.height,
    revealedObjects,
    aggregateFacts,
  };
}

function projectPublicEvents(state: MatchState): PublicEventView[] {
  const events: PublicEventView[] = [];

  for (const reveal of state.reveals) {
    for (const [seatId, toolId] of Object.entries(reveal.toolUsed)) {
      if (!toolId) continue;
      events.push({
        id: `tool:${reveal.round}:${seatId}`,
        revision: reveal.revision ?? 0,
        round: reveal.round,
        sourceKind: "tool",
        localizationKey: "event.tool.used",
        params: { seat: seatId, toolId },
        revealIds: [],
      });
    }
  }

  const publicFieldGroups = new Map<
    string,
    { revision: number; round: number; sourceId: string; fields: Set<string>; revealIds: string[]; params: Record<string, string | number> }
  >();

  for (const record of state.intel) {
    if (record.visibility.kind !== "public") continue;
    const fact = record.fact;
    const base = {
      revision: record.revision ?? 0,
      round: record.round,
      effectInstanceId: record.effectInstanceId,
    };
    if (fact.kind === "exhausted") {
      events.push({
        id: `intel:${record.effectInstanceId}:exhausted`,
        ...base,
        sourceKind: "auctioneer",
        localizationKey: "event.intel.exhausted",
        params: {},
        revealIds: [],
      });
      continue;
    }
    if (fact.kind === "aggregate") {
      const key =
        fact.metric === "count"
          ? fact.dimension === "tier"
            ? "event.intel.aggregate.countTier"
            : "event.intel.aggregate.count"
          : "event.intel.aggregate.mean";
      events.push({
        id: `intel:${record.effectInstanceId}:agg:${fact.dimension}:${fact.key}`,
        ...base,
        sourceKind: record.sourceId.startsWith("intel.public") ? "auctioneer" : "analyst",
        localizationKey: key,
        params: { key: fact.key, value: fact.value },
        revealIds: [],
      });
      continue;
    }
    const revealId = state.revealTokenBySlot?.[fact.slotId] ?? `obj.${fact.slotId}`;
    const group = publicFieldGroups.get(record.effectInstanceId) ?? {
      revision: record.revision ?? 0,
      round: record.round,
      sourceId: record.sourceId,
      fields: new Set<string>(),
      revealIds: [],
      params: {},
    };
    group.fields.add(fact.field);
    if (!group.revealIds.includes(revealId)) group.revealIds.push(revealId);
    if (fact.tier) group.params.tier = fact.tier;
    if (fact.category) group.params.category = fact.category;
    if (fact.itemId) group.params.itemId = fact.itemId;
    if (fact.value !== undefined) group.params.value = fact.value;
    publicFieldGroups.set(record.effectInstanceId, group);
  }

  for (const [effectInstanceId, group] of publicFieldGroups) {
    const fields = [...group.fields].sort();
    const multiTarget = group.revealIds.length > 1;
    const localizationKey = multiTarget
      ? `event.intel.multi.${fields.join("-")}`
      : `event.intel.field.${fields[0]}`;
    events.push({
      id: `intel:${effectInstanceId}`,
      revision: group.revision,
      round: group.round,
      sourceKind: group.sourceId.startsWith("intel.public")
        ? "auctioneer"
        : group.sourceId.startsWith("analyst.")
          ? "analyst"
          : "tool",
      localizationKey,
      params: { ...group.params, count: group.revealIds.length },
      revealIds: [...group.revealIds].sort(),
      effectInstanceId,
    });
  }

  for (const reveal of state.reveals) {
    const bids = Object.entries(reveal.bids)
      .map(([seat, amount]) => `${seat}:${amount}`)
      .join(",");
    const outcomeKey =
      reveal.outcome === "sold"
        ? "event.bidding.sold"
        : reveal.outcome === "tiebreak"
          ? "event.bidding.tiebreak"
          : reveal.outcome === "no_sale"
            ? "event.bidding.noSale"
            : "event.bidding.continue";
    const params: Record<string, string | number> = {
      round: reveal.round,
      bids,
      lockedSeats: "",
    };
    if (reveal.buyerSeatId) params.seat = reveal.buyerSeatId;
    if (reveal.winningBid !== undefined) params.amount = reveal.winningBid;
    events.push({
      id: `reveal:${reveal.kind}:${reveal.round}`,
      revision: reveal.revision ?? 0,
      round: reveal.round,
      sourceKind: "bidding",
      localizationKey: outcomeKey,
      params,
      revealIds: [],
    });
  }

  events.sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));
  return events;
}

function projectIntelRecord(
  state: MatchState,
  record: IntelRecord,
  concealSlotIds: boolean,
): PublicIntelRecordView {
  const fact = record.fact;
  if (fact.kind === "field") {
    const { slotId, ...rest } = fact;
    if (concealSlotIds) {
      const revealId = state.revealTokenBySlot?.[slotId];
      return {
        ...record,
        fact: { ...rest, ...(revealId ? { revealId } : {}) },
      };
    }
    return { ...record, fact: { ...rest, slotId } };
  }
  return { ...record, fact };
}
