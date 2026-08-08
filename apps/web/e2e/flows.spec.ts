import { test, expect, type Page } from "@playwright/test";

async function openSeededDemo(page: Page, seed: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "种子（可选，用于复现）" }).click();
  await page.getByTestId("seed-input").fill(seed);
  await page.getByTestId("watch-demo").click();
  await expect(page.getByTestId("demo-controls")).toBeVisible({ timeout: 15_000 });
}

async function openSeededHuman(page: Page, seed: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "种子（可选，用于复现）" }).click();
  await page.getByTestId("seed-input").fill(seed);
  await page.getByTestId("play-vs-ai").click();
  await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
}

async function submitAndLockBid(page: Page, amount: string) {
  const bidInput = page.getByTestId("bid-input");
  await expect(bidInput).toBeVisible({ timeout: 20_000 });
  await bidInput.fill(amount);
  await page.getByTestId("submit-bid").click();
  await expect(page.getByTestId("lock-bid")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("lock-bid").click();
}

test.describe("home page", () => {
  test("shows zh-CN by default and can switch to English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("奇局");
    await expect(page.getByTestId("play-vs-ai")).toBeVisible();
    await expect(page.getByTestId("watch-demo")).toBeVisible();
    await page.getByTestId("locale-select").selectOption("en");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Qiju");
    await expect(page.getByTestId("play-vs-ai")).toContainText("Play vs AI");
  });

  test("language switch does not lose page state", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("locale-select").selectOption("en");
    await page.getByTestId("locale-select").selectOption("zh-CN");
    await expect(page.getByTestId("play-vs-ai")).toContainText("对战 AI");
  });
});

