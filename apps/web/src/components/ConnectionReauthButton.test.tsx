import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionReauthButton } from "./ConnectionReauthButton";

const { createConnectionReauthSession, finalizeStripeReauthSession, refreshConnection } = vi.hoisted(() => ({
  createConnectionReauthSession: vi.fn(),
  finalizeStripeReauthSession: vi.fn(),
  refreshConnection: vi.fn()
}));

const { loadTellerConnect } = vi.hoisted(() => ({
  loadTellerConnect: vi.fn()
}));

const { loadStripeFinancialConnections } = vi.hoisted(() => ({
  loadStripeFinancialConnections: vi.fn()
}));

const { usePlaidLink, plaidOpen } = vi.hoisted(() => {
  const plaidOpen = vi.fn();
  const usePlaidLink = vi.fn((config: { token: string | null }) => ({
    ready: Boolean(config.token),
    open: plaidOpen
  })) as ReturnType<typeof vi.fn>;

  return {
    usePlaidLink,
    plaidOpen
  };
});

vi.mock("../api", () => ({
  api: {
    createConnectionReauthSession,
    finalizeStripeReauthSession,
    refreshConnection
  }
}));

vi.mock("../lib/teller-connect", () => ({
  loadTellerConnect
}));

vi.mock("../lib/stripe-financial-connections", () => ({
  loadStripeFinancialConnections
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink
}));

describe("ConnectionReauthButton", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("launches Plaid update mode and refreshes the connection on success", async () => {
    createConnectionReauthSession.mockResolvedValue({
      provider: "PLAID",
      connectionId: "conn-plaid-1",
      mode: "plaid_update",
      linkToken: "link-update-token"
    });
    refreshConnection.mockResolvedValue({
      ok: true
    });

    const onCompleted = vi.fn().mockResolvedValue(undefined);
    let latestPlaidConfig:
      | {
          onSuccess?: () => Promise<void> | void;
        }
      | undefined;

    usePlaidLink.mockImplementation((config: { token: string | null; onSuccess?: () => Promise<void> | void }) => {
      latestPlaidConfig = config;
      return {
        ready: Boolean(config.token),
        open: vi.fn(() => {
          plaidOpen();
          void config.onSuccess?.();
        })
      };
    });

    render(
      <ConnectionReauthButton
        connectionId="conn-plaid-1"
        provider="PLAID"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(createConnectionReauthSession).toHaveBeenCalledWith("conn-plaid-1");
      expect(plaidOpen).toHaveBeenCalledOnce();
      expect(refreshConnection).toHaveBeenCalledWith("conn-plaid-1");
      expect(onCompleted).toHaveBeenCalledOnce();
    });
    expect(latestPlaidConfig?.onSuccess).toBeTypeOf("function");
  });

  it("launches Teller repair mode and refreshes the connection on success", async () => {
    createConnectionReauthSession.mockResolvedValue({
      provider: "TELLER",
      connectionId: "conn-teller-1",
      mode: "teller_repair",
      config: {
        applicationId: "app_test_123",
        environment: "sandbox",
        products: ["transactions", "balance"],
        selectAccount: "multiple",
        enrollmentId: "enr_123"
      }
    });
    refreshConnection.mockResolvedValue({
      ok: true
    });

    const onCompleted = vi.fn().mockResolvedValue(undefined);
    loadTellerConnect.mockResolvedValue({
      setup: vi.fn(config => ({
        open: () => {
          void config.onSuccess({
            accessToken: "token_test_123",
            enrollment: {
              id: "enr_123",
              institution: {
                name: "Security Credit Union"
              }
            }
          });
        }
      }))
    });

    render(
      <ConnectionReauthButton
        connectionId="conn-teller-1"
        provider="TELLER"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(createConnectionReauthSession).toHaveBeenCalledWith("conn-teller-1");
      expect(loadTellerConnect).toHaveBeenCalledOnce();
      expect(refreshConnection).toHaveBeenCalledWith("conn-teller-1");
      expect(onCompleted).toHaveBeenCalledOnce();
    });
  });

  it("launches Stripe relink mode and finalizes the reauthenticated connection", async () => {
    createConnectionReauthSession.mockResolvedValue({
      provider: "STRIPE",
      connectionId: "conn-stripe-1",
      mode: "stripe_relink",
      sessionId: "fcsess_relink_123",
      clientSecret: "fcsess_secret_123",
      publishableKey: "pk_test_123"
    });
    finalizeStripeReauthSession.mockResolvedValue({
      connectionId: "conn-stripe-1"
    });
    loadStripeFinancialConnections.mockResolvedValue({
      collectFinancialConnectionsAccounts: vi.fn().mockResolvedValue({
        financialConnectionsSession: {
          id: "fcsess_relink_123",
          accounts: [{ id: "fca_123" }]
        }
      })
    });

    const onCompleted = vi.fn().mockResolvedValue(undefined);

    render(
      <ConnectionReauthButton
        connectionId="conn-stripe-1"
        provider="STRIPE"
        onCompleted={onCompleted}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(createConnectionReauthSession).toHaveBeenCalledWith("conn-stripe-1");
      expect(loadStripeFinancialConnections).toHaveBeenCalledWith("pk_test_123");
      expect(finalizeStripeReauthSession).toHaveBeenCalledWith("conn-stripe-1", {
        sessionId: "fcsess_relink_123",
        accountIds: ["fca_123"]
      });
      expect(onCompleted).toHaveBeenCalledOnce();
    });
  });

  it("shows a friendly error when the reauth session cannot be created", async () => {
    createConnectionReauthSession.mockRejectedValue(new Error("Failed to fetch"));

    render(
      <ConnectionReauthButton connectionId="conn-plaid-1" provider="PLAID" />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    expect(
      await screen.findByText("Could not reach the API server to complete reauthentication.")
    ).toBeInTheDocument();
  });
});
