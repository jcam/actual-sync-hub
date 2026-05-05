export interface RuntimeInfoDto {
  instanceLabel: string;
  liveSandboxMode: boolean;
  plaid: {
    enabled: boolean;
    environment: "sandbox" | "production";
    sandboxToolsEnabled: boolean;
  };
  teller: {
    enabled: boolean;
    environment: "sandbox" | "development" | "production";
    mtlsConfigured: boolean;
  };
  actual: {
    serverUrl: string;
    budgetSyncIdConfigured: boolean;
  };
}