test.describe("human vs AI match", () => {
  test("complete a full sold match from home to result with fixed seed", async ({ page }) => {
    test.setTimeout(180_000);
    // Round-5: re-pinned after the high-variance v2 catalog rework changed
    // per-seed lot contents/values (see catalog-v2.test.ts for the new
    // 41-item table); "sold-seed-a" is a fresh deterministic sold outcome.
    await openSeededHuman(page, "sold-seed-a");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    for (let round = 0; round < 8; round++) {
      if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
      const bidInput = page.getByTestId("bid-input");
      // Wait for the next actionable state. isVisible() never auto-waits, so a
      // round view that unmounts mid-poll cannot hang the predicate.
      await expect
        .poll(
          async () => {
            if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
            if (await bidInput.isVisible().catch(() => false)) return "bidding";
            return "transition";
          },
          { timeout: 30_000 },
        )
        .not.toBe("transition");
      if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
      // The state observed above can still be invalidated by a round
      // transition before the actions land (check-then-act). The only
      // legitimate invalidation is the match completing; anything else is a
      // genuine failure and rethrows.
      try {
        await submitAndLockBid(page, "0");
      } catch (err) {
        if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
        throw err;
      }
      const hud = page.getByTestId("value-hud");
      // Bounded reads only: value-hud is gone for good once the result page
      // mounts, so an unbounded textContent() here or in the poll below can
      // hang the predicate until the poll timeout (observed on CI runners).
      const before = await hud.textContent({ timeout: 5_000 }).catch(() => null);
      if (before === null) {
        // Transitioned before the HUD could be sampled; resync next round.
        if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
        continue;
      }
      await expect
        .poll(
          async () => {
            if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
            // Mid-transition the HUD is detached: report "unchanged" and let
            // the poll re-check, instead of auto-waiting forever.
            return (await hud.textContent({ timeout: 1_000 }).catch(() => null)) ?? before;
          },
          { timeout: 45_000 },
        )
        .not.toBe(before);
    }

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("result-board")).toBeVisible();
    await expect(page.getByTestId("result-sold")).toBeVisible();
    await expect(page.getByTestId("result-buyer")).toHaveText("seat2");
    // Pinned to prove determinism: the same seed must always produce the same
    // winning bid. Expect this value to change whenever agent bid math changes
    // — THE-10 moved it (expected-value base), THE-23 moved it again
    // (per-round budget-exposure cap), THE-35 moved it again (new V2 board
    // policy fields changed the content hash, reseeding every engine RNG
    // stream; the seed still settles sold with buyer seat2). Re-pin, don't
    // loosen: a range assertion here would stop detecting the non-determinism
    // this exists to catch.
    await expect(page.getByTestId("result-winning-bid")).toHaveText("339,990");
    await page.getByTestId("restart").click();
    await expect(page.getByTestId("play-vs-ai")).toBeVisible();
  });

  test("no-sale demo seed reaches inspectable result board", async ({ page }) => {
    test.setTimeout(180_000);
    // Round-5: re-pinned — the high-variance v2 catalog rework changed lot
    // contents/values enough that the old seed now resolves to a sale.
    // THE-35: re-pinned again — the new V2 board policy fields changed the
    // content hash and reseeded the RNG streams, flipping "nosale-demo-c" to a
    // sale. "nosale-demo-a" is verified (headless scan with the server's exact
    // all-AI agent pool) to end in a genuine tiebreak_tie no-sale.
    await openSeededDemo(page, "nosale-demo-a");
    await page.getByTestId("demo-speed").selectOption("8");
    await page.getByTestId("demo-resume").click();
    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("result-nosale")).toBeVisible();
    await expect(page.getByTestId("result-board")).toBeVisible();
    const cards = page.getByTestId("result-board").locator(".object-card");
    expect(await cards.count()).toBeGreaterThanOrEqual(8);
    await cards.first().click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
  });

  test("human round timer starts near 120 seconds and counts down without jumping back", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededHuman(page, "timer-seed-1");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    await expect(page.getByTestId("deadline")).toBeVisible({ timeout: 20_000 });
    const readSeconds = async () =>
      Number(((await page.getByTestId("deadline").textContent()) ?? "").replace(/\D+/g, ""));
    const first = await readSeconds();
    expect(first).toBeGreaterThanOrEqual(115);
    expect(first).toBeLessThanOrEqual(120);
    await page.waitForTimeout(2_500);
    const later = await readSeconds();
    expect(later).toBeLessThan(first);
    expect(later).toBeGreaterThan(first - 8);
  });

  test("over-budget bid is visibly capped to the budget and the notice clears on the next in-budget bid", async ({ page }) => {
    test.setTimeout(90_000);
    await openSeededHuman(page, "bid-cap-seed-1");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    const bidInput = page.getByTestId("bid-input");
    await expect(bidInput).toBeVisible({ timeout: 20_000 });

    // 10M with a 2M budget: submitted at the cap, input synced, notice shown.
    await bidInput.fill("10000000");
    await page.getByTestId("submit-bid").click();
    const capNotice = page.getByTestId("bid-cap-notice");
    await expect(capNotice).toBeVisible();
    await expect(capNotice).toHaveText("已按预算上限截断为 2,000,000");
    await expect(bidInput).toHaveValue("2000000");
    await expect(page.locator(".current-bid strong")).toHaveText("2,000,000");

    // A subsequent in-budget bid goes through unchanged and clears the notice.
    await bidInput.fill("500000");
    await page.getByTestId("submit-bid").click();
    await expect(capNotice).toHaveCount(0);
    await expect(bidInput).toHaveValue("500000");
    await expect(page.locator(".current-bid strong")).toHaveText("500,000");
  });

  test("player HUD persistently shows the chosen analyst and the budget (THE-9)", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededHuman(page, "player-hud-seed-1");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    await expect(page.getByTestId("bid-input")).toBeVisible({ timeout: 20_000 });
    const analystName = page.getByTestId("player-hud-analyst-name");
    await expect(analystName).toHaveText("估价师");
    // The analyst's description rides on the chip as a tooltip.
    await expect(analystName).toHaveAttribute("title", /拍卖开始/);
    await expect(page.getByTestId("player-hud-budget-value")).toHaveText("2,000,000");

    // Tap path: the opened description popover must stay fully inside the
    // viewport (the shared hint CSS right-anchors it, which clipped it off
    // the left edge before the player-hud-scoped override).
    const hint = page.locator(".player-hud .value-hud-hint");
    await hint.locator("summary").click();
    const popover = hint.locator("p");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("拍卖开始");
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    const viewportWidth = page.viewportSize()!.width;
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
  });

  // Same both-edges-inside-viewport property as the desktop assertion above,
  // but across width × locale: left-anchoring the popover to the hint icon
  // clipped the right edge at 390px (worse in English, where the wider
  // "Analyst Appraiser" label pushes the icon further right). One test per
  // combination — a fresh context each, since an in-progress match survives
  // page.goto("/") via the reconnect flow.
  for (const width of [1280, 390]) {
    for (const locale of ["zh-CN", "en"] as const) {
      test(`analyst description popover stays inside the viewport at ${width}px (${locale}) (THE-9)`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 720 });
        await page.goto("/");
        await page.getByTestId("locale-select").selectOption(locale);
        await page.locator(".seed-row button").click();
        await page.getByTestId("seed-input").fill(`player-hud-pop-${locale}-${width}`);
        await page.getByTestId("play-vs-ai").click();
        await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
        await page.getByTestId("analyst-analyst.appraiser").click();
        await page.getByTestId("kit-kit.appraisal").click();
        await page.getByTestId("lock-setup").click();
        await expect(page.getByTestId("bid-input")).toBeVisible({ timeout: 20_000 });

        const hint = page.locator(".player-hud .value-hud-hint");
        await hint.locator("summary").click();
        const popover = hint.locator("p");
        await expect(popover).toBeVisible();
        const box = await popover.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      });
    }
  }

  test("deadline survives reload and the server closes the window at 120s", async ({ page }) => {
    test.setTimeout(200_000);
    await openSeededHuman(page, "timer-seed-2");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();
    await expect(page.getByTestId("deadline")).toBeVisible({ timeout: 20_000 });

    await page.goto("/");
    const deadlineAfterReload = page.getByTestId("deadline");
    await expect(deadlineAfterReload).toBeVisible({ timeout: 20_000 });
    const seconds = Number(((await deadlineAfterReload.textContent()) ?? "").replace(/\D+/g, ""));
    expect(seconds).toBeLessThanOrEqual(120);
    expect(seconds).toBeGreaterThan(0);

    const hud = page.getByTestId("value-hud");
    const before = (await hud.textContent({ timeout: 5_000 }).catch(() => "")) ?? "";
    await expect
      .poll(
        async () => {
          if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
          // Bounded read: value-hud detaches for good once the match ends, and
          // an unbounded textContent() would hang this predicate until the
          // poll timeout (same race as the sold-match loop above).
          return (await hud.textContent({ timeout: 1_000 }).catch(() => null)) ?? before;
        },
        { timeout: 140_000 },
      )
      .not.toBe(before);
  });
});

