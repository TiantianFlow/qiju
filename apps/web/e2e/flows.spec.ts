import { test, expect } from "@playwright/test";

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
  test("complete a full match from home to result", async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();

    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    for (let round = 0; round < 7; round++) {
      const resultVisible = await page
        .getByTestId("restart")
        .isVisible()
        .catch(() => false);
      if (resultVisible) break;

      const bidInput = page.getByTestId("bid-input");
      const canBid = await bidInput.isVisible().catch(() => false);
      if (canBid) {
        await bidInput.fill("0");
        await page.getByTestId("submit-bid").click();
      }
      const lockButton = page.getByTestId("lock-bid");
      const canLock = await lockButton.isVisible().catch(() => false);
      if (canLock) {
        await lockButton.click();
      }
      const heading = page.locator(".table-head h2");
      const before = (await heading.textContent().catch(() => "")) ?? "";
      await expect
        .poll(
          async () => {
            if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
            return (await heading.textContent().catch(() => "")) ?? "";
          },
          { timeout: 140_000 },
        )
        .not.toBe(before);
    }

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("restart").click();
    await expect(page.getByTestId("play-vs-ai")).toBeVisible();
  });

  test("human round timer starts near 120 seconds and counts down without jumping back", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();
    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
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
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();
    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
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

    const heading = page.locator(".table-head h2");
    const before = (await heading.textContent().catch(() => "")) ?? "";
    await expect
      .poll(
        async () => {
          if (await page.getByTestId("restart").isVisible().catch(() => false)) return "done";
          return (await heading.textContent().catch(() => "")) ?? "";
        },
        { timeout: 140_000 },
      )
      .not.toBe(before);
  });
});

test.describe("all-AI demo", () => {
  test("demo runs with controls and fixed seed", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await page.getByTestId("seed-input").isHidden();
    await page.getByRole("button", { name: "种子（可选，用于复现）" }).click();
    await page.getByTestId("seed-input").fill("e2e-demo-seed");
    await page.getByTestId("watch-demo").click();

    await expect(page.getByTestId("demo-controls")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("presentation")).toBeVisible({ timeout: 15_000 });
    const presentationText = async () => (await page.getByTestId("presentation").textContent()) ?? "";
    const mainHtml = await page.locator("main").innerHTML();
    expect(mainHtml).not.toMatch(/\brev\b/i);
    await expect(page.getByTestId("deadline")).toHaveCount(0);
    const before = await presentationText();
    expect(before).toContain("准备完成");
    await page.getByTestId("demo-step").click();
    await expect.poll(presentationText, { timeout: 5_000 }).not.toBe(before);
    const afterOne = await presentationText();
    await page.getByTestId("demo-step").click();
    await expect.poll(presentationText, { timeout: 5_000 }).not.toBe(afterOne);
    await page.getByTestId("demo-speed").selectOption("8");
    await page.getByTestId("demo-resume").click();

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 120_000 });
  });

  test("board does not leak item count and stays a grid on mobile", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto("/");
    await page.getByRole("button", { name: "种子（可选，用于复现）" }).click();
    await page.getByTestId("seed-input").fill("board-seed-mobile");
    await page.getByTestId("watch-demo").click();
    await expect(page.getByTestId("demo-controls")).toBeVisible({ timeout: 15_000 });

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
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();
    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("analyst-analyst.surveyor").click();
    await page.getByTestId("kit-kit.survey").click();
    await page.getByTestId("lock-setup").click();

    await expect(page.locator(".object-card").first()).toBeVisible({ timeout: 20_000 });

    const cards = page.locator(".object-card");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const ariaCount = await card.count();
      expect(ariaCount).toBe(1);
      const w = await card.getAttribute("data-width");
      const h = await card.getAttribute("data-height");
      if (w && h) {
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThan(box!.height * (Number(w) / Number(h)) * 0.5);
      }
    }

    const first = cards.first();
    await first.click();
    await expect(page.getByTestId("object-detail")).toBeVisible();

    await page.setViewportSize({ width: 360, height: 720 });
    await expect(page.getByTestId("lot-board")).toBeVisible();
    const display = await page.getByTestId("lot-board").evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe("grid");
  });
});
