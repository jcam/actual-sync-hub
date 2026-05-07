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

function mockRuntime() {
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
        notes: ["Use property URLs from Redfin, Movoto, Homes.com, or Trulia to keep an off-budget asset account current."]
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
        automaticSyncConcurrency: 1,
        redfinFetchMethod: "curl",
        movotoFetchMethod: "curl",
        homesFetchMethod: "wget",
        truliaFetchMethod: "wget"
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
}

describe("HomeValuesConnectionsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows saved properties, adds a new property, and loads an existing property into the editor for changes", async () => {
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
          movotoEstimate: 651000,
          movotoUrl: "https://www.movoto.com/example",
          homesEstimate: 652000,
          homesUrl: "https://www.homes.com/example",
          truliaEstimate: 653000,
          truliaUrl: "https://www.trulia.com/example",
          sources: {
            redfin: {
              url: "https://www.redfin.com/example",
              estimate: 650000,
              lastFetchedAt: "2026-05-07T12:00:00.000Z",
              lastSuccessfulAt: "2026-05-07T12:00:00.000Z",
              lastFailedAt: null,
              lastFailureMessage: null,
              usingCachedEstimate: false,
              stale: false
            }
          },
          calculatedValue: 651000,
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
            currentBalance: 651000,
            availableBalance: null
          }
        ]
      }
    ]);
    mockRuntime();
    createHomeValueConnection.mockResolvedValue({
      connectionId: "conn-home-2"
    });
    updateHomeValueConnection.mockResolvedValue({
      connectionId: "conn-home-1"
    });

    renderWithRouter(<HomeValuesConnectionsPage />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalledOnce();
      expect(getRuntimeInfo).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText("Primary residence")).toBeInTheDocument();
    expect(screen.getByText(/applied value \$651000\.00/i)).toBeInTheDocument();

    const user = userEvent.setup();
    const labelInput = screen.getByLabelText(/^Label$/i);
    const addressInput = screen.getByLabelText(/^Address$/i);
    const redfinUrlInput = screen.getByLabelText(/^Redfin URL$/i);
    const movotoUrlInput = screen.getByLabelText(/^Movoto URL$/i);

    await user.type(labelInput, "Cabin");
    await user.type(addressInput, "77 Pine Ln, Bend, OR");
    await user.type(redfinUrlInput, "https://www.redfin.com/cabin");
    await user.type(movotoUrlInput, "https://www.movoto.com/cabin");
    await user.click(screen.getByRole("button", { name: /add property/i }));

    await waitFor(() => {
      expect(createHomeValueConnection).toHaveBeenCalledWith({
        label: "Cabin",
        address: "77 Pine Ln, Bend, OR",
        source: "AVERAGE",
        redfinEstimate: null,
        redfinUrl: "https://www.redfin.com/cabin",
        movotoEstimate: null,
        movotoUrl: "https://www.movoto.com/cabin",
        homesEstimate: null,
        homesUrl: null,
        truliaEstimate: null,
        truliaUrl: null
      });
    });

    await user.click(screen.getByRole("button", { name: /edit property/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /edit saved property/i })).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/^Label$/i)).toHaveValue("Primary residence");
    expect(screen.getByLabelText(/^Address$/i)).toHaveValue("123 Main St, Springfield, IL");
    expect(screen.getByLabelText(/^Redfin URL$/i)).toHaveValue("https://www.redfin.com/example");

    await user.clear(screen.getByLabelText(/^Label$/i));
    await user.type(screen.getByLabelText(/^Label$/i), "Primary residence updated");
    await user.clear(screen.getByLabelText(/^Movoto URL$/i));
    await user.type(screen.getByLabelText(/^Movoto URL$/i), "https://www.movoto.com/updated");
    await user.click(screen.getByRole("button", { name: /save property/i }));

    await waitFor(() => {
      expect(updateHomeValueConnection).toHaveBeenCalledWith("conn-home-1", {
        label: "Primary residence updated",
        address: "123 Main St, Springfield, IL",
        source: "AVERAGE",
        redfinEstimate: null,
        redfinUrl: "https://www.redfin.com/example",
        movotoEstimate: null,
        movotoUrl: "https://www.movoto.com/updated",
        homesEstimate: null,
        homesUrl: "https://www.homes.com/example",
        truliaEstimate: null,
        truliaUrl: "https://www.trulia.com/example"
      });
    });
  });

  it("disconnects a saved property", async () => {
    listConnections
      .mockResolvedValueOnce([
        {
          id: "conn-home-1",
          provider: "HOME_VALUES",
          label: "Primary residence",
          status: "ACTIVE",
          institutionName: "Home Values",
          institutionId: "home-values",
          homeValues: {
            address: "123 Main St, Springfield, IL",
            source: "REDFIN",
            redfinEstimate: 650000,
            redfinUrl: "https://www.redfin.com/example",
            movotoEstimate: null,
            movotoUrl: null,
            homesEstimate: null,
            homesUrl: null,
            truliaEstimate: null,
            truliaUrl: null,
            calculatedValue: 650000,
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
              currentBalance: 650000,
              availableBalance: null
            }
          ]
        }
      ])
      .mockResolvedValueOnce([]);
    mockRuntime();
    disconnectConnection.mockResolvedValue({ ok: true });

    renderWithRouter(<HomeValuesConnectionsPage />);

    expect(await screen.findByText("Primary residence")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /disconnect/i }));

    await waitFor(() => {
      expect(disconnectConnection).toHaveBeenCalledWith("conn-home-1");
    });

    expect(await screen.findByText(/no home value connections have been added/i)).toBeInTheDocument();
  });

  it("validates required source URLs before sending the request", async () => {
    listConnections.mockResolvedValue([]);
    mockRuntime();

    renderWithRouter(<HomeValuesConnectionsPage />);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Address$/i), "77 Columbus Ave, Somerville, MA 02143");
    await user.selectOptions(screen.getByLabelText(/^Source$/i), "REDFIN");
    await user.click(screen.getByRole("button", { name: /add property/i }));

    expect(await screen.findByText(/redfin url is required when redfin is the selected source/i)).toBeInTheDocument();
    expect(createHomeValueConnection).not.toHaveBeenCalled();
  });

  it("normalizes property URLs without a scheme before saving", async () => {
    listConnections.mockResolvedValue([]);
    mockRuntime();
    createHomeValueConnection.mockResolvedValue({
      connectionId: "conn-home-2"
    });

    renderWithRouter(<HomeValuesConnectionsPage />);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Address$/i), "77 Columbus Ave, Somerville, MA 02143");
    await user.selectOptions(screen.getByLabelText(/^Source$/i), "REDFIN");
    await user.type(screen.getByLabelText(/^Redfin URL$/i), "www.redfin.com/cabin");
    await user.click(screen.getByRole("button", { name: /add property/i }));

    await waitFor(() => {
      expect(createHomeValueConnection).toHaveBeenCalledWith({
        label: null,
        address: "77 Columbus Ave, Somerville, MA 02143",
        source: "REDFIN",
        redfinEstimate: null,
        redfinUrl: "https://www.redfin.com/cabin",
        movotoEstimate: null,
        movotoUrl: null,
        homesEstimate: null,
        homesUrl: null,
        truliaEstimate: null,
        truliaUrl: null
      });
    });
  });
});