test.describe("all-AI demo", () => {
  test("demo runs with controls and fixed seed", async ({ page }) => {
    test.setTimeout(180_000);
    await openSeededDemo(page, "e2e-demo-seed");

    await expect(page.getByTestId("presentation")).toBeVisible({ timeout: 15_000 });
    const presentationText = async () => (await page.getByTestId("presentation").textContent()) ?? "";
    const mainHtml = await page.locator("main").innerHTML();
    expect(mainHtml).not.toMatch(/\brev\b/i);
    await expect(page.getByTestId("deadline")).toHaveCount(0);
    // Spectator view: the budget reminder is shown, but there is no single
    // "current player", so no analyst chip (THE-9 scoping call).
    await expect(page.getByTestId("player-hud-budget-value")).toHaveText("2,000,000");
    await expect(page.getByTestId("player-hud-analyst-name")).toHaveCount(0);
    const before = await presentationText();
    expect(before).toContain("准备完成");
    await page.getByTestId("demo-step").click();
    await expect.poll(presentationText, { timeout: 15_000 }).not.toBe(before);
    const afterOne = await presentationText();
    await page.getByTestId("demo-step").click();
    await expect.poll(presentationText, { timeout: 15_000 }).not.toBe(afterOne);
    await page.getByTestId("demo-speed").selectOption("8");
    await page.getByTestId("demo-resume").click();

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 120_000 });
  });

  test("board does not leak item count and stays a grid on mobile", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 720 });
    await openSeededDemo(page, "board-seed-mobile");

    for (let i = 0; i < 6; i++) {
      const stepButton = page.getByTestId("demo-step");
      if (!(await stepButton.isVisible().catch(() => false))) break;
      const board = page.getByTestId("lot-board");
      if (await board.isVisible().catch(() => false)) break;
      await stepButton.click();
      await page.waitForTimeout(150);
    }

    const board = page.getByTestId("lot-board");
    await expect(board).toBeVisible();
    const display = await board.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe("grid");
    const boardBox = await board.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(boardBox!.width).toBeGreaterThan(200);

    const backgroundCells = await board.locator(".board-cell.concealed").all();
    // Round-5: v2's board is a tall 10x20 scrollable long-gallery (200 concealed cells).
    expect(backgroundCells.length).toBe(200);

    const ariaCells = await board.getByRole("gridcell").all();
    const objectCards = await board.locator(".object-card").all();
    expect(ariaCells.length).toBe(objectCards.length);

    const bodyHtml = await page.locator("main").innerHTML();
    expect(bodyHtml).not.toMatch(/S0\d/);
    expect(bodyHtml).not.toMatch(/itemCount/i);
    expect(bodyHtml).not.toMatch(/slot-card/);

    const feed = page.getByTestId("event-feed");
    await expect(feed).toBeVisible();
    const feedText = (await feed.textContent()) ?? "";
    expect(feedText).toContain("拍卖师");
    const feedHtml = await feed.innerHTML();
    expect(feedHtml).not.toMatch(/S0\d/);
  });

  test("revealed objects are single spanning object-cards without leaks", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeededHuman(page, "object-card-seed");
    await page.getByTestId("analyst-analyst.surveyor").click();
    await page.getByTestId("kit-kit.survey").click();
    await page.getByTestId("lock-setup").click();

    await expect(page.locator(".object-card").first()).toBeVisible({ timeout: 20_000 });
    const auctionBoard = page.getByTestId("auction-board");
    await expect(auctionBoard).toBeVisible();
    const boardBox = await page.getByTestId("lot-board").boundingBox();
    expect(boardBox).not.toBeNull();
    expect(boardBox!.width).toBeGreaterThan(300);

    const cards = page.locator(".object-card");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      expect(await card.count()).toBe(1);
      const w = await card.getAttribute("data-width");
      const h = await card.getAttribute("data-height");
      if (w && h) {
        const colSpan = await card.evaluate((el) => getComputedStyle(el).gridColumnEnd);
        const rowSpan = await card.evaluate((el) => getComputedStyle(el).gridRowEnd);
        expect(colSpan).toContain(`span ${w}`);
        expect(rowSpan).toContain(`span ${h}`);
      }
    }

    const first = cards.first();
    await first.click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
    await page.getByTestId("object-detail").getByTestId("object-detail-close").click();
    await expect(first).toBeFocused();

    await page.setViewportSize({ width: 360, height: 720 });
    await expect(page.getByTestId("lot-board")).toBeVisible();
    const mobileBox = await page.getByTestId("lot-board").boundingBox();
    expect(mobileBox).not.toBeNull();
    expect(mobileBox!.width).toBeGreaterThan(200);
    await cards.first().click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
  });
});

