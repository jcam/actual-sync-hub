import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActualAccountDto } from "@actual-sync/shared";
import { AccountCard } from "./AccountCard";
import { renderWithRouter } from "../test-utils";

const { updateAccountLink, runSync } = vi.hoisted(() => ({
  updateAccountLink: vi.fn(),
  runSync: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    updateAccountLink,
    runSync
  }
}));

const account: ActualAccountDto = {
  id: "actual-1",
  name: "Checking",
  balance: 1250.5,
  link: {
    status: "ACTIVE",
    actualAccountId: "actual-1",
    actualAccountName: "Checking",
    assetType: "BANK",
    provider: null,
    connectionId: null,
    connectionAccountId: null,
    syncFrequency: "MANUAL",
    syncHour: null,
    syncDayOfWeek: null,
    isEnabled: false,
    lastSyncedAt: null,
    categoryMappings: [],
    seenCategoryNames: []
  },
  options: [
    {
      connectionId: "conn-1",
      connectionLabel: "Plaid A",
      connectionStatus: "ACTIVE",
      connectionAccountId: "conn-account-1",
      externalAccountId: "ext-1",
      provider: "PLAID",
      institutionName: "Bank A",
      accountName: "Checking A",
      mask: "11",
      type: "depository",
      subtype: "checking"
    },
    {
      connectionId: "conn-2",
      connectionLabel: "Plaid B",
      connectionStatus: "ACTIVE",
      connectionAccountId: "conn-account-2",
      externalAccountId: "ext-2",
      provider: "PLAID",
      institutionName: "Bank B",
      accountName: "Checking B",
      mask: "22",
      type: "depository",
      subtype: "checking"
    }
  ],
  actualCategories: [
    { id: "cat-groceries", name: "Groceries" },
    { id: "cat-eating-out", name: "Eating Out" }
  ]
};

describe("AccountCard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("filters provider account choices by the selected connection and saves the link", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    renderWithRouter(<AccountCard account={account} onRefresh={onRefresh} />);

    await user.selectOptions(screen.getByLabelText("Connection"), "conn-2");

    expect(screen.getByRole("option", { name: /Checking B/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Checking A/ })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Provider account"), "conn-account-2");
    await user.selectOptions(screen.getByLabelText("Enabled"), "yes");
    await user.click(screen.getByRole("button", { name: "Save link" }));

    await waitFor(() => {
      expect(updateAccountLink).toHaveBeenCalledWith(
        "actual-1",
        expect.objectContaining({
          connectionId: "conn-2",
          connectionAccountId: "conn-account-2",
          isEnabled: true
        })
      );
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows a helpful error instead of submitting an incomplete link", async () => {
    const user = userEvent.setup();
    renderWithRouter(<AccountCard account={account} onRefresh={vi.fn().mockResolvedValue(undefined)} />);

    await user.selectOptions(screen.getByLabelText("Connection"), "conn-2");
    await user.click(screen.getByRole("button", { name: "Save link" }));

    expect(await screen.findByText(/select a provider account for the chosen connection/i)).toBeInTheDocument();
    expect(updateAccountLink).not.toHaveBeenCalled();
  });

  it("links to the dedicated category mapping page", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          link: {
            ...account.link,
            provider: "PLAID",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            isEnabled: true,
            categoryMappings: [{ sourceCategory: "Groceries", actualCategoryId: "cat-groceries" }],
            seenCategoryNames: ["Groceries", "Restaurants"]
          }
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("link", { name: "Edit category mappings" })).toHaveAttribute(
      "href",
      "/accounts/actual-1/mappings"
    );
  });

  it("renders a zero balance when the account balance is missing", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          balance: null as never
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("shows a migration review link when the current link is migrating", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          link: {
            ...account.link,
            status: "MIGRATING",
            provider: "PLAID",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            isEnabled: true
          }
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("link", { name: "Review migration" })).toHaveAttribute(
      "href",
      "/accounts/actual-1/migration"
    );
    expect(screen.queryByRole("button", { name: "Sync immediately" })).not.toBeInTheDocument();
  });

  it("shows review sync as the default manual sync path for linked accounts", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          link: {
            ...account.link,
            status: "ACTIVE",
            provider: "TELLER",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            isEnabled: true
          }
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("link", { name: "Review sync" })).toHaveAttribute(
      "href",
      "/accounts/actual-1/sync-review"
    );
    expect(screen.getByRole("button", { name: "Sync immediately" })).toBeInTheDocument();
  });

  it("shows distinct health badges for provider auth and Actual sync failures", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          link: {
            ...account.link,
            provider: "PLAID",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            health: {
              state: "ERROR",
              scope: "ACTUAL_BACKEND",
              action: "RETRY",
              message: "Actual import failed."
            },
            isEnabled: true
          },
          options: [
            {
              ...account.options[0],
              connectionHealth: {
                state: "REAUTH_REQUIRED",
                scope: "CONNECTION_AUTH",
                action: "REAUTH_CONNECTION",
                message: "Stored provider token is invalid."
              }
            }
          ]
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Actual sync failed")).toBeInTheDocument();
    expect(screen.getByText("Provider connection broken")).toBeInTheDocument();
  });

  it("shows when automatic sync is paused after repeated failures", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          link: {
            ...account.link,
            provider: "PLAID",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            syncFrequency: "DAILY",
            isEnabled: true,
            automaticSyncBackoffUntil: "2099-05-06T12:00:00.000Z",
            automaticSyncFailureCount: 3,
            health: {
              state: "ERROR",
              scope: "SYNC_PIPELINE",
              action: "RETRY",
              code: "SYNC_FAILED",
              message: "Temporary sync failure."
            }
          }
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Automatic sync paused")).toBeInTheDocument();
    expect(screen.getByText(/Automatic sync is paused until .* after 3 automatic failures\./)).toBeInTheDocument();
  });

  it("shows a rate-limit specific automatic sync pause message", async () => {
    renderWithRouter(
      <AccountCard
        account={{
          ...account,
          link: {
            ...account.link,
            provider: "TELLER",
            connectionId: "conn-1",
            connectionAccountId: "conn-account-1",
            syncFrequency: "HOURLY",
            isEnabled: true,
            automaticSyncBackoffUntil: "2099-05-06T12:00:00.000Z",
            automaticSyncFailureCount: 2,
            health: {
              state: "ERROR",
              scope: "SYNC_PIPELINE",
              action: "RETRY",
              code: "RATE_LIMIT_EXCEEDED",
              message: "Provider rate limit exceeded."
            }
          }
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByText(/Automatic sync is paused until .* because the provider rate-limited recent sync attempts after 2 automatic failures\./)
    ).toBeInTheDocument();
  });
});
