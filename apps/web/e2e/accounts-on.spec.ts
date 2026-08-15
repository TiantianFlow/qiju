import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import pg from "pg";

/**
 * THE-58 flag-ON behavior. Requires a server built WITH FEATURE_ACCOUNTS=true
 * against real local Supabase (E2E_ACCOUNTS_ON=1) plus
 * SUPABASE_SECRET_KEY_E2E / SUPABASE_URL_E2E for account fixture setup;
 * otherwise the suite skips itself.
 *
 * What is NOT exercised here: a real provider roundtrip (no Google
 * credentials locally, and local Supabase has no OAuth provider
 * configured). The start request is asserted on the wire (POST, custom
 * header, JSON body, accepted by the server). Every terminal `auth=`
 * outcome is exercised by loading the frontend the way the server
 * callback 303s to it. Identity, career, leaderboard rendering, isSelf,
 * pagination, and layout geometry run against the REAL stack: account
 * fixtures are permanent auth.users created through the admin API, their
 * careers are real matches played through the UI or real persisted rows.
 */

const ON = process.env.E2E_ACCOUNTS_ON === "1";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3001";
const SUPABASE_URL = process.env.SUPABASE_URL_E2E ?? "http://127.0.0.1:54421";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY_E2E ?? "";
const DATABASE_URL = process.env.DATABASE_URL_E2E ?? "";
const COOKIE_SECRET = process.env.COOKIE_SECRET_E2E ?? "";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