test.describe("result page", () => {
  test("completed demo shows full lot board and inspects multiple object sizes", async ({ page }) => {
    test.setTimeout(180_000);
    await openSeededDemo(page, "result-board-seed");
    await page.getByTestId("demo-speed").selectOption("8");
    await page.getByTestId("demo-resume").click();
    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 120_000 });

    const resultBoard = page.getByTestId("result-board");
    await expect(resultBoard).toBeVisible();
    const cards = resultBoard.locator(".object-card");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(8);

    const sizes = new Set<string>();
    for (let i = 0; i < count; i++) {
      const w = await cards.nth(i).getAttribute("data-width");
      const h = await cards.nth(i).getAttribute("data-height");
      if (w && h) sizes.add(`${w}x${h}`);
    }
    expect(sizes.size).toBeGreaterThanOrEqual(2);

    const inspected = new Set<string>();
    for (let i = 0; i < count && inspected.size < 3; i++) {
      const card = cards.nth(i);
      const w = await card.getAttribute("data-width");
      const h = await card.getAttribute("data-height");
      const key = `${w}x${h}`;
      if (inspected.has(key)) continue;
      inspected.add(key);
      await card.click();
      const detail = page.getByTestId("object-detail");
      await expect(detail).toBeVisible();
      const text = (await detail.textContent()) ?? "";
      expect(text).toContain("×");
      expect(text).not.toContain("未知");
      await detail.getByTestId("object-detail-close").click();
    }
    expect(inspected.size).toBeGreaterThanOrEqual(3);

    const mainHtml = await page.locator("main").innerHTML();
    expect(mainHtml).not.toMatch(/S0\d/);
  });

  test("360px result board and economic table remain usable", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 720 });
    await openSeededDemo(page, "result-board-seed");
    await page.getByTestId("demo-speed").selectOption("8");
    await page.getByTestId("demo-resume").click();
    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("result-board")).toBeVisible();
    const boardBox = await page.getByTestId("lot-board").boundingBox();
    expect(boardBox).not.toBeNull();
    expect(boardBox!.width).toBeGreaterThan(200);
    await page.getByTestId("result-board").locator(".object-card").first().click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
    await expect(page.getByTestId("result-seat1")).toBeVisible();
    const tableBox = await page.locator(".result table").first().boundingBox();
    expect(tableBox).not.toBeNull();
    expect(tableBox!.width).toBeGreaterThan(150);
  });
});

