import type { Provider } from "./core.js";
import type { ProviderSettingsDto } from "./settings.js";

export type ProviderRuntimeDto = {
  provider: Provider;
  label: string;
  enabled: boolean;
  ready: boolean;
  environment?: string | null;
  issues: string[];
  notes: string[];
}

export type RuntimeInfoDto = {
  instanceLabel: string;
  liveSandboxMode: boolean;
  providers: ProviderRuntimeDto[];
  settings: ProviderSettingsDto;
  plaid: {
    enabled: boolean;
    environment: "sandbox" | "production";
    sandboxToolsEnabled: boolean;
  };
  stripe: {
    enabled: boolean;
    environment: "test" | "live";
    publishableKeyConfigured: boolean;
    secretKeyConfigured: boolean;
  };
  teller: {
    enabled: boolean;
    environment: "sandbox" | "development" | "production";
    mtlsConfigured: boolean;
  };
  mono: {
    enabled: boolean;
    environment: "sandbox" | "production";
    publicKeyConfigured: boolean;
    secretKeyConfigured: boolean;
    webhooksConfigured: boolean;
  };
  simplefin: {
    enabled: boolean;
    mode: "sandbox" | "development" | "production";
    requiresSetupToken: boolean;
  };
  belvo?: {
    enabled: boolean;
    environment: "sandbox" | "production";
  };
  actual: {
    serverUrl: string;
    budgetSyncIdConfigured: boolean;
    externalSyncWritebackEnabled: boolean;
  };
}
