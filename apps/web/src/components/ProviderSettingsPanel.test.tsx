import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { renderWithRouter } from "../test-utils";

const { updateProviderSettings } = vi.hoisted(() => ({
  updateProviderSettings: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    updateProviderSettings
  }
}));

describe("ProviderSettingsPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks saving invalid SimpleFIN development settings locally", async () => {
    renderWithRouter(
      <ProviderSettingsPanel
        provider="SIMPLEFIN"
        label="SimpleFIN"
        settings={{
          mode: "development",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        }}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    expect(await screen.findByText(/development server url is required in development mode/i)).toBeInTheDocument();
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("blocks saving invalid Plaid numeric settings locally", async () => {
    renderWithRouter(
      <ProviderSettingsPanel
        provider="PLAID"
        label="Plaid"
        settings={{
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
        }}
      />
    );

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/automatic sync concurrency/i));
    await user.type(screen.getByLabelText(/automatic sync concurrency/i), "0");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    expect(await screen.findByText(/automatic sync concurrency must be between 1 and 20/i)).toBeInTheDocument();
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("normalizes and saves Stripe settings successfully", async () => {
    updateProviderSettings.mockResolvedValue({
      environment: "test",
      test: {
        publishableKey: "pk_test_saved",
        secretKey: "sk_test_saved",
        webhookSigningSecrets: ["whsec_one", "whsec_two"]
      },
      live: {
        publishableKey: "",
        secretKey: "",
        webhookSigningSecrets: []
      },
      countryCodes: ["US", "CA"],
      permissions: ["balances", "transactions"],
      prefetch: ["balances"],
      transactionsInitialDays: 90,
      automaticSyncConcurrency: 3
    });

    const onSaved = vi.fn();

    renderWithRouter(
      <ProviderSettingsPanel
        provider="STRIPE"
        label="Stripe"
        settings={{
          environment: "test",
          test: {
            publishableKey: "pk_test_old",
            secretKey: "sk_test_old",
            webhookSigningSecrets: []
          },
          live: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          countryCodes: ["US"],
          permissions: ["balances"],
          prefetch: ["balances"],
          transactionsInitialDays: 30,
          automaticSyncConcurrency: 2
        }}
        onSaved={onSaved}
      />
    );

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/test publishable key/i));
    await user.type(screen.getByLabelText(/test publishable key/i), "pk_test_new");
    await user.clear(screen.getByLabelText(/test secret key/i));
    await user.type(screen.getByLabelText(/test secret key/i), "sk_test_new");
    await user.clear(screen.getByLabelText(/^country codes$/i));
    await user.type(screen.getByLabelText(/^country codes$/i), "us, ca");
    await user.clear(screen.getByLabelText(/^permissions$/i));
    await user.type(screen.getByLabelText(/^permissions$/i), "balances,\ntransactions");
    await user.clear(screen.getByLabelText(/^prefetch$/i));
    await user.type(screen.getByLabelText(/^prefetch$/i), "balances");
    await user.clear(screen.getByLabelText(/automatic sync concurrency/i));
    await user.type(screen.getByLabelText(/automatic sync concurrency/i), "3");
    await user.clear(screen.getByLabelText(/test webhook signing secrets/i));
    await user.type(screen.getByLabelText(/test webhook signing secrets/i), "whsec_one\nwhsec_two");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    expect(updateProviderSettings).toHaveBeenCalledWith("STRIPE", {
      environment: "test",
      test: {
        publishableKey: "pk_test_new",
        secretKey: "sk_test_new",
        webhookSigningSecrets: ["whsec_one", "whsec_two"]
      },
      live: {
        publishableKey: "",
        secretKey: "",
        webhookSigningSecrets: []
      },
      countryCodes: ["US", "CA"],
      permissions: ["balances", "transactions"],
      prefetch: ["balances"],
      transactionsInitialDays: 30,
      automaticSyncConcurrency: 3
    });
    expect(await screen.findByText(/stripe settings saved\./i)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("shows a friendly API error when saving provider settings fails", async () => {
    updateProviderSettings.mockRejectedValue(new Error("Failed to fetch"));

    renderWithRouter(
      <ProviderSettingsPanel
        provider="TELLER"
        label="Teller"
        settings={{
          environment: "sandbox",
          sandbox: {
            appId: "teller-app-id",
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
        }}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    expect(await screen.findByText(/could not reach the api server while saving teller settings\./i)).toBeInTheDocument();
  });
});
