import { expect, test } from "@playwright/test";

test("persists Plaid settings through the real server and reloads them after a full page refresh", async ({ page }) => {
  await page.goto("/plaid-connections");

  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/accounts$/);
  await page.getByRole("link", { name: "Plaid Connections" }).click();

  await expect(page).toHaveURL(/\/plaid-connections$/);

  const automaticSyncConcurrency = page.getByLabel("Automatic sync concurrency");
  await expect(automaticSyncConcurrency).toHaveValue("2");

  await automaticSyncConcurrency.fill("7");
  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(page.getByText("Plaid settings saved.")).toBeVisible();
  await expect(automaticSyncConcurrency).toHaveValue("7");

  await page.reload();

  await expect(page.getByLabel("Automatic sync concurrency")).toHaveValue("7");
});
