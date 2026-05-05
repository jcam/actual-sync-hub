import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaidConnectionsPage } from "./PlaidConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  getRuntimeInfo,
  createPlaidLinkToken,
  seedPlaidSandboxConnection,
  refreshAllConnections,
  refreshConnection,
  seedPlaidSandboxTransactions
} = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  createPlaidLinkToken: vi.fn(),
  seedPlaidSandboxConnection: vi.fn(),
  refreshAllConnections: vi.fn(),
  refreshConnection: vi.fn(),
  seedPlaidSandboxTransactions: vi.fn()
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({
    ready: true,
    open: vi.fn()
  })
}));

vi.mock("../api", () => ({
  api: {
    listConnections,
    getRuntimeInfo,
    createPlaidLinkToken,
    seedPlaidSandboxConnection,
    refreshAllConnections,
    refreshConnection,
    seedPlaidSandboxTransactions
  }
}));

describe("PlaidConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows sandbox controls and seeds a sandbox connection", async () => {
    const user = userEvent.setup();
    listConnections.mockResolvedValue([
      {
        id: "conn-plaid-1",
        provider: "PLAID",
        label: "Household Plaid",
        status: "ERROR",
        institutionName: "First Platypus Bank",
        health: {
          state: "REAUTH_REQUIRED",
          scope: "CONNECTION_AUTH",
          action: "REAUTH_CONNECTION",
          message: "Access token expired."
        },
        accounts: []
      }
    ]);
    createPlaidLinkToken.mockResolvedValue({
      linkToken: "link-sandbox-token"
    });
    seedPlaidSandboxConnection.mockResolvedValue({
      connectionId: "conn-seeded"
    });
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Live Sandbox",
      liveSandboxMode: true,
      plaid: {
        enabled: true,
        environment: "sandbox",
        sandboxToolsEnabled: true
      },
      teller: {
        enabled: false,
        environment: "sandbox",
        mtlsConfigured: false
      },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true
      }
    });

    renderWithRouter(<PlaidConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalled();
      expect(getRuntimeInfo).toHaveBeenCalled();
      expect(createPlaidLinkToken).toHaveBeenCalled();
    });

    expect(await screen.findAllByText("Provider connection broken")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Seed sandbox bank connection" }));

    await waitFor(() => {
      expect(seedPlaidSandboxConnection).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText(/sandbox tools enabled/i)).toBeInTheDocument();
  });
});
