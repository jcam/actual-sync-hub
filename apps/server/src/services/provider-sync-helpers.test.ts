import { describe, expect, it } from "vitest";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";

describe("sanitizeProviderSyncResult", () => {
  it("drops malformed transactions and keeps the latest duplicate imported id", () => {
    const result = sanitizeProviderSyncResult({
      imported: 5,
      transactions: [
        {
          importedId: " txn-1 ",
          date: "2026-05-05",
          amount: 10,
          payeeName: " Coffee Shop ",
          importedPayee: " Coffee Shop ",
          notes: " Downtown ",
          categoryNames: [" Dining ", "Dining"],
          searchText: [" Coffee Shop ", "Coffee Shop", " Downtown "],
          cleared: true
        },
        {
          importedId: "   ",
          date: "2026-05-05",
          amount: 12,
          payeeName: "Ignored",
          cleared: true
        },
        {
          importedId: "txn-2",
          date: "   ",
          amount: 12,
          payeeName: "Ignored",
          cleared: true
        },
        {
          importedId: "txn-1",
          date: "2026-05-06",
          amount: 15,
          payeeName: "Coffee Shop",
          importedPayee: "Coffee Shop Purchase",
          notes: "Terminal 4",
          categoryNames: ["Dining", "Dining"],
          searchText: ["Coffee Shop", "Terminal 4"],
          cleared: false
        },
        {
          importedId: "txn-3",
          date: "2026-05-07",
          amount: 20,
          payeeName: "Book Store",
          cleared: true
        }
      ],
      removedImportedIds: [" txn-3 ", "txn-9", "", "txn-9"]
    });

    expect(result.imported).toBe(2);
    expect(result.transactions).toEqual([
      {
        importedId: "txn-1",
        date: "2026-05-06",
        amount: 15,
        payeeName: "Coffee Shop",
        importedPayee: "Coffee Shop Purchase",
        notes: "Terminal 4",
        categoryNames: ["Dining"],
        searchText: ["Coffee Shop", "Terminal 4"],
        cleared: false
      },
      {
        importedId: "txn-3",
        date: "2026-05-07",
        amount: 20,
        payeeName: "Book Store",
        cleared: true,
        importedPayee: undefined,
        notes: undefined,
        categoryNames: undefined,
        searchText: undefined
      }
    ]);
    expect(result.removedImportedIds).toEqual(["txn-9"]);
  });
});
