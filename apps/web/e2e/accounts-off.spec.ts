import { test, expect, type Page } from "@playwright/test";

/**
 * THE-58 flag-OFF behavior. Run against a server WITHOUT FEATURE_ACCOUNTS
 * (default): the accounts API 404s, and the UI must degrade cleanly —
 * no console errors, no account entry points, no broken layout, at both
 * desktop and mobile widths and in both locales.
 *
 * Note on console watching: Chromium logs "Failed to load resource: ...404"
 * as a console error for ANY 404 response, including the intentional dark
 * probe of /api/v1/me. Those resource-load lines are the flag working as
 * designed, not console noise; script errors (pageerror) and non-404
 * console errors are what must stay empty.
 */

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Resource-load failures for intentionally-dark endpoints are the
    // expected degradation signal, not noise.
    if (/^Failed to load resource: the server responded with a status of (404|503)/.test(text)) {
      return;
    }
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

async function expectNoAccountsSurface(page: Page, errors: string[]) {
  // The API is dark (beforeEach already skipped otherwise): the server
  // answers 404 for every accounts endpoint.
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(404);
  const board = await page.request.get("/api/v1/leaderboard");
  expect(board.status()).toBe(404);
  const start = await page.request.post("/api/v1/auth/oauth/start", {
    data: { provider: "google" },
    headers: { "X-Lotveil-Request": "oauth" },
  });
  expect(start.status()).toBe(404);

  // Home renders normally with no account row and no console noise.
  await page.goto("/");
  await expect(page.getByTestId("play-vs-ai")).toBeVisible();
  await expect(page.getByTestId("home-account-row")).toHaveCount(0);
  expect(errors).toEqual([]);
}

test.describe("accounts UI while FEATURE_ACCOUNTS is off", () => {
  test.beforeEach(async ({ page }) => {
    // The whole describe only applies against a flag-OFF server; probe the
    // dark API and skip otherwise (the flag-on suite runs in the same pass).
    const me = await page.request.get("/api/v1/me");
    test.skip(me.status() !== 404, "server is not flag-off; accounts-off assertions do not apply");
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile-390", width: 390, height: 844 },
  ] as const) {
    test(`home page degrades cleanly in zh-CN (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const errors = watchConsole(page);
      await expectNoAccountsSurface(page, errors);
      // Geometry: no horizontal overflow of the page itself.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });

    test(`home page degrades cleanly in en (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const errors = watchConsole(page);
      await page.addInitScript(() => localStorage.setItem("lv_locale", "en"));
      await page.goto("/");
      await expect(page.getByTestId("play-vs-ai")).toContainText("Play vs AI");
      await expect(page.getByTestId("home-account-row")).toHaveCount(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }

  test("deep links to /account and /leaderboard stay quiet (no dead buttons, no console noise)", async ({
    page,
  }) => {
    const errors = watchConsole(page);
    for (const path of ["/account", "/leaderboard"]) {
      await page.goto(path);
      // The page renders its shell (back link always present), never an
      // error banner, and the flag-off sign-in attempt fails silently into
      // a retryable notice — not a crash.
      await expect(page.getByTestId(`${path === "/account" ? "account" : "leaderboard"}-page`)).toBeVisible();
      if (path === "/account") {
        // Sign-in is offered optimistically (me is null -> "none" state);
        // starting it against the dark API 404s and shows the retry notice.
        await page.getByTestId("sign-in-google").click();
        await expect(page.getByTestId("sign-in-start-failed")).toBeVisible();
        await page.getByTestId("account-back-home").click();
        await expect(page.getByTestId("play-vs-ai")).toBeVisible();
      } else {
        await expect(page.getByTestId("leaderboard-unavailable")).toBeVisible();
      }
    }
    expect(errors).toEqual([]);
  });
});
