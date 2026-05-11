import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/mock-api";

test("creates and edits a Home Values property through the UI", async ({ page }) => {
  await installMockApi(page, { authenticated: true });

  await page.goto("/");
  await page.getByRole("link", { name: "Home Values" }).click();

  await expect(page).toHaveURL(/\/home-values-connections$/);
  await expect(page.getByRole("heading", { name: "Add a property" })).toBeVisible();

  await page.getByLabel("Address").fill("123 Main St, Springfield, IL");
  await page.getByRole("button", { name: "Add property" }).click();

  await expect(
    page.getByText("At least one property URL is required when Average all available estimates is the selected source.")
  ).toBeVisible();

  await page.getByLabel("Label").fill("Primary residence");
  await page.getByLabel("Redfin URL").fill("www.redfin.com/IL/Springfield/123-Main-St/home/1");
  await page.getByRole("button", { name: "Add property" }).click();

  await expect(page.getByText("Primary residence")).toBeVisible();
  await expect(page.getByText("123 Main St, Springfield, IL")).toBeVisible();
  await expect(page.getByText("Redfin estimate: $712345.00")).toBeVisible();

  const propertyCard = page.locator(".list-card", { hasText: "Primary residence" });
  await propertyCard.getByRole("button", { name: "Edit property" }).click();

  await expect(page.getByRole("heading", { name: "Edit saved property" })).toBeVisible();
  await page.getByLabel("Label").fill("Renamed property");
  await page.getByRole("button", { name: "Save property" }).click();

  await expect(page.getByText("Renamed property")).toBeVisible();
  await expect(page.getByText("Last calculated:")).toBeVisible();
});