const LOCALES = [
  {
    code: "zh-CN",
    accountHeading: "账户",
    boardHeading: "排行榜",
    guestStatus: "当前是游客身份",
    signIn: "使用 Google 继续",
    headers: { rank: "名次", player: "玩家", rating: "估值师评分", matches: "场次", profit: "累计利润", tier: "大亨段位" },
  },
  {
    code: "en",
    accountHeading: "Account",
    boardHeading: "Leaderboard",
    guestStatus: "Playing as a guest",
    signIn: "Continue with Google",
    headers: { rank: "Rank", player: "Player", rating: "Appraiser rating", matches: "Matches", profit: "Cum. profit", tier: "Tycoon tier" },
  },
] as const;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Resource-load 404/503 lines are Chromium reporting a response status,
    // not script noise (the flag-off probe and the dead local provider URL
    // both legitimately produce them).
    if (/^Failed to load resource: the server responded with a status of \d+/.test(text)) return;
    if (/net::|ERR_FAILED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

function adminClient() {
  if (!SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY_E2E required for the flag-on e2e");
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Direct DB access for fixture-only operations PostgREST cannot do (e.g. is_anonymous flips). */
function dbPool(): pg.Pool {
  if (!DATABASE_URL) throw new Error("DATABASE_URL_E2E required for the flag-on e2e");
  return new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
}

interface AccountFixture {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

async function createPermanentAccount(tag: string): Promise<AccountFixture> {
  const admin = adminClient();
  const password = `the58-${tag}-${Date.now()}-Pw!`;
  const created = await admin.auth.admin.createUser({
    email: `the58-${tag}-${Date.now()}@example.test`,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("createUser failed");
  const signIn = await admin.auth.signInWithPassword({
    email: created.data.user.email!,
    password,
  });
  if (signIn.error || !signIn.data.session) throw signIn.error ?? new Error("signIn failed");
  return {
    email: created.data.user.email!,
    password,
    accessToken: signIn.data.session.access_token,
    refreshToken: signIn.data.session.refresh_token,
  };
}

/**
 * Give the browser the account's session as its lv_session cookie. The
 * cookie is HMAC-signed by the server (Fastify signed cookies, HMAC-SHA256
 * base64 without padding) — the spec signs with the same dev secret the
 * e2e server runs with (COOKIE_SECRET_E2E), which is exactly how the
 * browser "has" a session without a Google roundtrip.
 */
async function adoptSession(page: Page, fixture: AccountFixture) {
  if (!COOKIE_SECRET) throw new Error("COOKIE_SECRET_E2E required for the flag-on e2e");
  // Signing model, verified against the live server: Fastify's cookie
  // parser decodes the header value ONCE, so the HMAC input is the
  // singly-encoded envelope. The wire value carries the envelope
  // DOUBLE-encoded (session.ts encodes; the cookie serializer encodes
  // again). Playwright's addCookies stores the given value verbatim and
  // sends it as-is — so give it the doubly-encoded form the real server
  // emits.
  const envelope = JSON.stringify({
    v: 1,
    access_token: fixture.accessToken,
    refresh_token: fixture.refreshToken,
  });
  const hmacInput = encodeURIComponent(envelope);
  const signature = createHmac("sha256", COOKIE_SECRET)
    .update(hmacInput)
    .digest("base64")
    .replace(/=+$/, "");
  const wireValue = `${encodeURIComponent(hmacInput)}.${signature}`;
  const hostname = new URL(BASE).hostname;
  await page.context().addCookies([
    { name: "lv_session", value: wireValue, domain: hostname, path: "/" },
  ]);
}

/** Insert one completed match with one human seat for the user via PostgREST. */
async function persistMatchFor(
  userId: string,
  tag: string,
  opts: { profit: number; numerator: number; denominator: number; completedAt?: string },
) {
  const admin = adminClient();
  const matchId = `the58-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const match = await admin.from("matches").insert({
    match_id: matchId,
    mode: "human-vs-ai",
    seed: "the58-e2e",
    rule_bundle_id: "rules.demo.v2",
    rule_manifest_hash: "the58-e2e",
    content_hash: "the58-e2e",
    final_state_hash: "the58-e2e",
    completed_at: opts.completedAt ?? new Date().toISOString(),
  });
  if (match.error) throw new Error(`match insert: ${match.error.message}`);
  const seat = await admin.from("match_seats").insert({
    match_id: matchId,
    seat_id: "seat1",
    controller_kind: "human",
    user_id: userId,
    final_wealth: 1_000_000 + opts.profit,
    realized_profit: opts.profit,
    bonus_reward: 0,
    dense_economic_rank: 1,
    utility_numerator: opts.numerator,
    utility_denominator: opts.denominator,
  });
  if (seat.error) throw new Error(`seat insert: ${seat.error.message}`);
}

async function meViaApi(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/v1/me");
    if (!res.ok) return null;
    return (await res.json()) as { principal: string; playerLabel: string | null };
  });
}

async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").textContent()) ?? "";
}

/** Geometry: document never scrolls horizontally, and key regions fit. */
async function expectLayoutGeometry(page: Page, note: string) {
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(docOverflow, `[${note}] document must not scroll horizontally`).toBeLessThanOrEqual(0);
  const vw = page.viewportSize()!.width;
  for (const testId of ["leaderboard-scroll", "leaderboard-pager", "auth-outcome-ok"]) {
    const el = page.getByTestId(testId);
    if ((await el.count()) === 0) continue;
    const box = await el.boundingBox();
    expect(box, `[${note}] ${testId} has a rendered box`).toBeTruthy();
    expect(box!.x, `[${note}] ${testId} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(
      box!.x + box!.width,
      `[${note}] ${testId} ends inside the viewport (x=${box!.x}, w=${box!.width}, vw=${vw})`,
    ).toBeLessThanOrEqual(vw + 0.5);
  }
}

/** Clear the in-memory match flow so static pages render between visits. */
async function resetToHome(page: Page) {
  // After the sign-in start test the browser is stranded on a dead origin
  // (the provider URL cannot resolve locally) where storage is denied —
  // navigate back to the app origin first.
  if (page.url().startsWith(BASE)) {
    await page.evaluate(() => sessionStorage.removeItem("lv_match"));
  } else {
    await page.goto(`${BASE}/`);
    await page.evaluate(() => sessionStorage.removeItem("lv_match"));
  }
}

/** Deterministic pagination fixture: 60 fresh accounts, one match each. */
async function seedPaginationBatch(admin: ReturnType<typeof adminClient>) {
  for (let i = 0; i < 60; i++) {
    const fixture = await createPermanentAccount(`pg-${i}`);
    const { data } = await admin.auth.getUser(fixture.accessToken);
    await persistMatchFor(data.user!.id, `pg-${i}`, { profit: i * 100, numerator: 1, denominator: 4 });
  }
}

test.describe("accounts + leaderboard (FEATURE_ACCOUNTS on)", () => {
  test.skip(!ON, "requires the flag-on server (E2E_ACCOUNTS_ON=1)");

  test.beforeAll(async () => {
    if (!ON) return;
    // One batch covers the pagination test (60 > page size 50). ~60
    // account creations are slow against local Auth; do them once.
    test.setTimeout(600_000);
    await seedPaginationBatch(adminClient());
  });

  test("sign-in start sends the credentialed POST with the custom header and is accepted", async ({
    page,
  }) => {
    const errors = watchConsole(page);
    await page.goto("/account");
    await expect(page.getByTestId("account-principal")).toContainText(/尚未创建身份|No identity yet/);

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes("/api/v1/auth/oauth/start") && req.method() === "POST",
      ),
      page.getByTestId("sign-in-google").click(),
    ]);
    expect(request.headers()["x-lotveil-request"]).toBe("oauth");
    expect(request.headers()["content-type"]).toContain("application/json");
    expect(request.postDataJSON()).toEqual({ provider: "google", returnTo: "/account" });
    // The server accepted the start (the browser then tries to navigate to
    // the provider URL, which cannot resolve locally — irrelevant here).
    // What must NOT happen is the app-level start-failed notice.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("sign-in-start-failed")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("all six auth= callback outcomes render correctly, strip the param, and never replay", async ({
    page,
  }) => {
    const errors = watchConsole(page);
    const copy: Record<string, RegExp> = {
      ok: /登录成功|Signed in successfully/,
      cancelled: /已取消|cancelled/i,
      conflict: /另一个账户|another account/,
      expired: /已过期|expired/i,
      restart: /未完成|didn't complete/i,
      failed: /登录失败|Sign-in failed/,
    };
    for (const outcome of Object.keys(copy)) {
      await resetToHome(page);
      await page.goto(`/account?auth=${outcome}`);
      const notice = page.getByTestId(`auth-outcome-${outcome}`);
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(copy[outcome]!);
      expect(page.url(), "auth= is stripped from the address bar").not.toContain("auth=");
      // Geometry: the notice fits the viewport width (zh-CN conflict copy
      // is the longest).
      const box = await notice.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
      await page.getByTestId("auth-outcome-dismiss").click();
      await expect(notice).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId(`auth-outcome-${outcome}`)).toHaveCount(0);
    }
    // An unknown outcome is stripped without an alarm.
    await page.goto("/account?auth=bogus");
    await expect(page.getByTestId("account-page")).toBeVisible();
    await expect(page.locator("[data-testid^='auth-outcome-']")).toHaveCount(0);
    expect(page.url()).not.toContain("auth=");
    // The conflict notice must NOT read as data loss.
    await page.goto("/account?auth=conflict");
    const conflict = await page.getByTestId("auth-outcome-conflict").textContent();
    expect(conflict).toMatch(/原样保留|still here/);
    expect(conflict).not.toMatch(/丢失|lost|deleted/i);
    expect(errors).toEqual([]);
  });

  test("guest flow: account status, playerLabel, career — and never a raw UUID", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page);
    // Mint a real guest session through the normal UI: creating a
    // human-vs-AI match runs requirePrincipal and mints lv_session.
    await page.goto("/");
    await page.getByRole("button", { name: "种子（可选，用于复现）" }).click();
    await page.getByTestId("seed-input").fill(`the58-guest-${Date.now()}`);
    await page.getByTestId("play-vs-ai").click();
    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
    // The Set-Cookie lands in the browser context before the WS connects;
    // wait for it explicitly rather than racing.
    await expect
      .poll(
        async () => (await page.context().cookies(BASE)).some((c) => c.name === "lv_session"),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Read /api/v1/me through the page's fetch so the browser's cookie jar
    // is what authenticates.
    const me = await meViaApi(page);
    expect(me, "the browser session minted by match creation resolves as a guest").toEqual(
      expect.objectContaining({ principal: "guest" }),
    );
    expect(me?.playerLabel).toMatch(/^Player-[0-9A-F]{6}$/);

    await resetToHome(page);
    await page.goto("/account");
    await expect(page.getByTestId("account-principal")).toContainText("游客");
    await expect(page.getByTestId("account-player-label")).toContainText(me!.playerLabel!);
    await expect(page.getByTestId("sign-in-google")).toBeVisible();
    // Career section exists for a guest (the cookie is a real principal);
    // zero matches so far is fine — the panel must render, not error.
    await expect(page.getByTestId("account-career")).toBeVisible();
    expect(await bodyText(page)).not.toMatch(UUID_RE);
    expect(errors).toEqual([]);
  });

  test("account status for a converted (permanent) session; guests excluded from the leaderboard; isSelf highlighted", async ({
    page,
  }) => {
    const errors = watchConsole(page);
    const fixture = await createPermanentAccount("self");
    // This account owns one real persisted match row, played WELL (positive
    // utility) so it is unambiguously the top-rated row on the board.
    const admin = adminClient();
    const { data: userData } = await admin.auth.getUser(fixture.accessToken);
    const userId = userData.user!.id;
    await persistMatchFor(userId, "self", { profit: 5000, numerator: 2, denominator: 2 });

    // A second account is flipped to anonymous (a guest) and given rows —
    // it must never appear on the board. The direct SQL update exercises
    // the server's literal `is_anonymous IS FALSE` exclusion. (PostgREST
    // cannot reach auth.users; this is the same flip the server's own
    // migration contract tests use.)
    const guestFixture = await createPermanentAccount("guestx");
    const { data: guestData } = await admin.auth.getUser(guestFixture.accessToken);
    const guestId = guestData.user!.id;
    await persistMatchFor(guestId, "guestx", { profit: 999_999, numerator: 1, denominator: 1 });
    const pool = dbPool();
    try {
      await pool.query("update auth.users set is_anonymous = true where id = $1", [guestId]);
    } finally {
      await pool.end();
    }

    await adoptSession(page, fixture);
    await page.goto("/account");
    await expect(page.getByTestId("account-page")).toBeVisible();
    const me = await meViaApi(page);
    expect(me?.principal).toBe("account");
    expect(me?.playerLabel).toMatch(/^Player-[0-9A-F]{6}$/);
    await expect(page.getByTestId("account-principal")).toContainText(/已登录|Signed in/);
    await expect(page.getByTestId("account-player-label")).toContainText(me!.playerLabel!);
    // A permanent account does not need another sign-in button.
    await expect(page.getByTestId("sign-in-google")).toHaveCount(0);
    // Career shows the persisted match.
    await expect(page.getByTestId("career-matches")).toContainText("1", { timeout: 15_000 });
    expect(await bodyText(page)).not.toMatch(UUID_RE);

    // Leaderboard: the account row renders with isSelf; the guest fixture
    // (anonymous, with rows) never appears. guestId is used below.
    await page.goto("/leaderboard");
    await expect(page.getByTestId("leaderboard-table")).toBeVisible({ timeout: 15_000 });
    const boardText = await page.getByTestId("leaderboard-table").textContent();
    expect(boardText).toContain(me!.playerLabel!);
    // isSelf: the account's own row is highlighted and badged.
    await expect(page.getByTestId("leaderboard-self-badge")).toBeVisible();
    const selfRow = page.locator("tr.is-self");
    await expect(selfRow).toHaveCount(1);
    await expect(selfRow).toContainText(me!.playerLabel!);
    // Tier column renders the server-provided tier string on that row.
    await expect(selfRow).toContainText(/Novice Bidder|Savvy Appraiser|Master Dealer|Grand Auctioneer/);
    // The guest's UUID must never be on the page (and guests are excluded
    // server-side, so no row exists for them at all).
    expect(boardText).not.toContain(guestId);
    expect(await bodyText(page)).not.toMatch(UUID_RE);
    expect(errors).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    for (const locale of LOCALES) {
      test(`geometry: leaderboard fits ${viewport.name} in ${locale.code}`, async ({ page }) => {
        const errors = watchConsole(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript((l) => localStorage.setItem("lv_locale", l), locale.code);
        await page.goto("/leaderboard");
        await expect(page.getByRole("heading", { level: 1 })).toContainText(locale.boardHeading);
        // Wait for data or the empty state; geometry assertions then hold.
        await expect(
          page
            .getByTestId("leaderboard-scroll")
            .or(page.getByTestId("leaderboard-empty"))
            .or(page.getByTestId("leaderboard-unavailable")),
        ).toBeVisible({ timeout: 15_000 });
        await expectLayoutGeometry(page, `${viewport.name}/${locale.code}`);
        // At 390px the table keeps a sane minimum width and scrolls inside
        // its own region; at desktop the full width is on screen. Both are
        // asserted explicitly (this is the THE-9 clipping class).
        const scrollBox = await page.getByTestId("leaderboard-scroll").boundingBox();
        expect(
          scrollBox!.x + scrollBox!.width,
          `scroll region inside ${viewport.width}px (got x=${scrollBox!.x} w=${scrollBox!.width})`,
        ).toBeLessThanOrEqual(viewport.width + 0.5);
        // Headers in this locale are visible (i.e. the columns exist).
        for (const header of Object.values(locale.headers)) {
          await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
        }
        expect(errors).toEqual([]);
      });

      test(`geometry: account page fits ${viewport.name} in ${locale.code}`, async ({ page }) => {
        const errors = watchConsole(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript((l) => localStorage.setItem("lv_locale", l), locale.code);
        // zh-CN conflict copy is the longest string on this page; load it
        // through the callback URL the way the server 303s back.
        await page.goto("/account?auth=conflict");
        await expect(page.getByRole("heading", { level: 1 })).toContainText(locale.accountHeading);
        await expect(page.getByTestId("auth-outcome-conflict")).toBeVisible();
        await expect(page.getByTestId("sign-in-google")).toContainText(locale.signIn);
        const notice = page.getByTestId("auth-outcome-conflict");
        const box = await notice.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
        await expectLayoutGeometry(page, `${viewport.name}/${locale.code} account`);
        expect(errors).toEqual([]);
      });
    }
  }

  test("leaderboard pagination: prev/next navigate offsets", async ({ page }) => {
    const errors = watchConsole(page);
    // The beforeAll batch (60 accounts × 1 match) guarantees two pages at
    // page size 50 — nothing to seed here.
    await page.goto("/leaderboard");
    await expect(page.getByTestId("leaderboard-row-1")).toBeVisible({ timeout: 30_000 });
    const firstTop = await page.getByTestId("leaderboard-row-1").textContent();
    await expect(page.getByTestId("leaderboard-prev")).toBeDisabled();
    const status1 = await page.getByTestId("leaderboard-page-status").textContent();
    expect(status1).toMatch(/1[–-]50/);
    await page.getByTestId("leaderboard-next").click();
    const status2 = await page.getByTestId("leaderboard-page-status").textContent();
    expect(status2).toMatch(/51[–-]\d+/);
    const secondTop = await page.getByTestId("leaderboard-row-51").textContent();
    expect(secondTop).not.toBe(firstTop);
    await page.getByTestId("leaderboard-prev").click();
    await expect(page.getByTestId("leaderboard-page-status")).toContainText(/1[–-]50/);
    await expect(page.getByTestId("leaderboard-prev")).toBeDisabled();
    expect(await bodyText(page)).not.toMatch(UUID_RE);
    expect(errors).toEqual([]);
  });
});
