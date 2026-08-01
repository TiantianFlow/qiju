import type { Strings } from "../types";
import type { MatchConnection } from "../connection";
import { t } from "../i18n";

export function DemoControls({
  strings,
  connection,
  seed,
}: {
  strings: Strings;
  connection: MatchConnection;
  seed: string | null;
}) {
  return (
    <div className="demo-controls" data-testid="demo-controls">
      {connection.demo.paused ? (
        <button onClick={() => connection.sendDemoControl("demo_resume")} data-testid="demo-resume">
          {t(strings, "demo.resume")}
        </button>
      ) : (
        <button onClick={() => connection.sendDemoControl("demo_pause")} data-testid="demo-pause">
          {t(strings, "demo.pause")}
        </button>
      )}
      <button onClick={() => connection.sendDemoControl("demo_step")} data-testid="demo-step">
        {t(strings, "demo.step")}
      </button>
      <label>
        {t(strings, "demo.speed")}
        <select
          value={connection.demo.speed}
          onChange={(e) => connection.sendDemoControl("demo_set_speed", Number(e.target.value))}
          data-testid="demo-speed"
        >
          {[1, 2, 4, 8].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      {seed ? (
        <button
          onClick={() => void navigator.clipboard?.writeText(seed)}
          data-testid="demo-copy-seed"
        >
          {t(strings, "demo.copySeed")}
        </button>
      ) : null}
    </div>
  );
}
