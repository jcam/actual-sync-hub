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
});
