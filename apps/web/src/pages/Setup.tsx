import type { MatchView, Strings } from "../types";
import type { MatchConnection } from "../connection";
import { t } from "../i18n";

const ANALYSTS = ["analyst.surveyor", "analyst.cataloger", "analyst.statistician", "analyst.appraiser"];
const KITS = ["kit.survey", "kit.catalog", "kit.appraisal"];

export function SetupPage({
  strings,
  view,
  connection,
}: {
  strings: Strings;
  view: MatchView;
  connection: MatchConnection;
}) {
  const my = view.mySeat;
  const isParticipant = my !== undefined;
  return (
    <main className="setup">
      <h2>{t(strings, "setup.title")}</h2>
      {isParticipant ? (
        <div className="setup-grid">
          <section>
            <h3>{t(strings, "setup.analyst")}</h3>
            <div className="option-list" role="radiogroup">
              {ANALYSTS.map((id) => (
                <button
                  key={id}
                  className={my.analystId === id ? "option selected" : "option"}
                  disabled={my.setupLocked}
                  onClick={() =>
                    connection.sendCommand({
                      type: "select_loadout",
                      analystId: id,
                      toolPackageId: my.toolPackageId ?? KITS[0],
                    })
                  }
                  data-testid={`analyst-${id}`}
                >
                  <strong>{t(strings, `${id}.name`)}</strong>
                  <small>{t(strings, `${id}.desc`)}</small>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3>{t(strings, "setup.toolPackage")}</h3>
            <div className="option-list" role="radiogroup">
              {KITS.map((id) => (
                <button
                  key={id}
                  className={my.toolPackageId === id ? "option selected" : "option"}
                  disabled={my.setupLocked}
                  onClick={() =>
                    connection.sendCommand({
                      type: "select_loadout",
                      analystId: my.analystId ?? ANALYSTS[0],
                      toolPackageId: id,
                    })
                  }
                  data-testid={`kit-${id}`}
                >
                  <strong>{t(strings, `${id}.name`)}</strong>
                  <small>{t(strings, `${id}.desc`)}</small>
                </button>
              ))}
            </div>
          </section>
          <div className="setup-actions">
            {my.setupLocked ? (
              <p>{t(strings, "setup.waitingOthers")}</p>
            ) : (
              <button
                disabled={!my.analystId || !my.toolPackageId}
                onClick={() => connection.sendCommand({ type: "lock_setup" })}
                data-testid="lock-setup"
              >
                {t(strings, "setup.lock")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p>{t(strings, "setup.waitingOthers")}</p>
      )}
    </main>
  );
}
