import { useCallback, useEffect, useState } from "react";
import type { CatalogItem, Locale, Strings } from "./types";
import { detectLocale, t } from "./i18n";
import { API_BASE_URL, withApiCredentials } from "./config";
import { MatchConnection } from "./connection";
import { useConnection } from "./hooks";
import { consumeAuthOutcome, fetchMe, type AuthOutcome, type MeResponse } from "./auth";
import { withAccountStrings } from "./accountStrings";
import { HomePage } from "./pages/Home";
import { SetupPage } from "./pages/Setup";
import { TablePage } from "./pages/Table";
import { ResultPage } from "./pages/Result";
import { DemoControls } from "./pages/DemoControls";
import { AccountPage } from "./pages/Account";
import { LeaderboardPage } from "./pages/Leaderboard";

interface ActiveMatch {
  matchId: string;
  mode: "human-vs-ai" | "all-ai";
  seed: string;
}

/** Static pages reachable via path, in addition to the in-memory match flow. */
type StaticRoute = "home" | "account" | "leaderboard";

function routeFromPath(pathname: string): StaticRoute {
  if (pathname === "/account") return "account";
  if (pathname === "/leaderboard") return "leaderboard";
  return "home";
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Display-identity guard (THE-39 design, binding): the UI must never render
 * a raw auth UUID. A malformed server playerLabel is dropped, not shown.
 */
function sanitizeMe(me: MeResponse | null): MeResponse | null {
  if (me && me.playerLabel !== null && UUID_RE.test(me.playerLabel)) {
    return { principal: me.principal, playerLabel: null };
  }
  return me;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const [serverStrings, setServerStrings] = useState<Strings>({});
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [productName, setProductName] = useState({ "zh-CN": "奇局", en: "Qiju" });
  const [allowFixedSeed, setAllowFixedSeed] = useState(true);
  const [active, setActive] = useState<ActiveMatch | null>(() => {
    const stored = sessionStorage.getItem("lv_match");
    return stored ? (JSON.parse(stored) as ActiveMatch) : null;
  });
  const [connection, setConnection] = useState<MatchConnection | null>(null);

  // THE-58: route + accounts state. `me` stays null while the feature is
  // dark (404) — every account surface degrades on that.
  const [route, setRoute] = useState<StaticRoute>(() =>
    routeFromPath(window.location.pathname),
  );
  const [authOutcome, setAuthOutcome] = useState<AuthOutcome | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [leaderboardOffset, setLeaderboardOffset] = useState(0);

  const refreshMe = useCallback(async () => {
    setMe(sanitizeMe(await fetchMe()));
  }, []);

  // One-shot auth= outcome from the OAuth callback's 303; strip it from the
  // address bar immediately so a refresh can't replay it.
  useEffect(() => {
    const { outcome, cleanUrl } = consumeAuthOutcome(
      window.location.search,
      window.location.pathname,
    );
    if (cleanUrl !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", cleanUrl);
    }
    setAuthOutcome(outcome);
    void refreshMe();
  }, [refreshMe]);

  const navigate = useCallback(
    (path: string) => {
      setAuthOutcome(null);
      setRoute(routeFromPath(path));
      window.history.pushState(null, "", path);
      if (path === "/account" || path === "/leaderboard") void refreshMe();
      window.scrollTo(0, 0);
    },
    [refreshMe],
  );

  // Browser back/forward between the static pages.
  useEffect(() => {
    const onPop = () => {
      setAuthOutcome(null);
      setRoute(routeFromPath(window.location.pathname));
      void refreshMe();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [refreshMe]);

  useEffect(() => {
    void (async () => {
      const capRes = await fetch(`${API_BASE_URL}/api/v1/capabilities`, withApiCredentials());
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
      const localeRes = await fetch(
        `${API_BASE_URL}/api/v1/content/${contentBundleId}/${locale}`,
        withApiCredentials(),
      );
      if (localeRes.ok) {
        const data = (await localeRes.json()) as { strings: Strings; catalog?: CatalogItem[] };
        setServerStrings(data.strings);
        setCatalog(data.catalog ?? []);
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
    navigate("/");
  };

  // Server content plus local THE-58 account strings; account keys never
  // come from the server bundle (packages/** is outside this ticket).
  const strings = withAccountStrings(serverStrings, locale);

  if (Object.keys(serverStrings).length === 0) {
    return <p>{t(strings, "common.loading")}</p>;
  }

  if (!active || !connection) {
    if (route === "account") {
      return (
        <div className="app-shell page-shell">
          <AccountPage
            strings={strings}
            locale={locale}
            me={me}
            outcome={authOutcome}
            onNavigate={navigate}
            onOutcomeConsumed={() => setAuthOutcome(null)}
          />
        </div>
      );
    }
    if (route === "leaderboard") {
      return (
        <div className="app-shell page-shell">
          <LeaderboardPage
            strings={strings}
            locale={locale}
            offset={leaderboardOffset}
            onOffset={setLeaderboardOffset}
            onNavigate={navigate}
          />
        </div>
      );
    }
    return (
      <div className="app-shell home-shell">
        <HomePage
          strings={strings}
          locale={locale}
          onLocale={setLocale}
          onCreated={(matchId, mode, seed) => setActive({ matchId, mode, seed })}
          allowFixedSeed={allowFixedSeed}
          productName={productName}
          me={me}
          onNavigate={navigate}
        />
      </div>
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
  const immersive = view.phase !== "setup" && view.phase !== "completed";

  return (
    <div className={immersive ? "app-shell game-shell" : "app-shell"}>
      {!connection.connected ? <p className="offline">{t(strings, "error.connection")}</p> : null}
      {isObserver && view.phase !== "completed" ? (
        <DemoControls strings={strings} connection={connection} seed={active.seed} />
      ) : null}
      {view.phase === "setup" && !isObserver ? (
        <SetupPage strings={strings} view={view} connection={connection} />
      ) : view.phase === "completed" ? (
        <ResultPage strings={strings} locale={locale} view={view} onRestart={goHome} catalog={catalog} />
      ) : (
        <TablePage
          strings={strings}
          locale={locale}
          view={view}
          connection={connection}
          isObserver={isObserver}
          seed={active.seed}
          catalog={catalog}
        />
      )}
    </div>
  );
}
