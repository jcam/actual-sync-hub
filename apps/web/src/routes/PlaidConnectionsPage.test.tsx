import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaidConnectionsPage } from "./PlaidConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  getRuntimeInfo,
  updateProviderSettings,
  createPlaidLinkToken,
  seedPlaidSandboxConnection,
  refreshAllConnections,
  refreshConnection,
  seedPlaidSandboxTransactions
} = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  updateProviderSettings: vi.fn(),
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
    updateProviderSettings,
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
      providers: [
        {
          provider: "PLAID",
          label: "Plaid",
          enabled: true,
          ready: true,
          environment: "sandbox",
          issues: [],
          notes: ["Sandbox tools are enabled for creating fixture Items and transactions."]
        }
      ],
      settings: {
        PLAID: {
          environment: "sandbox",
          sandbox: {
            clientId: "",
            secret: ""
          },
          production: {
            clientId: "",
            secret: ""
          },
          countryCodes: ["US"],
          products: ["transactions"],
          transactionsDaysRequested: 365,
          personalFinanceCategoryVersion: "v2",
          automaticSyncConcurrency: 2
        },
        TELLER: {
          environment: "sandbox",
          sandbox: {
            appId: "",
            sandboxAccessToken: ""
          },
          development: {
            appId: "",
            certificatePem: "",
            keyPem: "",
            webhookSigningSecrets: []
          },
          production: {
            appId: "",
            certificatePem: "",
            keyPem: "",
            webhookSigningSecrets: []
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 2,
          webhookSyncDebounceSeconds: 30
        },
        SIMPLEFIN: {
          mode: "sandbox",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        }
      },
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
      simplefin: {
        enabled: true,
        mode: "sandbox",
        requiresSetupToken: true
      },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true,
        externalSyncWritebackEnabled: false
      }
    });
    updateProviderSettings.mockResolvedValue({
      environment: "sandbox",
      sandbox: {
        clientId: "",
        secret: ""
      },
      production: {
        clientId: "",
        secret: ""
      },
      countryCodes: ["US", "CA"],
      products: ["transactions"],
      transactionsDaysRequested: 120,
      personalFinanceCategoryVersion: "v2",
      automaticSyncConcurrency: 3
    });

    renderWithRouter(<PlaidConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalled();
      expect(getRuntimeInfo).toHaveBeenCalled();
      expect(createPlaidLinkToken).toHaveBeenCalled();
    });

    expect(await screen.findAllByText("Provider connection broken")).toHaveLength(2);
    expect(screen.getByText(/Plaid is ready for new connections and refreshes/i)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Country codes/i));
    await user.type(screen.getByLabelText(/Country codes/i), "US, CA");
    await user.clear(screen.getByLabelText(/Initial transaction window/i));
    await user.type(screen.getByLabelText(/Initial transaction window/i), "120");
    await user.clear(screen.getByLabelText(/Automatic sync concurrency/i));
    await user.type(screen.getByLabelText(/Automatic sync concurrency/i), "3");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      expect(updateProviderSettings).toHaveBeenCalledWith("PLAID", {
        environment: "sandbox",
        sandbox: {
          clientId: "",
          secret: ""
        },
        production: {
          clientId: "",
          secret: ""
        },
        countryCodes: ["US", "CA"],
        products: ["transactions"],
        transactionsDaysRequested: 120,
        personalFinanceCategoryVersion: "v2",
        automaticSyncConcurrency: 3
      });
    });

    await user.click(screen.getByRole("button", { name: "Seed sandbox bank connection" }));

    await waitFor(() => {
      expect(seedPlaidSandboxConnection).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText(/sandbox tools enabled/i)).toBeInTheDocument();
  });
});
