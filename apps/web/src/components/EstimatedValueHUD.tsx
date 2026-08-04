import type { Strings } from "../types";
import { t } from "../i18n";

export function EstimatedValueHUD({
  strings,
  round,
  phase,
  estimatedValue,
  remainingSeconds,
}: {
  strings: Strings;
  round: number;
  phase: string;
  estimatedValue: number;
  remainingSeconds: number | null;
}) {
  const roundLabel =
    phase === "tiebreak" ? t(strings, "table.tiebreak") : t(strings, "hud.round", { round });

  return (
    <section className="value-hud" data-testid="value-hud" aria-label={t(strings, "hud.estimatedValue")}>
      <div className="value-hud-round">{roundLabel}</div>
      {remainingSeconds !== null ? (
        <div className="value-hud-timer" role="timer" data-testid="deadline">
          {t(strings, "table.deadline", { seconds: remainingSeconds })}
        </div>
      ) : (
        <div className="value-hud-timer muted" data-testid="hud-deadline-idle">
          —
        </div>
      )}
      <div className="value-hud-estimate">
        <span className="value-hud-label">{t(strings, "hud.estimatedValue")}</span>
        <strong data-testid="hud-estimated-value">{estimatedValue.toLocaleString()}</strong>
        <details className="value-hud-hint">
          <summary aria-label={t(strings, "hud.estimatedHint")}>?</summary>
          <p>{t(strings, "hud.estimatedHint")}</p>
        </details>
      </div>
    </section>
  );
}
