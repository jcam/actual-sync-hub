import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimpleFinConnectionsPage } from "./SimpleFinConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  listActualBankSyncLinks,
  connectSimpleFin,
  reuseCachedSimpleFinConnection,
  importExistingSimpleFinLinks,
  refreshConnection,
  disconnectConnection
} =
  vi.hoisted(() => ({
    listConnections: vi.fn(),
    listActualBankSyncLinks: vi.fn(),
    connectSimpleFin: vi.fn(),
    reuseCachedSimpleFinConnection: vi.fn(),
    importExistingSimpleFinLinks: vi.fn(),
    refreshConnection: vi.fn(),
    disconnectConnection: vi.fn()
  }));

vi.mock("../api", () => ({
  api: {
    listConnections,
    listActualBankSyncLinks,
    connectSimpleFin,
    reuseCachedSimpleFinConnection,
    importExistingSimpleFinLinks,
    refreshConnection,
    disconnectConnection
  }
}));

describe("SimpleFinConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connects SimpleFIN and imports matching Actual links", async () => {
    listConnections
      .mockResolvedValueOnce([
        {
          id: "conn-simplefin-1",
          provider: "SIMPLEFIN",
          label: "SimpleFIN Household",
          status: "ERROR",
          institutionName: "SimpleFIN",
          health: {
            state: "REAUTH_REQUIRED",
            scope: "CONNECTION_AUTH",
            action: "MANUAL_RECONNECT",
            message: "SimpleFIN access token is invalid."
          },
          accounts: [
            {
              id: "acct-1",
              externalAccountId: "sf-account-1",
              name: "Checking",
              type: "bank"
            }
          ]
        }
      ])
      .mockResolvedValue([
        {
          id: "conn-simplefin-1",
          provider: "SIMPLEFIN",
          label: "SimpleFIN Household",
          status: "ERROR",
          institutionName: "SimpleFIN",
          health: {
            state: "REAUTH_REQUIRED",
            scope: "CONNECTION_AUTH",
            action: "MANUAL_RECONNECT",
            message: "SimpleFIN access token is invalid."
          },
          accounts: [
            {
              id: "acct-1",
              externalAccountId: "sf-account-1",
              name: "Checking",
              type: "bank"
            }
          ]
        }
      ]);
    listActualBankSyncLinks
      .mockResolvedValueOnce([
        {
          actualAccountId: "actual-1",
          actualAccountName: "Checking",
          actualOfficialName: "Main Checking",
          accountSyncSource: "simpleFin",
          externalAccountId: "sf-account-1",
          actualBankId: "bank-row-1",
          actualBankName: "SimpleFIN Credit Union",
          actualBankExternalId: "credit-union.example",
          mask: "1111",
          balanceCurrent: 321.45,
          balanceAvailable: 300.12,
          balanceLimit: null,
          closed: false,
          offbudget: false,
          lastSyncedAt: "2026-05-05",
          currentLinkId: null,
          currentLinkProvider: null,
          currentLinkStatus: null
        }
      ])
      .mockResolvedValue([
        {
          actualAccountId: "actual-1",
          actualAccountName: "Checking",
          actualOfficialName: "Main Checking",
          accountSyncSource: "simpleFin",
          externalAccountId: "sf-account-1",
          actualBankId: "bank-row-1",
          actualBankName: "SimpleFIN Credit Union",
          actualBankExternalId: "credit-union.example",
          mask: "1111",
          balanceCurrent: 321.45,
          balanceAvailable: 300.12,
          balanceLimit: null,
          closed: false,
          offbudget: false,
          lastSyncedAt: "2026-05-05",
          currentLinkId: "link-1",
          currentLinkProvider: "SIMPLEFIN",
          currentLinkStatus: "ACTIVE"
        }
      ]);
    connectSimpleFin.mockResolvedValue({
      connectionId: "conn-simplefin-1"
    });
    importExistingSimpleFinLinks.mockResolvedValue({
      imported: 1,
      updated: 0,
      skipped: 0,
      unmatched: 0
    });
    refreshConnection.mockResolvedValue({
      ok: true
    });
    disconnectConnection.mockResolvedValue({
      ok: true
    });

    renderWithRouter(<SimpleFinConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalledOnce();
      expect(listActualBankSyncLinks).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText("SimpleFIN Household")).toBeInTheDocument();
    expect(await screen.findAllByText("Provider connection broken")).toHaveLength(2);
    expect(screen.getByText(/Native sync source: simpleFin/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Setup token/i), "setup-token-value");
    await user.type(screen.getByLabelText(/Label/i), "Household");
    await user.click(screen.getByRole("button", { name: /Connect SimpleFIN/i }));

    expect(connectSimpleFin).toHaveBeenCalledWith("setup-token-value", "Household");
    expect(await screen.findByText(/SimpleFIN connection saved/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Import matching Actual links/i }));

    expect(importExistingSimpleFinLinks).toHaveBeenCalledWith("conn-simplefin-1");
    expect(await screen.findByText(/Imported 1, refreshed 0, skipped 0, unmatched 0/i)).toBeInTheDocument();
    expect(await screen.findByText(/Managed here via SIMPLEFIN/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Disconnect/i }));
    expect(disconnectConnection).toHaveBeenCalledWith("conn-simplefin-1");
  });

  it("shows a section-specific message instead of raw internal server error text", async () => {
    listConnections.mockResolvedValue([]);
    listActualBankSyncLinks.mockRejectedValue(new Error("Internal server error"));

    renderWithRouter(<SimpleFinConnectionsPage />);

    expect(
      await screen.findByText(/Failed to inspect existing SimpleFIN-linked accounts from Actual\./i)
    ).toBeInTheDocument();
    expect(screen.queryByText("Internal server error")).not.toBeInTheDocument();
  });

  it("reuses a cached SimpleFIN fixture", async () => {
    listConnections.mockResolvedValue([]);
    listActualBankSyncLinks.mockResolvedValue([]);
    reuseCachedSimpleFinConnection.mockResolvedValue({
      connectionId: "conn-simplefin-cached"
    });

    renderWithRouter(<SimpleFinConnectionsPage />);

    const user = userEvent.setup();
    await waitFor(() => {
      expect(listConnections).toHaveBeenCalledOnce();
      expect(listActualBankSyncLinks).toHaveBeenCalledOnce();
    });

    await user.click(screen.getByRole("button", { name: /reuse cached simplefin fixture/i }));

    expect(reuseCachedSimpleFinConnection).toHaveBeenCalledWith(undefined);
    expect(await screen.findByText(/Reused cached SimpleFIN fixture\./i)).toBeInTheDocument();
  });
});
