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
    test.setTimeout(180_000);
    await page.goto("/");
    await page.getByTestId("play-vs-ai").click();

    await expect(page.getByTestId("lock-setup")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("analyst-analyst.appraiser").click();
    await page.getByTestId("kit-kit.appraisal").click();
    await page.getByTestId("lock-setup").click();

    for (let round = 0; round < 12; round++) {
      const resultVisible = await page
        .getByTestId("restart")
        .isVisible()
        .catch(() => false);
      if (resultVisible) break;

      const bidInput = page.getByTestId("bid-input");
      const canBid = await bidInput.isVisible().catch(() => false);
      if (canBid) {
        await bidInput.fill("2500");
        await page.getByTestId("submit-bid").click();
      }
      const lockButton = page.getByTestId("lock-bid");
      const canLock = await lockButton.isVisible().catch(() => false);
      if (canLock) {
        await lockButton.click();
      }
      await page.waitForTimeout(32_000);
    }

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("restart").click();
    await expect(page.getByTestId("play-vs-ai")).toBeVisible();
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
    const revisionText = async () => (await page.getByTestId("revision").textContent()) ?? "";
    const before = await revisionText();
    await page.getByTestId("demo-step").click();
    await expect.poll(revisionText, { timeout: 5_000 }).not.toBe(before);
    const afterOne = await revisionText();
    await page.getByTestId("demo-step").click();
    await expect.poll(revisionText, { timeout: 5_000 }).not.toBe(afterOne);
    await page.getByTestId("demo-speed").selectOption("8");
    await page.getByTestId("demo-resume").click();

    await expect(page.getByTestId("restart")).toBeVisible({ timeout: 120_000 });
  });
});
