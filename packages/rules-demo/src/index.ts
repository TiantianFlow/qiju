import {
  canonicalHash,
  registerShapes,
  type CompiledRuleRuntime,
  type RuleBundleManifest,
} from "@qiju/game-core";
import type { ContentSynthetic, ItemDef, ItemId } from "@qiju/game-core";
import { buildContentSyntheticV0, buildContentSyntheticV1, ZH_CN, EN } from "@qiju/content-demo";

function compileContent(content: ContentSynthetic): CompiledRuleRuntime {
  const catalog = new Map<ItemId, ItemDef>();
  for (const item of content.catalog) catalog.set(item.id, item);
  const catalogSorted = [...content.catalog].sort((a, b) => a.id.localeCompare(b.id));

  registerShapes(content.shapes.map((s) => ({ id: s.id, cells: s.cells.map((c) => ({ ...c })) })));

  const manifest: RuleBundleManifest = {
    ruleBundleId: "demo.v0",
    semanticVersion: "0.1.0",
    coreProtocol: 1,
    contentBundleId: content.contentBundleId,
    rngAlgorithm: "rng.xoshiro128ss.v1",
  };

  const contentHash = canonicalHash(content as unknown as Record<string, unknown>);
  const manifestHash = canonicalHash({ ...manifest, contentHash });

  const isV1 = content.contentBundleId === "content.synthetic.v1";

  return {
    manifest,
    manifestHash,
    contentHash,
    config: {
      seats: 4,
      regularRounds: 5,
      maxTiebreakRounds: 1,
      startingBudget: 20000,
      roundMultipliers: [
        { numerator: 2, denominator: 1 },
        { numerator: 8, denominator: 5 },
        { numerator: 13, denominator: 10 },
        { numerator: 11, denominator: 10 },
      ],
    },
    catalog,
    catalogSorted,
    lotPolicy: {
      profiles: content.lotPolicy.profiles.map((p) => ({
        id: p.id,
        drawWeight: p.drawWeight,
        tierWeights: p.tierWeights,
      })),
      themeBoostFactor: content.lotPolicy.themeBoostFactor,
      ...(!isV1 && "slotCount" in content.lotPolicy ? { slotCount: content.lotPolicy.slotCount } : {}),
      ...(isV1 && "countMin" in content.lotPolicy
        ? {
            countMin: content.lotPolicy.countMin,
            countMax: content.lotPolicy.countMax,
            board: { ...content.lotPolicy.board },
          }
        : {}),
    },
    ...(!isV1 && "publicIntelSchedule" in content
      ? {
          publicIntelSchedule: content.publicIntelSchedule.map((e) => ({
            id: e.id,
            selector: e.selector,
          })),
        }
      : {}),
    ...(isV1 && "publicIntelPool" in content
      ? {
          publicIntelPool: content.publicIntelPool.map((e) => ({
            id: e.id,
            weight: e.weight,
            selector: e.selector,
          })),
        }
      : {}),
    analysts: new Map(
      content.analysts.map((a) => [
        a.id,
        {
          id: a.id,
          nameKey: a.nameKey,
          effects: a.effects.map((b) => ({
            trigger: b.trigger,
            effect: { id: b.effect.id, selector: b.effect.selector },
          })),
        },
      ]),
    ),
    toolPackages: new Map(
      content.toolPackages.map((p) => [
        p.id,
        {
          id: p.id,
          nameKey: p.nameKey,
          tools: p.tools.map((t) => ({
            id: t.id,
            nameKey: t.nameKey,
            effect: { id: t.effect.id, selector: t.effect.selector },
          })),
        },
      ]),
    ),
    locale: { "zh-CN": ZH_CN, en: EN },
  };
}

export function compileDemoV0(): CompiledRuleRuntime {
  return compileContent(buildContentSyntheticV0());
}

export function compileDemoV1(): CompiledRuleRuntime {
  return compileContent(buildContentSyntheticV1());
}
