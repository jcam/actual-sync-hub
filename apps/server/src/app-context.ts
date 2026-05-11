import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { actualService } from './services/actual-service.js';
import type { ActualService } from './services/actual-service.js';
import { createAppService } from './services/app-service.js';
import type { AppService } from './services/app-service.js';
import { createAuthService } from './services/auth.js';
import type { AuthService } from './services/auth.js';
import { createHomeValuesService } from './services/home-values-service.js';
import type { HomeValuesService } from './services/home-values-service.js';
import { plaidService } from './services/plaid-service.js';
import type { PlaidService } from './services/plaid-service.js';
import { createProviderSettingsService } from './services/provider-settings-service.js';
import type { ProviderSettingsService } from './services/provider-settings-service.js';
import { simplefinService } from './services/simplefin-service.js';
import type { SimpleFinService } from './services/simplefin-service.js';
import { stripeService } from './services/stripe-service.js';
import type { StripeService } from './services/stripe-service.js';
import { tellerService } from './services/teller-service.js';
import type { TellerService } from './services/teller-service.js';

export type SchedulerSignal = {
  requestWakeup(delayMs?: number): void;
  requestWakeupForAccounts(accountIds: Iterable<string>, delayMs?: number): void;
};

export type AppContext = {
  prisma: PrismaClient;
  authService: AuthService;
  appService: AppService;
  homeValuesService: HomeValuesService;
  plaidService: PlaidService;
  providerSettingsService: ProviderSettingsService;
  simplefinService: SimpleFinService;
  stripeService?: StripeService;
  tellerService: TellerService;
  actualService: ActualService;
  scheduler?: SchedulerSignal;
}

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const database = overrides.prisma ?? prisma;
  const settings = overrides.providerSettingsService ?? createProviderSettingsService({ prisma: database });
  const homeValues = overrides.homeValuesService ?? createHomeValuesService({ prisma: database, providerSettings: settings });
  const plaid = overrides.plaidService ?? plaidService;
  const simplefin = overrides.simplefinService ?? simplefinService;
  const stripe = overrides.stripeService ?? stripeService;
  const teller = overrides.tellerService ?? tellerService;

  return {
    prisma: database,
    actualService: overrides.actualService ?? actualService,
    homeValuesService: homeValues,
    plaidService: plaid,
    providerSettingsService: settings,
    simplefinService: simplefin,
    stripeService: stripe,
    tellerService: teller,
    ...(overrides.scheduler ? {
      scheduler: overrides.scheduler
    } : {}),
    authService: overrides.authService ?? createAuthService({ prisma: database }),
    appService:
      overrides.appService ??
      createAppService({
        prisma: database,
        actualService: overrides.actualService ?? actualService,
        homeValuesService: homeValues,
        plaidService: plaid,
        providerSettingsService: settings,
        simplefinService: simplefin,
        stripeService: stripe,
        tellerService: teller
      })
  };
}
