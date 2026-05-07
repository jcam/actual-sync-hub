import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimpleFinConnectionsPage } from "./SimpleFinConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  listActualBankSyncLinks,
  getRuntimeInfo,
  updateProviderSettings,
  connectSimpleFin,
  reuseCachedSimpleFinConnection,
  importExistingSimpleFinLinks,
  refreshConnection,
  disconnectConnection
} =
  vi.hoisted(() => ({
    listConnections: vi.fn(),
    listActualBankSyncLinks: vi.fn(),
    getRuntimeInfo: vi.fn(),
    updateProviderSettings: vi.fn(),
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
    getRuntimeInfo,
    updateProviderSettings,
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
          providerAccountsUrl: "https://bridge.simplefin.org/my-account",
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
              providerConnectionId: "conn-1",
              providerConnectionName: "SimpleFIN Credit Union - Household",
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
          providerAccountsUrl: "https://bridge.simplefin.org/my-account",
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
              providerConnectionId: "conn-1",
              providerConnectionName: "SimpleFIN Credit Union - Household",
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
      connectionId: "conn-simplefin-1",
      warning: "Connection to Capital One may need attention."
    });
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [
        {
          provider: "SIMPLEFIN",
          label: "SimpleFIN",
          enabled: true,
          ready: true,
          environment: null,
          issues: [],
          notes: ["Each SimpleFIN connection is created from a one-time setup token."]
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
        sandboxToolsEnabled: false
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
      mode: "sandbox",
      development: {
        serverUrl: ""
      },
      transactionsInitialDays: 60,
      automaticSyncConcurrency: 3
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
    expect(await screen.findByText("SimpleFIN Credit Union - Household")).toBeInTheDocument();
    expect(await screen.findByText(/Connection id:\s*conn-1/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open simplefin accounts/i })).toHaveAttribute(
      "href",
      "https://bridge.simplefin.org/my-account"
    );
    expect(await screen.findAllByText("Provider connection broken")).toHaveLength(2);
    expect(screen.getByText(/Native sync source: simpleFin/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Initial transaction window/i));
    await user.type(screen.getByLabelText(/Initial transaction window/i), "60");
    await user.clear(screen.getByLabelText(/Automatic sync concurrency/i));
    await user.type(screen.getByLabelText(/Automatic sync concurrency/i), "3");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    expect(updateProviderSettings).toHaveBeenCalledWith("SIMPLEFIN", {
      mode: "sandbox",
      development: {
        serverUrl: ""
      },
      transactionsInitialDays: 60,
      automaticSyncConcurrency: 3
    });

    await user.type(screen.getByLabelText(/Setup token/i), "setup-token-value");
    await user.type(screen.getByLabelText(/Label/i), "Household");
    await user.click(screen.getByRole("button", { name: /Connect SimpleFIN/i }));

    expect(connectSimpleFin).toHaveBeenCalledWith("setup-token-value", "Household");
    expect(await screen.findByText(/SimpleFIN connection saved\./i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Connections may need attention\. Review the managed connections below\./i)
    ).toBeInTheDocument();

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
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [],
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
        sandboxToolsEnabled: false
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

    renderWithRouter(<SimpleFinConnectionsPage />);

    expect(
      await screen.findByText(/Failed to inspect existing SimpleFIN-linked accounts from Actual\./i)
    ).toBeInTheDocument();
    expect(screen.queryByText("Internal server error")).not.toBeInTheDocument();
  });

  it("reuses a cached SimpleFIN fixture", async () => {
    listConnections.mockResolvedValue([]);
    listActualBankSyncLinks.mockResolvedValue([]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [],
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
        sandboxToolsEnabled: false
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
    reuseCachedSimpleFinConnection.mockResolvedValue({
      connectionId: "conn-simplefin-cached",
      warning: "Connection to Fidelity Investments may need attention."
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
    expect(
      await screen.findByText(/Connections may need attention\. Review the managed connections below\./i)
    ).toBeInTheDocument();
  });

  it("shows provider-side connection rows with per-connection warning state", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn-simplefin-2",
        provider: "SIMPLEFIN",
        label: "Family SimpleFIN",
        status: "ERROR",
        institutionName: "SimpleFIN",
        providerAccountsUrl: "https://bridge.simplefin.org/my-account",
        health: {
          state: "ATTENTION_REQUIRED",
          scope: "BANK_AUTH",
          action: "CHECK_PROVIDER",
          message:
            "Connection to Barclays US may need attention. Auth required Connection to Capital One may need attention. The credentials entered do not match your credentials at this institution."
        },
        accounts: [
            {
              id: "acct-barclays-1",
              externalAccountId: "sf-barclays-1",
              providerConnectionId: "conn-barclays",
              providerConnectionName: "Arrival Plus",
              providerInstitutionName: "Barclays US",
              name: "Arrival Plus",
              type: "credit"
            },
            {
              id: "acct-capone-1",
              externalAccountId: "sf-capone-1",
              providerConnectionId: "conn-capone",
              providerConnectionName: "360 Checking",
              providerInstitutionName: "Capital One",
              name: "360 Checking",
              type: "bank"
            },
            {
              id: "acct-fidelity-1",
              externalAccountId: "sf-fidelity-1",
              providerConnectionId: "conn-fidelity",
              providerConnectionName: "Brokerage",
              providerInstitutionName: "Fidelity Investments",
              name: "Brokerage",
              type: "investment"
            }
        ]
      }
    ]);
    listActualBankSyncLinks.mockResolvedValue([]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [],
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
        sandboxToolsEnabled: false
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

    renderWithRouter(<SimpleFinConnectionsPage />);

    expect(await screen.findByText("Family SimpleFIN")).toBeInTheDocument();
    expect(await screen.findByText("Barclays US")).toBeInTheDocument();
    expect(await screen.findByText("Capital One")).toBeInTheDocument();
    expect(await screen.findByText("Fidelity Investments")).toBeInTheDocument();
    expect(await screen.findByText(/Connection:\s*Arrival Plus/i)).toBeInTheDocument();
    expect(await screen.findByText(/Connection id:\s*conn-barclays/i)).toBeInTheDocument();
    expect(await screen.findByText(/Connection to Barclays US may need attention\. Auth required/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Connection to Capital One may need attention\. The credentials entered do not match your credentials at this institution\./i)
    ).toBeInTheDocument();
    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open simplefin connections/i })).not.toBeInTheDocument();
  });

  it("keeps the connect button disabled until the setup token contains real content", async () => {
    listConnections.mockResolvedValue([]);
    listActualBankSyncLinks.mockResolvedValue([]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [],
      settings: {
        PLAID: {
          environment: "sandbox",
          sandbox: { clientId: "", secret: "" },
          production: { clientId: "", secret: "" },
          countryCodes: ["US"],
          products: ["transactions"],
          transactionsDaysRequested: 365,
          personalFinanceCategoryVersion: "v2",
          automaticSyncConcurrency: 2
        },
        TELLER: {
          environment: "sandbox",
          sandbox: { appId: "", sandboxAccessToken: "", webhookSigningSecrets: [] },
          development: { appId: "", certificatePem: "", keyPem: "", webhookSigningSecrets: [] },
          production: { appId: "", certificatePem: "", keyPem: "", webhookSigningSecrets: [] },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 2,
          webhookSyncDebounceSeconds: 30,
          webhookToleranceSeconds: 180
        },
        SIMPLEFIN: {
          mode: "sandbox",
          development: { serverUrl: "" },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        }
      },
      plaid: { enabled: true, environment: "sandbox", sandboxToolsEnabled: false },
      teller: { enabled: false, environment: "sandbox", mtlsConfigured: false },
      simplefin: { enabled: true, mode: "sandbox", requiresSetupToken: true },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true,
        externalSyncWritebackEnabled: false
      }
    });

    renderWithRouter(<SimpleFinConnectionsPage />);

    const user = userEvent.setup();
    const connectButton = await screen.findByRole("button", { name: /connect simplefin/i });
    expect(connectButton).toBeDisabled();

    await user.type(screen.getByLabelText(/setup token/i), "   ");
    expect(connectButton).toBeDisabled();
    expect(connectSimpleFin).not.toHaveBeenCalled();
  });
});
