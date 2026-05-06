import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsPage } from "./AccountsPage";
import { renderWithRouter } from "../test-utils";

const { listAccounts, listSyncRuns, getRuntimeInfo } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listSyncRuns: vi.fn(),
  getRuntimeInfo: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listAccounts,
    listSyncRuns,
    getRuntimeInfo
  }
}));

describe("AccountsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads accounts and recent sync runs on mount", async () => {
    listAccounts.mockResolvedValue([
      {
        id: "actual-1",
        name: "Checking",
        balance: 99.99,
        offbudget: false,
        closed: false,
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
        options: [],
        actualCategories: []
      }
    ]);
    listSyncRuns.mockResolvedValue([
      {
        id: "run-1",
        accountLinkId: "link-1",
        status: "SUCCESS",
        startedAt: "2026-05-04T12:00:00.000Z",
        finishedAt: "2026-05-04T12:01:00.000Z",
        summary: "Imported 2 transactions.",
        error: null
      }
    ]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Live Sandbox",
      liveSandboxMode: true,
      providers: [],
      settings: {
        PLAID: {
          countryCodes: ["US"],
          products: ["transactions"],
          transactionsDaysRequested: 365,
          personalFinanceCategoryVersion: "v2",
          automaticSyncConcurrency: 2
        },
        TELLER: {
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 2,
          webhookSyncDebounceSeconds: 30
        },
        SIMPLEFIN: {
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        }
      },
      plaid: {
        enabled: true,
        environment: "sandbox",
        sandboxToolsEnabled: true
      },
      teller: {
        enabled: false,
        environment: "sandbox",
        mtlsConfigured: false
      },
      simplefin: {
        enabled: true,
        requiresSetupToken: true
      },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true,
        externalSyncWritebackEnabled: false
      }
    });

    renderWithRouter(<AccountsPage />);

    await waitFor(() => {
      expect(listAccounts).toHaveBeenCalledOnce();
      expect(listSyncRuns).toHaveBeenCalledOnce();
      expect(getRuntimeInfo).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("Imported 2 transactions.")).toBeInTheDocument();
  });
});
