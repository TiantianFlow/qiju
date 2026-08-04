import { useMemo, useState } from "react";
import type { CatalogItem, Strings } from "../types";
import { t } from "../i18n";

const TIERS = ["documented", "scarce", "exceptional", "singular"] as const;
const CATEGORIES = ["artifact", "geology", "mechanism", "botany", "ephemera", "anomaly"] as const;

export interface CatalogFilterPrefill {
  width?: number;
  height?: number;
  tier?: string;
}

export function CandidateCatalogModal({
  strings,
  catalog,
  open,
  onClose,
  prefill,
}: {
  strings: Strings;
  catalog: CatalogItem[];
  open: boolean;
  onClose: () => void;
  prefill?: CatalogFilterPrefill | null;
}) {
  const [width, setWidth] = useState<number | null>(prefill?.width ?? null);
  const [height, setHeight] = useState<number | null>(prefill?.height ?? null);
  const [tier, setTier] = useState<string>(prefill?.tier ?? "");
  const [category, setCategory] = useState<string>("");

  // Sync when opened with a new prefill.
  useMemo(() => {
    if (!open) return;
    setWidth(prefill?.width ?? null);
    setHeight(prefill?.height ?? null);
    setTier(prefill?.tier ?? "");
  }, [open, prefill?.width, prefill?.height, prefill?.tier]);

  const filtered = useMemo(() => {
    return catalog.filter((item) => {
      if (width !== null && height !== null) {
        const fw = item.footprint.width;
        const fh = item.footprint.height;
        if (!((fw === width && fh === height) || (fw === height && fh === width))) return false;
      }
      if (tier && item.tier !== tier) return false;
      if (category && item.category !== category) return false;
      return true;
    });
  }, [catalog, width, height, tier, category]);

  if (!open) return null;

  return (
    <div className="catalog-overlay" data-testid="catalog-modal" role="dialog" aria-modal="true">
      <div className="catalog-panel">
        <header className="catalog-head">
          <h3>{t(strings, "catalog.title")}</h3>
          <button type="button" onClick={onClose} data-testid="catalog-close" aria-label={t(strings, "catalog.close")}>
            ×
          </button>
        </header>

        <section className="catalog-matrix" aria-label={t(strings, "catalog.footprint")}>
          <div className="matrix-grid" data-testid="catalog-matrix">
            {Array.from({ length: 5 }, (_, row) =>
              Array.from({ length: 5 }, (_, col) => {
                const w = col + 1;
                const h = row + 1;
                const selected = width === w && height === h;
                return (
                  <button
                    key={`${w}x${h}`}
                    type="button"
                    className={selected ? "matrix-cell selected" : "matrix-cell"}
                    data-testid={`catalog-size-${w}x${h}`}
                    aria-pressed={selected}
                    onClick={() => {
                      if (selected) {
                        setWidth(null);
                        setHeight(null);
                      } else {
                        setWidth(w);
                        setHeight(h);
                      }
                    }}
                  >
                    {w}×{h}
                  </button>
                );
              }),
            )}
          </div>
        </section>

        <div className="catalog-filters">
          <label>
            {t(strings, "catalog.tier")}
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              data-testid="catalog-tier-filter"
            >
              <option value="">{t(strings, "catalog.all")}</option>
              {TIERS.map((id) => (
                <option key={id} value={id}>
                  {t(strings, `tier.${id}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(strings, "catalog.category")}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              data-testid="catalog-category-filter"
            >
              <option value="">{t(strings, "catalog.all")}</option>
              {CATEGORIES.map((id) => (
                <option key={id} value={id}>
                  {t(strings, `category.${id}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ul className="catalog-list" data-testid="catalog-list">
          {filtered.length === 0 ? (
            <li className="catalog-empty">{t(strings, "catalog.empty")}</li>
          ) : (
            filtered.map((item) => (
              <li key={item.id} className={`catalog-card tier-${item.tier}`} data-testid={`catalog-item-${item.id}`}>
                <div className="catalog-card-name">{t(strings, `item.${item.id}.name`)}</div>
                <div className="catalog-card-meta">
                  <span>{item.id}</span>
                  <span className={`tier-chip tier-${item.tier}`}>{t(strings, `tier.${item.tier}`)}</span>
                  <span>{t(strings, `category.${item.category}`)}</span>
                  <span>
                    {t(strings, "catalog.size")}: {item.footprint.width}×{item.footprint.height}
                  </span>
                  <span>
                    {t(strings, "catalog.value")}: {item.value.toLocaleString()}
                  </span>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
      <button type="button" className="catalog-backdrop" aria-label={t(strings, "catalog.close")} onClick={onClose} />
    </div>
  );
}
