import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/mock-api";

test("shows the login screen when no session is active", async ({ page }) => {
  await installMockApi(page);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Actual Sync Hub" })).toBeVisible();
  await expect(page.getByLabel("Username")).toHaveValue("admin");
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("logs in and renders the accounts dashboard shell", async ({ page }) => {
  await installMockApi(page);

  await page.goto("/");
  await page.getByLabel("Password").fill("dev-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByText("Signed in as")).toBeVisible();
  await expect(page.getByText("Household Checking")).toBeVisible();
  await expect(page.getByText("Playwright Fixture")).toBeVisible();
  await expect(page.getByRole("link", { name: "Home Values" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh Actual accounts" })).toBeVisible();
});
