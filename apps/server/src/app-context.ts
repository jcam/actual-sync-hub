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
import { monoService } from './services/mono-service.js';
import type { MonoService } from './services/mono-service.js';
import { belvoService } from './services/belvo-service.js';
import type { BelvoService } from './services/belvo-service.js';
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
import { createVehicleValuesService } from './services/vehicle-values-service.js';
import type { VehicleValuesService } from './services/vehicle-values-service.js';

export type SchedulerSignal = {
  requestWakeup(delayMs?: number): void;
  requestWakeupForAccounts(accountIds: Iterable<string>, delayMs?: number): void;
};

export type AppContext = {
  prisma: PrismaClient;
  authService: AuthService;
  appService: AppService;
  homeValuesService: HomeValuesService;
  belvoService: BelvoService;
  monoService?: MonoService;
  vehicleValuesService?: VehicleValuesService;
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
  const belvo = overrides.belvoService ?? belvoService;
  const mono = overrides.monoService ?? monoService;
  const vehicleValues = overrides.vehicleValuesService ?? createVehicleValuesService({ prisma: database });
  const plaid = overrides.plaidService ?? plaidService;
  const simplefin = overrides.simplefinService ?? simplefinService;
  const stripe = overrides.stripeService ?? stripeService;
  const teller = overrides.tellerService ?? tellerService;

  return {
    prisma: database,
    actualService: overrides.actualService ?? actualService,
    homeValuesService: homeValues,
    belvoService: belvo,
    monoService: mono,
    vehicleValuesService: vehicleValues,
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
        belvoService: belvo,
        monoService: mono,
        plaidService: plaid,
        providerSettingsService: settings,
        simplefinService: simplefin,
        stripeService: stripe,
        tellerService: teller,
        vehicleValuesService: vehicleValues
      })
  };
}
