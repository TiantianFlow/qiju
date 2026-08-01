import { useEffect, useState } from "react";
import type { Locale, Strings } from "./types";
import { detectLocale, t } from "./i18n";
import { MatchConnection } from "./connection";
import { useConnection } from "./hooks";
import { HomePage } from "./pages/Home";
import { SetupPage } from "./pages/Setup";
import { TablePage } from "./pages/Table";
import { ResultPage } from "./pages/Result";
import { DemoControls } from "./pages/DemoControls";

interface ActiveMatch {
  matchId: string;
  mode: "human-vs-ai" | "all-ai";
  seed: string;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const [strings, setStrings] = useState<Strings>({});
  const [productName, setProductName] = useState({ "zh-CN": "奇局", en: "Qiju" });
  const [allowFixedSeed, setAllowFixedSeed] = useState(true);
  const [active, setActive] = useState<ActiveMatch | null>(() => {
    const stored = sessionStorage.getItem("lv_match");
    return stored ? (JSON.parse(stored) as ActiveMatch) : null;
  });
  const [connection, setConnection] = useState<MatchConnection | null>(null);

  useEffect(() => {
    void (async () => {
      const capRes = await fetch("/api/v1/capabilities");
      let contentBundleId = "content.synthetic.v2";
      if (capRes.ok) {
        const cap = (await capRes.json()) as {
          productName: { "zh-CN": string; en: string };
          allowFixedSeed: boolean;
          contentBundleId?: string;
        };
        setProductName(cap.productName);
        setAllowFixedSeed(cap.allowFixedSeed);
        if (cap.contentBundleId) contentBundleId = cap.contentBundleId;
      }
      const localeRes = await fetch(`/api/v1/content/${contentBundleId}/${locale}`);
      if (localeRes.ok) {
        const data = (await localeRes.json()) as { strings: Strings };
        setStrings(data.strings);
      }
    })();
  }, [locale]);

  useEffect(() => {
    if (!active) {
      setConnection(null);
      return;
    }
    sessionStorage.setItem("lv_match", JSON.stringify(active));
    const conn = new MatchConnection(active.matchId);
    conn.connect();
    setConnection(conn);
    return () => conn.close();
  }, [active]);

  useConnection(connection);

  const goHome = () => {
    sessionStorage.removeItem("lv_match");
    setActive(null);
  };

  if (Object.keys(strings).length === 0) {
    return <p>{t(strings, "common.loading")}</p>;
  }

  if (!active || !connection) {
    return (
      <HomePage
        strings={strings}
        locale={locale}
        onLocale={setLocale}
        onCreated={(matchId, mode, seed) => setActive({ matchId, mode, seed })}
        allowFixedSeed={allowFixedSeed}
        productName={productName}
      />
    );
  }

  if (connection.fatal) {
    return (
      <main className="fatal" role="alert">
        <p>{t(strings, "error.fatal")}</p>
        <button onClick={goHome} data-testid="back-home">
          {t(strings, "error.backHome")}
        </button>
      </main>
    );
  }

  const view = connection.view;
  if (!view) {
    return (
      <main>
        <p>{t(strings, connection.connected ? "common.loading" : "error.connection")}</p>
      </main>
    );
  }

  const isObserver = active.mode === "all-ai";

  return (
    <>
      {!connection.connected ? <p className="offline">{t(strings, "error.connection")}</p> : null}
      {isObserver && view.phase !== "completed" ? (
        <DemoControls strings={strings} connection={connection} seed={active.seed} />
      ) : null}
      {view.phase === "setup" && !isObserver ? (
        <SetupPage strings={strings} view={view} connection={connection} />
      ) : view.phase === "completed" ? (
        <ResultPage strings={strings} view={view} onRestart={goHome} />
      ) : (
        <TablePage
          strings={strings}
          view={view}
          connection={connection}
          isObserver={isObserver}
          seed={active.seed}
        />
      )}
    </>
  );
}
