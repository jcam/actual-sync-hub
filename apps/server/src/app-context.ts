import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db.js";
import { actualService, type ActualService } from "./services/actual-service.js";
import { createAppService, type AppService } from "./services/app-service.js";
import { createAuthService, type AuthService } from "./services/auth.js";
import { plaidService, type PlaidService } from "./services/plaid-service.js";

export interface AppContext {
  prisma: PrismaClient;
  authService: AuthService;
  appService: AppService;
  plaidService: PlaidService;
  actualService: ActualService;
}

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const database = overrides.prisma ?? prisma;
  const plaid = overrides.plaidService ?? plaidService;

  return {
    prisma: database,
    actualService: overrides.actualService ?? actualService,
    plaidService: plaid,
    authService: overrides.authService ?? createAuthService({ prisma: database }),
    appService:
      overrides.appService ??
      createAppService({
        prisma: database,
        actualService: overrides.actualService ?? actualService,
        plaidService: plaid
      })
  };
}
