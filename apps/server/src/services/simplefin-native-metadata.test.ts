import { describe, expect, it } from "vitest";
import { deriveDesiredActualSimpleFinMetadata } from "./simplefin-native-metadata.js";

describe("deriveDesiredActualSimpleFinMetadata", () => {
  it("prefers SimpleFIN account metadata when available", () => {
    expect(
      deriveDesiredActualSimpleFinMetadata({
        connection: {
          institutionName: "Fallback Bank",
          institutionId: "fallback-org",
          providerItemId: "provider-scope"
        },
        connectionAccount: {
          externalAccountId: "sf-account-1",
          name: "Checking",
          officialName: "Household Checking",
          mask: "1111",
          currentBalance: 1234.56,
          availableBalance: 1200.12,
          rawJson: JSON.stringify({
            institution: "SimpleFIN Credit Union",
            orgDomain: "credit-union.example"
          })
        }
      })
    ).toEqual({
      accountId: "sf-account-1",
      accountSyncSource: "simpleFin",
      officialName: "Household Checking",
      mask: "1111",
      balanceCurrent: 1234.56,
      balanceAvailable: 1200.12,
      balanceLimit: null,
      bankName: "SimpleFIN Credit Union",
      bankExternalId: "credit-union.example"
    });
  });

  it("falls back to connection-level identity when account raw metadata is absent", () => {
    expect(
      deriveDesiredActualSimpleFinMetadata({
        connection: {
          institutionName: "Fallback Bank",
          institutionId: "fallback-org",
          providerItemId: "provider-scope"
        },
        connectionAccount: {
          externalAccountId: "sf-account-2",
          name: "Savings",
          officialName: null,
          mask: null,
          currentBalance: null,
          availableBalance: null,
          rawJson: null
        }
      })
    ).toEqual({
      accountId: "sf-account-2",
      accountSyncSource: "simpleFin",
      officialName: "Savings",
      mask: null,
      balanceCurrent: null,
      balanceAvailable: null,
      balanceLimit: null,
      bankName: "Fallback Bank",
      bankExternalId: "fallback-org"
    });
  });
});
