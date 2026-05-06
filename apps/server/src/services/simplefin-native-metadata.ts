import type { ActualBankSyncSource } from "@actual-sync/shared";

export type DesiredActualSimpleFinMetadata = {
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

type SimpleFinAccountRawJson = {
  accountId?: string | null;
  institution?: string | null;
  orgDomain?: string | null;
  orgId?: string | null;
  mask?: string | null;
  connId?: string | null;
  connName?: string | null;
  connOrgId?: string | null;
  connOrgName?: string | null;
  connOrgUrl?: string | null;
  sfinUrl?: string | null;
}

export function parseSimpleFinAccountRawJson(rawJson: string | null | undefined): SimpleFinAccountRawJson {
  if (!rawJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawJson) as SimpleFinAccountRawJson;
    return {
      accountId: parsed.accountId ?? null,
      institution: parsed.institution ?? null,
      orgDomain: parsed.orgDomain ?? null,
      orgId: parsed.orgId ?? null,
      mask: parsed.mask ?? null,
      connId: parsed.connId ?? null,
      connName: parsed.connName ?? null,
      connOrgId: parsed.connOrgId ?? null,
      connOrgName: parsed.connOrgName ?? null,
      connOrgUrl: parsed.connOrgUrl ?? null,
      sfinUrl: parsed.sfinUrl ?? null
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
    providerConnectionId?: string | null;
    providerInstitutionId?: string | null;
    providerInstitutionDomain?: string | null;
    rawJson?: string | null;
  };
}): DesiredActualSimpleFinMetadata {
  const raw = parseSimpleFinAccountRawJson(connectionAccount.rawJson);
  const bankName = raw.institution || raw.connName || connection.institutionName || "SimpleFIN";
  const bankExternalId =
    connectionAccount.providerInstitutionDomain ||
    raw.orgDomain ||
    connectionAccount.providerInstitutionId ||
    raw.orgId ||
    connection.institutionId ||
    connection.providerItemId ||
    connectionAccount.externalAccountId;

  return {
    accountId: raw.accountId || connectionAccount.externalAccountId,
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
