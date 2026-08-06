import { test, expect } from "@playwright/test";

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
});
