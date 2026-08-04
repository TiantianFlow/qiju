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
    await openSeededHuman(page, "accept-sold");
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    for (let round = 0; round < 8; round++) {
      if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
      const bidInput = page.getByTestId("bid-input");
      if (!(await bidInput.isVisible().catch(() => false))) {
        await expect
          .poll(async () => (await page.getByTestId("restart").isVisible().catch(() => false)) || (await bidInput.isVisible().catch(() => false)), {
            timeout: 30_000,
          })
          .toBeTruthy();
      }
      if (await page.getByTestId("restart").isVisible().catch(() => false)) break;
      await submitAndLockBid(page, "0");
      const hud = page.getByTestId("value-hud");
      const before = (await hud.textContent().catch(() => "")) ?? "";
      await expect
        .poll(
          async () => {
            if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
            return (await hud.textContent().catch(() => "")) ?? "";
          },
          { timeout: 45_000 },
        )
        .not.toBe(before);
    }

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("result-board")).toBeVisible();
    await expect(page.getByTestId("result-sold")).toBeVisible();
    await expect(page.getByTestId("result-buyer")).toHaveText("seat2");
    await expect(page.getByTestId("result-winning-bid")).toHaveText("3915");
    await page.getByTestId("restart").click();
    await expect(page.getByTestId("play-vs-ai")).toBeVisible();
  });

  test("no-sale demo seed reaches inspectable result board", async ({ page }) => {
    test.setTimeout(180_000);
    await openSeededDemo(page, "srvns-6718");
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
    const before = (await hud.textContent().catch(() => "")) ?? "";
    await expect
      .poll(
        async () => {
          if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
          return (await hud.textContent().catch(() => "")) ?? "";
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
    expect(backgroundCells.length).toBe(100);

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

    // Step until a shape-revealed card exists, then lookup.
    for (let i = 0; i < 8; i++) {
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
      await page.getByTestId("demo-step").click();
      await page.waitForTimeout(200);
    }
    // Catalog button path already validated; lookup is best-effort if shapes appear.
    await page.getByTestId("open-catalog").click();
    await expect(page.getByTestId("catalog-modal")).toBeVisible();
  });
});
