import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TellerConnectionsPage } from "./TellerConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  getRuntimeInfo,
  updateProviderSettings,
  getTellerConnectConfig,
  disconnectConnection,
  refreshConnection
} = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  updateProviderSettings: vi.fn(),
  getTellerConnectConfig: vi.fn(),
  disconnectConnection: vi.fn(),
  refreshConnection: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listConnections,
    getRuntimeInfo,
    updateProviderSettings,
    getTellerConnectConfig,
    disconnectConnection,
    refreshConnection
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
      providers: [
        {
          provider: "TELLER",
          label: "Teller.io",
          enabled: true,
          ready: true,
          environment: "development",
          issues: [],
          notes: ["Webhook signing secrets are optional but recommended for automatic Teller syncs."]
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
          environment: "development",
          sandbox: {
            appId: "",
            sandboxAccessToken: "",
            webhookSigningSecrets: []
          },
          development: {
            appId: "app_test_123",
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
          webhookSyncDebounceSeconds: 30,
          webhookToleranceSeconds: 180
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
        sandboxToolsEnabled: false
      },
      teller: {
        enabled: true,
        environment: "development",
        mtlsConfigured: true
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
      environment: "development",
      sandbox: {
        appId: "",
        sandboxAccessToken: "",
        webhookSigningSecrets: []
      },
      development: {
        appId: "app_test_123",
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
      transactionsInitialDays: 60,
      transactionsOverlapDays: 7,
      automaticSyncConcurrency: 3,
      webhookSyncDebounceSeconds: 45,
      webhookToleranceSeconds: 180
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

    expect(await screen.findByText(/Teller\.io development/i)).toBeInTheDocument();
    expect(screen.getByText(/Teller\.io is ready for new connections and refreshes/i)).toBeInTheDocument();
    expect(await screen.findAllByText("Bank needs attention")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /launch teller connect/i })).toBeInTheDocument();
    expect(screen.getByText("My Teller Enrollment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Initial transaction window/i));
    await user.type(screen.getByLabelText(/Initial transaction window/i), "60");
    await user.clear(screen.getByLabelText(/Overlap window/i));
    await user.type(screen.getByLabelText(/Overlap window/i), "7");
    await user.clear(screen.getByLabelText(/Webhook sync debounce/i));
    await user.type(screen.getByLabelText(/Webhook sync debounce/i), "45");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      expect(updateProviderSettings).toHaveBeenCalledWith("TELLER", {
        environment: "development",
        sandbox: {
          appId: "",
          sandboxAccessToken: "",
          webhookSigningSecrets: []
        },
        development: {
          appId: "app_test_123",
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
        transactionsInitialDays: 60,
        transactionsOverlapDays: 7,
        automaticSyncConcurrency: 2,
        webhookSyncDebounceSeconds: 45,
        webhookToleranceSeconds: 180
      });
    });
  });
});
