import { buildContentSyntheticV0 } from "./content.js";
import { ZH_CN, EN, validateLocales } from "./locale.js";

export function buildFixtures() {
  return {
    "content.low-total": {
      itemIds: [
        "syn.artifact.documented",
        "syn.geology.documented",
        "syn.mechanism.documented",
        "syn.botany.documented",
        "syn.ephemera.documented",
        "syn.anomaly.documented",
        "syn.artifact.scarce",
        "syn.geology.scarce",
        "syn.mechanism.scarce",
        "syn.botany.scarce",
      ],
      expectedTotal: 3130,
    },
    "content.high-total": {
      itemIds: [
        "syn.artifact.singular",
        "syn.geology.singular",
        "syn.mechanism.singular",
        "syn.botany.singular",
        "syn.ephemera.singular",
        "syn.anomaly.singular",
        "syn.mechanism.exceptional",
        "syn.botany.exceptional",
        "syn.ephemera.exceptional",
        "syn.anomaly.exceptional",
      ],
      expectedTotal: 33930,
    },
  } as const;
}

export { buildContentSyntheticV0, ZH_CN, EN, validateLocales };
export * from "./content.js";
export * from "./locale.js";
