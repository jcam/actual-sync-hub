import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { actualService } from './services/actual-service.js';
import type { ActualService } from './services/actual-service.js';
import { createAppService } from './services/app-service.js';
import type { AppService } from './services/app-service.js';
import { createAuthService } from './services/auth.js';
import type { AuthService } from './services/auth.js';
import { plaidService } from './services/plaid-service.js';
import type { PlaidService } from './services/plaid-service.js';
import { createProviderSettingsService, providerSettingsService } from './services/provider-settings-service.js';
import type { ProviderSettingsService } from './services/provider-settings-service.js';
import { simplefinService } from './services/simplefin-service.js';
import type { SimpleFinService } from './services/simplefin-service.js';
import { tellerService } from './services/teller-service.js';
import type { TellerService } from './services/teller-service.js';

export type AppContext = {
  prisma: PrismaClient;
  authService: AuthService;
  appService: AppService;
  plaidService: PlaidService;
  providerSettingsService: ProviderSettingsService;
  simplefinService: SimpleFinService;
  tellerService: TellerService;
  actualService: ActualService;
}

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const database = overrides.prisma ?? prisma;
  const settings = overrides.providerSettingsService ?? createProviderSettingsService({ prisma: database });
  const plaid = overrides.plaidService ?? plaidService;
  const simplefin = overrides.simplefinService ?? simplefinService;
  const teller = overrides.tellerService ?? tellerService;

  return {
    prisma: database,
    actualService: overrides.actualService ?? actualService,
    plaidService: plaid,
    providerSettingsService: settings,
    simplefinService: simplefin,
    tellerService: teller,
    authService: overrides.authService ?? createAuthService({ prisma: database }),
    appService:
      overrides.appService ??
      createAppService({
        prisma: database,
        actualService: overrides.actualService ?? actualService,
        plaidService: plaid,
        providerSettingsService: settings,
        simplefinService: simplefin,
        tellerService: teller
      })
  };
}
