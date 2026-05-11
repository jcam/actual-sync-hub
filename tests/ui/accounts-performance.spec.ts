import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/mock-api";

test("renders the accounts dashboard within a coarse timing budget", async ({ page }) => {
  await installMockApi(page, { authenticated: true });

  const startedAt = Date.now();
  await page.goto("/accounts");
  await expect(page.getByText("Household Checking")).toBeVisible();
  const durationMs = Date.now() - startedAt;

  expect(durationMs).toBeLessThan(2_500);
});
