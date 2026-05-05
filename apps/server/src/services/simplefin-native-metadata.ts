import type { ActualBankSyncSource } from "@actual-sync/shared";

export interface DesiredActualSimpleFinMetadata {
  accountId: string;
  accountSyncSource: ActualBankSyncSource;
  officialName: string | null;
  mask: string | null;
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceLimit: number | null;
  bankName: string;
  bankExternalId: string;
}

interface SimpleFinAccountRawJson {
  institution?: string | null;
  orgDomain?: string | null;
  orgId?: string | null;
  mask?: string | null;
}

function parseSimpleFinAccountRawJson(rawJson: string | null | undefined): SimpleFinAccountRawJson {
  if (!rawJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawJson) as SimpleFinAccountRawJson;
    return {
      institution: parsed.institution ?? null,
      orgDomain: parsed.orgDomain ?? null,
      orgId: parsed.orgId ?? null,
      mask: parsed.mask ?? null
    };
  } catch {
    return {};
  }
}

export function deriveDesiredActualSimpleFinMetadata({
  connection,
  connectionAccount
}: {
  connection: {
    institutionName?: string | null;
    institutionId?: string | null;
    providerItemId?: string | null;
  };
  connectionAccount: {
    externalAccountId: string;
    name: string;
    officialName?: string | null;
    mask?: string | null;
    currentBalance?: number | null;
    availableBalance?: number | null;
    rawJson?: string | null;
  };
}): DesiredActualSimpleFinMetadata {
  const raw = parseSimpleFinAccountRawJson(connectionAccount.rawJson);
  const bankName = raw.institution || connection.institutionName || "SimpleFIN";
  const bankExternalId =
    raw.orgDomain || raw.orgId || connection.institutionId || connection.providerItemId || connectionAccount.externalAccountId;

  return {
    accountId: connectionAccount.externalAccountId,
    accountSyncSource: "simpleFin",
    officialName: connectionAccount.officialName || connectionAccount.name,
    mask: connectionAccount.mask || raw.mask || null,
    balanceCurrent: connectionAccount.currentBalance ?? null,
    balanceAvailable: connectionAccount.availableBalance ?? null,
    balanceLimit: null,
    bankName,
    bankExternalId
  };
}
