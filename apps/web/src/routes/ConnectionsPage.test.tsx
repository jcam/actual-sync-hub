import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./ConnectionsPage";
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

describe("ConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows sandbox controls and seeds a sandbox connection", async () => {
    const user = userEvent.setup();
    listConnections.mockResolvedValue([]);
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
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true
      }
    });

    renderWithRouter(<ConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalled();
      expect(getRuntimeInfo).toHaveBeenCalled();
      expect(createPlaidLinkToken).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: "Seed sandbox bank connection" }));

    await waitFor(() => {
      expect(seedPlaidSandboxConnection).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText(/live sandbox tools on/i)).toBeInTheDocument();
  });
});
