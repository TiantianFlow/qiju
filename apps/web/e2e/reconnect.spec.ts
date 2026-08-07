import { test, expect } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";

const STREAM_URL = /\/api\/v1\/matches\/[^/]+\/stream/;

async function startHumanMatchAndReachBidWindow(page: Page) {
  await page.goto("/");
  await page.getByTestId("play-vs-ai").click();
  await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("analyst-analyst.surveyor").click();
  await page.getByTestId("kit-kit.survey").click();
  await page.getByTestId("lock-setup").click();
  await expect(page.getByTestId("bid-input")).toBeVisible({ timeout: 30_000 });
}

test.describe("reconnect and secrecy", () => {
  test("reloading mid-match restores the correct seat view", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();
    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("analyst-analyst.surveyor").click();
    await page.getByTestId("kit-kit.survey").click();
    await page.getByTestId("lock-setup").click();

    await expect(page.getByTestId("bid-input")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("bid-input").fill("1000");
    await page.getByTestId("submit-bid").click();
    await expect(page.getByText(/你的报价: 1,000|Your bid: 1,000/)).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("bid-input")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/你的报价: 1,000|Your bid: 1,000/)).toBeVisible();
  });

  test("a stranger cannot read another guest's seat view", async ({ page, context }) => {
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();
    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
    const url = page.url();
    await context.clearCookies();
    const response = await page.request.get(url.replace(page.url().split("/").slice(0, 3).join("/"), ""));
    void response;
    const matchId = (await page.evaluate(() => sessionStorage.getItem("lv_match")))!;
    const id = JSON.parse(matchId).matchId as string;
    const res = await page.request.get(`/api/v1/matches/${id}/view`);
    expect([403, 404]).toContain(res.status());
  });

  test("auto-reconnects after a dropped socket and resyncs without a reload", async ({ page }) => {
    test.setTimeout(120_000);
    let connections = 0;
    let holdUntil = 0;
    let liveServer: WebSocketRoute | null = null;
    await page.routeWebSocket(STREAM_URL, async (ws) => {
      connections += 1;
      // While the "network" is held down, every reconnect attempt fails fast
      // with a recoverable (non-40xx) close, exercising the backoff loop.
      if (Date.now() < holdUntil) {
        ws.close({ code: 1000 });
        return;
      }
      liveServer = await ws.connectToServer();
    });

    await startHumanMatchAndReachBidWindow(page);
    await page.getByTestId("bid-input").fill("1000");
    await page.getByTestId("submit-bid").click();
    await expect(page.getByText(/你的报价: 1,000|Your bid: 1,000/)).toBeVisible();
    // Lock the bid so the round can resolve server-side while we are offline.
    await page.getByTestId("lock-bid").click();
    await page.evaluate(() => ((window as unknown as { __marker: string }).__marker = "no-reload"));

    // Drop the live socket mid-session and keep the network down for ~3s so
    // the match advances while the client is disconnected.
    holdUntil = Date.now() + 3000;
    liveServer!.close({ code: 1000 });

    // Automatic recovery: reconnect + resync, no manual reload. Round 1 has
    // resolved during the gap, so the history table gained a row the client
    // never saw pushed live.
    await expect(page.locator(".history tbody tr").first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => connections, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    const marker = await page.evaluate(() => (window as unknown as { __marker?: string }).__marker);
    expect(marker).toBe("no-reload");
    expect(page.url()).toContain("/");
  });

  test("replays a bid whose acknowledgement was lost during the disconnect", async ({ page }) => {
    test.setTimeout(120_000);
    let ackDropped = false;
    await page.routeWebSocket(STREAM_URL, async (ws) => {
      const server = await ws.connectToServer();
      ws.onMessage((message) => {
        server.send(message);
        const text = typeof message === "string" ? message : String(message);
        if (!ackDropped && text.includes('"submit_bid"')) {
          ackDropped = true;
          // Forward the bid to the server, then kill the page side before the
          // command_accepted envelope can arrive — a lost acknowledgement.
          ws.close({ code: 1000 });
        }
      });
    });

    await startHumanMatchAndReachBidWindow(page);
    await page.evaluate(() => ((window as unknown as { __marker: string }).__marker = "no-reload"));
    await page.getByTestId("bid-input").fill("1000");
    await page.getByTestId("submit-bid").click();

    // The bid was neither lost nor duplicated: after the automatic reconnect
    // replays the original commandId, the UI and the server agree on 1,000.
    await expect(page.getByText(/你的报价: 1,000|Your bid: 1,000/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("p.error")).toHaveCount(0);
    const marker = await page.evaluate(() => (window as unknown as { __marker?: string }).__marker);
    expect(marker).toBe("no-reload");

    const stored = (await page.evaluate(() => sessionStorage.getItem("lv_match")))!;
    const matchId = JSON.parse(stored).matchId as string;
    const res = await page.request.get(`/api/v1/matches/${matchId}/view`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { view: { mySeat?: { currentBid?: number } } };
    expect(body.view.mySeat?.currentBid).toBe(1000);
  });
});