test.describe("Round-4 HUD and catalog", () => {
  test("immersive viewport shows estimated-value HUD without page scroll", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededDemo(page, "e2e-demo-seed");
    await expect(page.getByTestId("value-hud")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("hud-estimated-value")).toBeVisible();
    const estimateText = (await page.getByTestId("hud-estimated-value").textContent()) ?? "";
    expect(estimateText.length).toBeGreaterThan(0);
    const scroll = await page.evaluate(() => ({
      body: document.body.scrollHeight > document.body.clientHeight + 1,
      rootOverflow: getComputedStyle(document.documentElement).overflow,
    }));
    expect(scroll.rootOverflow).toMatch(/hidden/);
    await expect(page.getByTestId("immersive-table")).toBeVisible();
  });

  test("5x5 catalog opens, filters by footprint, and links from board lookup", async ({ page }) => {
    test.setTimeout(120_000);
    await openSeededDemo(page, "e2e-demo-seed");
    await expect(page.getByTestId("open-catalog")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("open-catalog").click();
    await expect(page.getByTestId("catalog-modal")).toBeVisible();
    await expect(page.getByTestId("catalog-matrix")).toBeVisible();
    await page.getByTestId("catalog-size-2x2").click();
    await expect(page.getByTestId("catalog-list")).toBeVisible();
    const count = await page.getByTestId("catalog-list").locator(".catalog-card").count();
    expect(count).toBeGreaterThan(0);
    await page.getByTestId("catalog-close").click();
    await expect(page.getByTestId("catalog-modal")).toHaveCount(0);

    // Step until a shape-revealed card exists, then lookup. Guard against the
    // match completing before any shape reveal happens (seed/agent-dependent) —
    // the demo-step control disappears once the match is done.
    for (let i = 0; i < 8; i++) {
      if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
      const cards = page.locator(".object-card:not(.anchor-only)");
      if ((await cards.count()) > 0) {
        await cards.first().click();
        if (await page.getByTestId("catalog-lookup").isVisible().catch(() => false)) {
          await page.getByTestId("catalog-lookup").click();
          await expect(page.getByTestId("catalog-modal")).toBeVisible();
          await expect(page.getByTestId("catalog-list").locator(".catalog-card").first()).toBeVisible();
          return;
        }
      }
      const stepButton = page.getByTestId("demo-step");
      if (!(await stepButton.isVisible().catch(() => false))) break;
      await stepButton.click();
      await page.waitForTimeout(200);
    }
    // Catalog button path already validated above; the shape-lookup deep link
    // is best-effort (seed/agent-dependent on a shape reveal actually landing
    // before the match completes) and skipped once the match has ended.
    if (!(await page.getByTestId("restart").isVisible().catch(() => false))) {
      await page.getByTestId("open-catalog").click();
      await expect(page.getByTestId("catalog-modal")).toBeVisible();
    }
  });
});

