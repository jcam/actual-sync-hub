import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render } from "@testing-library/react";
import { MigrationReviewPage } from "./MigrationReviewPage";

const { previewSyncReview, commitSyncReview } = vi.hoisted(() => ({
  previewSyncReview: vi.fn(),
  commitSyncReview: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    previewSyncReview,
    commitSyncReview
  }
}));

describe("MigrationReviewPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads a migration preview and commits the selected rows", async () => {
    const user = userEvent.setup();
    previewSyncReview.mockResolvedValue({
      actualAccountId: "actual-1",
      actualAccountName: "Checking",
      linkId: "link-1",
      status: "ACTIVE",
      items: [
        {
          importedId: "plaid-1",
          date: "2026-05-04",
          amount: -12.34,
          payeeName: "Coffee Shop",
          importedPayee: "COFFEE SHOP",
          cleared: true,
          categoryNames: ["Food And Drink"],
          action: "update",
          existing: {
            id: "txn-1",
            date: "2026-05-04",
            amount: -12.34,
            importedId: "old-1",
            importedPayee: "COFFEE SHOP",
            notes: null,
            cleared: true
          }
        },
        {
          importedId: "plaid-2",
          date: "2026-05-03",
          amount: -8.99,
          payeeName: "Bakery",
          importedPayee: "BAKERY",
          cleared: true,
          categoryNames: ["Food And Drink"],
          action: "add",
          existing: null
        },
        {
          importedId: "plaid-3",
          date: "2026-05-02",
          amount: -4.5,
          payeeName: "Pending Test",
          importedPayee: "PENDING TEST",
          cleared: false,
          categoryNames: ["Misc"],
          action: "ignore",
          existing: null
        }
      ]
    });
    commitSyncReview.mockResolvedValue({ ok: true });

    render(
      <MemoryRouter initialEntries={["/accounts/actual-1/sync-review"]}>
        <Routes>
          <Route path="/accounts/:actualAccountId/sync-review" element={<MigrationReviewPage />} />
          <Route path="/accounts" element={<div>Accounts landing</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Sync review")).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Include Bakery"));
    await user.click(screen.getByRole("button", { name: "Commit 1 selected" }));

    await waitFor(() => {
      expect(commitSyncReview).toHaveBeenCalledWith("actual-1", {
        importedIds: ["plaid-1"]
      });
    });
  });
});
