import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { actualService, type ActualService } from "./services/actual-service.js";
import { createAppService, type AppService } from "./services/app-service.js";
import { createAuthService, type AuthService } from "./services/auth.js";
import { plaidService, type PlaidService } from "./services/plaid-service.js";
import { simplefinService, type SimpleFinService } from "./services/simplefin-service.js";
import { tellerService, type TellerService } from "./services/teller-service.js";

export interface AppContext {
  prisma: PrismaClient;
  authService: AuthService;
  appService: AppService;
  plaidService: PlaidService;
  simplefinService: SimpleFinService;
  tellerService: TellerService;
  actualService: ActualService;
}

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const database = overrides.prisma ?? prisma;
  const plaid = overrides.plaidService ?? plaidService;
  const simplefin = overrides.simplefinService ?? simplefinService;
  const teller = overrides.tellerService ?? tellerService;

  return {
    prisma: database,
    actualService: overrides.actualService ?? actualService,
    plaidService: plaid,
    simplefinService: simplefin,
    tellerService: teller,
    authService: overrides.authService ?? createAuthService({ prisma: database }),
    appService:
      overrides.appService ??
      createAppService({
        prisma: database,
        actualService: overrides.actualService ?? actualService,
        plaidService: plaid,
        simplefinService: simplefin,
        tellerService: teller
      })
  };
}