test.describe("Round-5 gallery showcase, overlay toggle and pinned bid dock", () => {
  test("clicking the same card toggles the overlay closed; clicking outside it also closes it", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededHuman(page, "object-card-seed");
    await page.getByTestId("analyst-analyst.surveyor").click();
    await page.getByTestId("kit-kit.survey").click();
    await page.getByTestId("lock-setup").click();

    const card = page.locator(".object-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });

    await card.click();
    await expect(page.getByTestId("object-detail")).toBeVisible();

    // Toggle off: clicking the same card again closes the overlay.
    await card.click();
    await expect(page.getByTestId("object-detail")).toHaveCount(0);

    // Re-open, then close by clicking outside both the drawer and any card
    // (the dimmed backdrop is decorative/non-blocking — see LotBoard.tsx —
    // so a concealed board cell is a real "click outside" target).
    await card.click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
    // Click a point clearly outside both the drawer and any board card.
    await page.getByTestId("value-hud").click();
    await expect(page.getByTestId("object-detail")).toHaveCount(0);

    // Board/console must never be compressed or pushed by the overlay.
    const boardBoxBeforeOpen = await page.getByTestId("lot-board").boundingBox();
    await card.click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
    const boardBoxWhileOpen = await page.getByTestId("lot-board").boundingBox();
    expect(boardBoxWhileOpen!.width).toBe(boardBoxBeforeOpen!.width);
    await expect(page.getByTestId("bid-dock")).toBeVisible();

    // The board stays directly clickable underneath the (non-blocking) overlay.
    await card.click();
    await expect(page.getByTestId("object-detail")).toHaveCount(0);
  });

  test("clicking a different card switches the overlay without an intermediate close", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededHuman(page, "object-card-seed");
    await page.getByTestId("analyst-analyst.surveyor").click();
    await page.getByTestId("kit-kit.survey").click();
    await page.getByTestId("lock-setup").click();

    const cards = page.locator(".object-card");
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    const count = await cards.count();
    test.skip(count < 2, "seed did not reveal a second card to switch to");

    await cards.nth(0).click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
    const firstText = await page.getByTestId("object-detail").textContent();

    await cards.nth(1).click();
    await expect(page.getByTestId("object-detail")).toBeVisible();
    const secondText = await page.getByTestId("object-detail").textContent();
    expect(secondText).not.toBe(firstText);
  });

  test("unidentified object's overlay lists inferred candidates with rarity chips", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededHuman(page, "object-card-seed");
    await page.getByTestId("analyst-analyst.surveyor").click();
    await page.getByTestId("kit-kit.survey").click();
    await page.getByTestId("lock-setup").click();

    const cards = page.locator(".object-card:not(.identity-known)");
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    await cards.first().click();
    await expect(page.getByTestId("object-detail")).toBeVisible();

    const candidateList = page.getByTestId("candidate-list");
    if (await candidateList.isVisible().catch(() => false)) {
      const items = candidateList.locator("li");
      expect(await items.count()).toBeGreaterThan(0);
      const firstItemText = (await items.first().textContent()) ?? "";
      expect(firstItemText.length).toBeGreaterThan(0);
      // Full-catalog secondary jump stays available alongside the inline list.
      await expect(page.getByTestId("catalog-lookup")).toBeVisible();
    }
  });

  test("gallery board scrolls locally in a capped viewport instead of exposing the full extent", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeededDemo(page, "e2e-demo-seed");
    const viewport = page.getByTestId("lot-board-viewport");
    await expect(viewport).toBeVisible({ timeout: 15_000 });
    const overflowY = await viewport.evaluate((el) => getComputedStyle(el).overflowY);
    expect(overflowY).toBe("auto");
    const viewportBox = await viewport.boundingBox();
    const boardBox = await page.getByTestId("lot-board").boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(boardBox).not.toBeNull();
    // The 10x20 board is materially taller than the capped scroll viewport.
    expect(boardBox!.height).toBeGreaterThan(viewportBox!.height);
  });

  test("bid dock stays visible and clickable through multiple rounds of log growth", async ({ page }) => {
    test.setTimeout(120_000);
    await openSeededHuman(page, "sold-seed-a");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    for (let round = 0; round < 5; round++) {
      if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
      const bidInput = page.getByTestId("bid-input");
      if (!(await bidInput.isVisible().catch(() => false))) break;
      const bidDock = page.getByTestId("bid-dock");
      await expect(bidDock).toBeVisible();
      const dockBox = await bidDock.boundingBox();
      const viewportSize = page.viewportSize()!;
      expect(dockBox).not.toBeNull();
      expect(dockBox!.y).toBeGreaterThanOrEqual(0);
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(viewportSize.height + 1);
      await expect(page.getByTestId("submit-bid")).toBeVisible();
      // sold-seed-a settles after round 3, so the final lock can end the
      // match mid-action and detach the controls. That is the loop's normal
      // exit — anything else rethrows.
      try {
        await submitAndLockBid(page, "0");
      } catch (err) {
        if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
        throw err;
      }
      await page.waitForTimeout(300);
    }
  });
});
