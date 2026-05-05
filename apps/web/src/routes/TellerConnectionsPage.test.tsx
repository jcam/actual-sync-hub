import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TellerConnectionsPage } from "./TellerConnectionsPage";
import { renderWithRouter } from "../test-utils";

const { listConnections, getRuntimeInfo, getTellerConnectConfig } = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  getTellerConnectConfig: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listConnections,
    getRuntimeInfo,
    getTellerConnectConfig
  }
}));

vi.mock("../lib/teller-connect", () => ({
  loadTellerConnect: vi.fn()
}));

describe("TellerConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows Teller setup and existing Teller connections", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn-teller-1",
        provider: "TELLER",
        label: "My Teller Enrollment",
        status: "ERROR",
        institutionName: "Security Credit Union",
        institutionId: "security_cu",
        health: {
          state: "ATTENTION_REQUIRED",
          scope: "BANK_AUTH",
          action: "REAUTH_BANK",
          message: "Institution requires attention."
        },
        accounts: [
          {
            id: "acct-1",
            externalAccountId: "acc_123",
            name: "Checking",
            type: "depository",
            subtype: "checking",
            mask: "1234",
            currentBalance: 1500,
            availableBalance: 1500
          }
        ]
      }
    ]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      plaid: {
        enabled: true,
        environment: "sandbox",
        sandboxToolsEnabled: false
      },
      teller: {
        enabled: true,
        environment: "development",
        mtlsConfigured: true
      },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true
      }
    });
    getTellerConnectConfig.mockResolvedValue({
      applicationId: "app_test_123",
      environment: "development",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });

    renderWithRouter(<TellerConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalledOnce();
      expect(getRuntimeInfo).toHaveBeenCalledOnce();
      expect(getTellerConnectConfig).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText(/Teller\s+development/i)).toBeInTheDocument();
    expect(await screen.findAllByText("Bank needs attention")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /launch teller connect/i })).toBeInTheDocument();
    expect(screen.getByText("My Teller Enrollment")).toBeInTheDocument();
    expect(screen.getByText(/Use this page to manage Teller connections/i)).toBeInTheDocument();
  });
});
