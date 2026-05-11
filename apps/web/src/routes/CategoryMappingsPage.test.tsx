import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CategoryMappingsPage } from "./CategoryMappingsPage";

const { listAccounts, updateAccountLink } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  updateAccountLink: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listAccounts,
    updateAccountLink
  }
}));

describe("CategoryMappingsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads one account and saves edited category mappings", async () => {
    const user = userEvent.setup();
    listAccounts.mockResolvedValue({
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          balance: 100,
          offbudget: false,
          closed: false,
          link: {
            status: "ACTIVE",
            actualAccountId: "actual-1",
            actualAccountName: "Checking",
            assetType: "BANK",
            provider: "PLAID",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            syncFrequency: "MANUAL",
            syncHour: null,
            syncDayOfWeek: null,
            isEnabled: true,
            lastSyncedAt: null,
            categoryMappings: [{ sourceCategory: "Groceries", actualCategoryId: "cat-groceries" }],
            seenCategoryNames: ["Groceries", "Restaurants"]
          }
        }
      ],
      options: [],
      actualCategories: [
        { id: "cat-groceries", name: "Groceries" },
        { id: "cat-eating-out", name: "Eating Out" }
      ]
    });
    updateAccountLink.mockResolvedValue({ ok: true });

    render(
      <MemoryRouter initialEntries={["/accounts/actual-1/mappings"]}>
        <Routes>
          <Route path="/accounts/:actualAccountId/mappings" element={<CategoryMappingsPage />} />
          <Route path="/accounts" element={<div>Accounts landing</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Mapping workspace")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Actual category for Restaurants"), "cat-eating-out");
    await user.click(screen.getByRole("button", { name: "Save category mappings" }));

    await waitFor(() => {
      expect(updateAccountLink).toHaveBeenCalledWith(
        "actual-1",
        expect.objectContaining({
          categoryMappings: [
            { sourceCategory: "Groceries", actualCategoryId: "cat-groceries" },
            { sourceCategory: "Restaurants", actualCategoryId: "cat-eating-out" }
          ]
        })
      );
    });
  });
});
