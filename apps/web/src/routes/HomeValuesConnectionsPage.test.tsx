import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeValuesConnectionsPage } from "./HomeValuesConnectionsPage";
import { renderWithRouter } from "../test-utils";

const {
  listConnections,
  getRuntimeInfo,
  createHomeValueConnection,
  updateHomeValueConnection,
  refreshConnection,
  disconnectConnection
} = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  createHomeValueConnection: vi.fn(),
  updateHomeValueConnection: vi.fn(),
  refreshConnection: vi.fn(),
  disconnectConnection: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listConnections,
    getRuntimeInfo,
    createHomeValueConnection,
    updateHomeValueConnection,
    refreshConnection,
    disconnectConnection
  }
}));

describe("HomeValuesConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows existing home value connections and creates a new property", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn-home-1",
        provider: "HOME_VALUES",
        label: "Primary residence",
        status: "ACTIVE",
        institutionName: "Home Values",
        institutionId: "home-values",
        homeValues: {
          address: "123 Main St, Springfield, IL",
          source: "AVERAGE",
          redfinEstimate: 650000,
          redfinUrl: "https://www.redfin.com/example",
          zillowEstimate: 630000,
          zillowUrl: "https://www.zillow.com/example",
          calculatedValue: 640000,
          lastCalculatedAt: "2026-05-07T12:00:00.000Z"
        },
        accounts: [
          {
            id: "acct-home-1",
            externalAccountId: "external-1",
            name: "Primary residence",
            officialName: "123 Main St, Springfield, IL",
            type: "property",
            subtype: "home-value",
            currentBalance: 640000,
            availableBalance: null
          }
        ]
      }
    ]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      liveSandboxMode: false,
      providers: [
        {
          provider: "HOME_VALUES",
          label: "Home Values",
          enabled: true,
          ready: true,
          environment: null,
          issues: [],
          notes: ["Use manually entered Redfin and Zillow estimates to keep an off-budget asset account current."]
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
        SIMPLEFIN: {
          mode: "sandbox",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        },
        HOME_VALUES: {
          automaticSyncConcurrency: 1
        }
      },
      plaid: {
        enabled: false,
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
    createHomeValueConnection.mockResolvedValue({
      connectionId: "conn-home-2"
    });

    renderWithRouter(<HomeValuesConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalledOnce();
      expect(getRuntimeInfo).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText("Primary residence")).toBeInTheDocument();
    expect(screen.getByText(/applied value \$640000\.00/i)).toBeInTheDocument();

    const user = userEvent.setup();
    const labelInputs = screen.getAllByLabelText(/^Label$/i);
    const addressInputs = screen.getAllByLabelText(/^Address$/i);
    const redfinEstimateInputs = screen.getAllByLabelText(/^Redfin estimate$/i);
    const zillowEstimateInputs = screen.getAllByLabelText(/^Zillow estimate$/i);

    await user.type(labelInputs[0]!, "Cabin");
    await user.type(addressInputs[0]!, "77 Pine Ln, Bend, OR");
    await user.clear(redfinEstimateInputs[0]!);
    await user.type(redfinEstimateInputs[0]!, "500000");
    await user.clear(zillowEstimateInputs[0]!);
    await user.type(zillowEstimateInputs[0]!, "520000");
    await user.click(screen.getByRole("button", { name: /add property/i }));

    await waitFor(() => {
      expect(createHomeValueConnection).toHaveBeenCalledWith({
        label: "Cabin",
        address: "77 Pine Ln, Bend, OR",
        source: "AVERAGE",
        redfinEstimate: 500000,
        redfinUrl: null,
        zillowEstimate: 520000,
        zillowUrl: null
      });
    });
  });
});
