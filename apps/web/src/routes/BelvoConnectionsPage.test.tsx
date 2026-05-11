import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BelvoConnectionsPage } from "./BelvoConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  getRuntimeInfo,
  updateProviderSettings,
  createBelvoConnectSession,
  finalizeBelvoConnection,
  disconnectConnection,
  refreshConnection
} = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  updateProviderSettings: vi.fn(),
  createBelvoConnectSession: vi.fn(),
  finalizeBelvoConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  refreshConnection: vi.fn()
}));

const belvoMocks = vi.hoisted(() => ({
  openBelvoWidget: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listConnections,
    getRuntimeInfo,
    updateProviderSettings,
    createBelvoConnectSession,
    finalizeBelvoConnection,
    disconnectConnection,
    refreshConnection
  }
}));

vi.mock("../lib/belvo-widget", () => ({
  openBelvoWidget: belvoMocks.openBelvoWidget
}));

describe("BelvoConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("launches Belvo Connect and renders existing Belvo connections", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn-belvo-1",
        provider: "BELVO",
        label: "Household Belvo",
        status: "ERROR",
        institutionName: "Erebor Bank",
        health: {
          state: "REAUTH_REQUIRED",
          scope: "BANK_AUTH",
          action: "REAUTH_BANK",
          message: "Institution requires a new token."
        },
        accounts: [
          {
            id: "acct-1",
            externalAccountId: "acct-ext-1",
            name: "Checking",
            type: "CHECKING_ACCOUNT",
            subtype: "CHECKING",
            mask: "1234",
            currentBalance: 1200,
            availableBalance: 1180
          }
        ]
      }
    ]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [
        {
          provider: "BELVO",
          label: "Belvo",
          enabled: true,
          ready: true,
          environment: "sandbox",
          issues: [],
          notes: ["Belvo uses the current Connect widget for new links and widget-based update mode for reauthentication."]
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
        STRIPE: {
          environment: "test",
          test: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          live: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          countryCodes: ["US"],
          permissions: ["balances", "transactions"],
          prefetch: ["balances", "transactions"],
          transactionsInitialDays: 90,
          automaticSyncConcurrency: 2
        },
        TELLER: {
          environment: "sandbox",
          sandbox: {
            appId: "",
            sandboxAccessToken: "",
            webhookSigningSecrets: []
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
          webhookSyncDebounceSeconds: 30,
          webhookToleranceSeconds: 180
        },
        MONO: {
          environment: "sandbox",
          sandbox: {
            publicKey: "",
            secretKey: "",
            webhookSecret: ""
          },
          production: {
            publicKey: "",
            secretKey: "",
            webhookSecret: ""
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 1
        },
        SIMPLEFIN: {
          mode: "sandbox",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        },
        BELVO: {
          environment: "sandbox",
          sandbox: {
            secretId: "secret-id",
            secretPassword: "secret-password",
            webhookAuthorization: ""
          },
          production: {
            secretId: "",
            secretPassword: "",
            webhookAuthorization: ""
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 7,
          automaticSyncConcurrency: 2
        },
        HOME_VALUES: {
          automaticSyncConcurrency: 1,
          redfinFetchMethod: "curl",
          movotoFetchMethod: "curl",
          homesFetchMethod: "wget",
          truliaFetchMethod: "wget"
        },
        VEHICLE_VALUES: {
          automaticSyncConcurrency: 1,
          kbbFetchMethod: "curl",
          hagertyFetchMethod: "browser"
        }
      },
      plaid: {
        enabled: true,
        environment: "sandbox",
        sandboxToolsEnabled: false
      },
      stripe: {
        enabled: false,
        environment: "test",
        publishableKeyConfigured: false,
        secretKeyConfigured: false
      },
      teller: {
        enabled: false,
        environment: "sandbox",
        mtlsConfigured: false
      },
      mono: {
        enabled: false,
        environment: "sandbox",
        publicKeyConfigured: false,
        secretKeyConfigured: false,
        webhooksConfigured: false
      },
      simplefin: {
        enabled: true,
        mode: "sandbox",
        requiresSetupToken: true
      },
      belvo: {
        enabled: true,
        environment: "sandbox"
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
        secretId: "secret-id",
        secretPassword: "secret-password",
        webhookAuthorization: ""
      },
      production: {
        secretId: "",
        secretPassword: "",
        webhookAuthorization: ""
      },
      transactionsInitialDays: 120,
      transactionsOverlapDays: 10,
      automaticSyncConcurrency: 3
    });
    createBelvoConnectSession.mockResolvedValue({
      accessToken: "belvo-widget-token"
    });
    finalizeBelvoConnection.mockResolvedValue({
      connectionId: "conn-belvo-new",
      warning: "Belvo connected the link, but account data is still loading. Refresh the connection in a moment."
    });
    belvoMocks.openBelvoWidget.mockImplementation(async (_session, config) => {
      await config.callback("belvo-link-123", "Erebor Bank");
    });

    renderWithRouter(<BelvoConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalled();
      expect(getRuntimeInfo).toHaveBeenCalled();
    });

    expect(await screen.findAllByText(/Belvo sandbox/i)).toHaveLength(2);
    expect(screen.getByText(/Belvo is ready for new connections and refreshes/i)).toBeInTheDocument();
    expect(await screen.findAllByText("Bank needs attention")).toHaveLength(1);
    expect(screen.getByText("Household Belvo")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Initial transaction window/i));
    await user.type(screen.getByLabelText(/Initial transaction window/i), "120");
    await user.clear(screen.getByLabelText(/Overlap window/i));
    await user.type(screen.getByLabelText(/Overlap window/i), "10");
    await user.clear(screen.getByLabelText(/Automatic sync concurrency/i));
    await user.type(screen.getByLabelText(/Automatic sync concurrency/i), "3");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      expect(updateProviderSettings).toHaveBeenCalledWith("BELVO", {
        environment: "sandbox",
        sandbox: {
          secretId: "secret-id",
          secretPassword: "secret-password",
          webhookAuthorization: ""
        },
        production: {
          secretId: "",
          secretPassword: "",
          webhookAuthorization: ""
        },
        transactionsInitialDays: 120,
        transactionsOverlapDays: 10,
        automaticSyncConcurrency: 3
      });
    });

    await user.type(screen.getByLabelText(/Connection label/i), "Primary Belvo");
    await user.click(screen.getByRole("button", { name: /launch belvo connect/i }));

    await waitFor(() => {
      expect(createBelvoConnectSession).toHaveBeenCalledOnce();
      expect(belvoMocks.openBelvoWidget).toHaveBeenCalled();
      expect(finalizeBelvoConnection).toHaveBeenCalledWith("belvo-link-123", "Primary Belvo");
    });

    expect(await screen.findByText(/Belvo connection saved\./i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^refresh$/i }));
    await waitFor(() => {
      expect(refreshConnection).toHaveBeenCalledWith("conn-belvo-1");
    });

    disconnectConnection.mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() => {
      expect(disconnectConnection).toHaveBeenCalledWith("conn-belvo-1");
    });
  });
});
