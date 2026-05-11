import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionReauthSessionDto } from "@actual-sync/shared";
import { ConnectionReauthButton } from "./ConnectionReauthButton";

const apiMocks = vi.hoisted(() => ({
  createConnectionReauthSession: vi.fn(),
  finalizeStripeReauthSession: vi.fn(),
  refreshConnection: vi.fn()
}));

const plaidState = vi.hoisted(() => ({
  config: null as Parameters<typeof usePlaidLinkMock>[0] | null,
  open: vi.fn(),
  ready: true
}));

function usePlaidLinkMock(config: {
  token: string | null;
  onSuccess: () => void;
  onExit: (error: unknown) => void;
}) {
  plaidState.config = config;
  return {
    ready: plaidState.ready,
    open: plaidState.open
  };
}

const tellerMocks = vi.hoisted(() => ({
  loadTellerConnect: vi.fn()
}));

const belvoMocks = vi.hoisted(() => ({
  openBelvoWidget: vi.fn()
}));

const stripeMocks = vi.hoisted(() => ({
  loadStripeFinancialConnections: vi.fn()
}));

vi.mock("../api", () => ({
  api: apiMocks
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: usePlaidLinkMock
}));

vi.mock("../lib/teller-connect", () => ({
  loadTellerConnect: tellerMocks.loadTellerConnect
}));

vi.mock("../lib/belvo-widget", () => ({
  openBelvoWidget: belvoMocks.openBelvoWidget
}));

vi.mock("../lib/stripe-financial-connections", () => ({
  loadStripeFinancialConnections: stripeMocks.loadStripeFinancialConnections
}));

describe("ConnectionReauthButton", () => {
  afterEach(() => {
    vi.clearAllMocks();
    plaidState.config = null;
    plaidState.ready = true;
  });

  it("renders nothing for providers without interactive reauthentication", () => {
    const { container } = render(
      <ConnectionReauthButton connectionId="conn-1" provider="SIMPLEFIN" />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("opens Plaid Link and refreshes the connection after a successful reauth", async () => {
    apiMocks.createConnectionReauthSession.mockResolvedValue({
      provider: "PLAID",
      connectionId: "conn-1",
      mode: "plaid_update",
      linkToken: "link-token-123"
    } satisfies Extract<ConnectionReauthSessionDto, { mode: "plaid_update" }>);
    apiMocks.refreshConnection.mockResolvedValue({ ok: true });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    render(
      <ConnectionReauthButton
        connectionId="conn-1"
        provider="PLAID"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(plaidState.open).toHaveBeenCalledOnce();
    });

    plaidState.config?.onSuccess();

    await waitFor(() => {
      expect(apiMocks.refreshConnection).toHaveBeenCalledWith("conn-1");
      expect(onCompleted).toHaveBeenCalledOnce();
    });
  });

  it("shows the provider message when manual reauth is required", async () => {
    apiMocks.createConnectionReauthSession.mockResolvedValue({
      provider: "STRIPE",
      connectionId: "conn-1",
      mode: "manual",
      message: "Reconnect this account from the provider dashboard."
    });

    render(<ConnectionReauthButton connectionId="conn-1" provider="STRIPE" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    expect(await screen.findByText(/reconnect this account from the provider dashboard\./i)).toBeInTheDocument();
  });

  it("launches Teller repair and refreshes on success", async () => {
    apiMocks.createConnectionReauthSession.mockResolvedValue({
      provider: "TELLER",
      connectionId: "conn-1",
      mode: "teller_repair",
      config: {
        applicationId: "teller-app-id",
        environment: "sandbox",
        products: ["transactions", "balance"],
        selectAccount: "multiple",
        enrollmentId: "enr_123"
      }
    });
    apiMocks.refreshConnection.mockResolvedValue({ ok: true });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    tellerMocks.loadTellerConnect.mockResolvedValue({
      setup: vi.fn(config => ({
        open: () => {
          void config.onSuccess();
        }
      }))
    });

    render(
      <ConnectionReauthButton
        connectionId="conn-1"
        provider="TELLER"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(apiMocks.refreshConnection).toHaveBeenCalledWith("conn-1");
      expect(onCompleted).toHaveBeenCalledOnce();
    });
  });

  it("launches Belvo widget reauth and refreshes on success", async () => {
    apiMocks.createConnectionReauthSession.mockResolvedValue({
      provider: "BELVO",
      connectionId: "conn-1",
      mode: "belvo_widget",
      session: {
        accessToken: "belvo-access-token"
      }
    });
    apiMocks.refreshConnection.mockResolvedValue({ ok: true });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    belvoMocks.openBelvoWidget.mockImplementation(async (_session, config) => {
      await config.callback("link-1", "Erebor");
    });

    render(
      <ConnectionReauthButton
        connectionId="conn-1"
        provider="BELVO"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(belvoMocks.openBelvoWidget).toHaveBeenCalledWith(
        {
          accessToken: "belvo-access-token"
        },
        expect.objectContaining({
          callback: expect.any(Function)
        })
      );
      expect(apiMocks.refreshConnection).toHaveBeenCalledWith("conn-1");
      expect(onCompleted).toHaveBeenCalledOnce();
    });
  });

  it("finalizes Stripe relink sessions when accounts are returned", async () => {
    apiMocks.createConnectionReauthSession.mockResolvedValue({
      provider: "STRIPE",
      connectionId: "conn-1",
      mode: "stripe_relink",
      sessionId: "fcs_123",
      clientSecret: "secret_123",
      publishableKey: "pk_test_123"
    });
    apiMocks.finalizeStripeReauthSession.mockResolvedValue({
      connectionId: "conn-1"
    });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    stripeMocks.loadStripeFinancialConnections.mockResolvedValue({
      collectFinancialConnectionsAccounts: vi.fn().mockResolvedValue({
        financialConnectionsSession: {
          id: "fcs_final",
          accounts: [{ id: "acct_1" }, { id: "acct_2" }]
        }
      })
    });

    render(
      <ConnectionReauthButton
        connectionId="conn-1"
        provider="STRIPE"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(apiMocks.finalizeStripeReauthSession).toHaveBeenCalledWith("conn-1", {
        sessionId: "fcs_final",
        accountIds: ["acct_1", "acct_2"]
      });
      expect(onCompleted).toHaveBeenCalledOnce();
    });
  });

  it("shows a specific Stripe error when relink completes without the expected account", async () => {
    apiMocks.createConnectionReauthSession.mockResolvedValue({
      provider: "STRIPE",
      connectionId: "conn-1",
      mode: "stripe_relink",
      sessionId: "fcs_123",
      clientSecret: "secret_123",
      publishableKey: "pk_test_123"
    });

    stripeMocks.loadStripeFinancialConnections.mockResolvedValue({
      collectFinancialConnectionsAccounts: vi.fn().mockResolvedValue({
        financialConnectionsSession: {
          id: "fcs_final",
          accounts: [],
          relink_result: {
            failure_reason: "no_account"
          }
        }
      })
    });

    render(<ConnectionReauthButton connectionId="conn-1" provider="STRIPE" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    expect(
      await screen.findByText(/stripe reauthentication completed, but the expected bank account was not relinked\./i)
    ).toBeInTheDocument();
    expect(apiMocks.finalizeStripeReauthSession).not.toHaveBeenCalled();
  });
});
