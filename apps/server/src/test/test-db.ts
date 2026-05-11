import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createPrismaClient } from "../db.js";

async function initializeSchema(prisma: PrismaClient) {
  const statements = [
    `PRAGMA foreign_keys = ON;`,
    `CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "username" TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );`,
    `CREATE UNIQUE INDEX "User_username_key" ON "User"("username");`,
    `CREATE TABLE "ProviderSetting" (
      "provider" TEXT NOT NULL PRIMARY KEY,
      "settingsJson" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );`,
    `CREATE TABLE "Connection" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "provider" TEXT NOT NULL,
      "label" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "institutionName" TEXT,
      "institutionId" TEXT,
      "accessTokenCiphertext" TEXT NOT NULL,
      "providerItemId" TEXT,
      "metadataJson" TEXT,
      "lastRefreshedAt" DATETIME,
      "homeValuesRedfinLastFetchedAt" DATETIME,
      "homeValuesMovotoLastFetchedAt" DATETIME,
      "homeValuesHomesLastFetchedAt" DATETIME,
      "homeValuesTruliaLastFetchedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    );`,
    `CREATE UNIQUE INDEX "Connection_provider_providerItemId_key" ON "Connection"("provider", "providerItemId");`,
    `CREATE TABLE "ConnectionAccount" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "connectionId" TEXT NOT NULL,
      "externalAccountId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "officialName" TEXT,
      "mask" TEXT,
      "type" TEXT NOT NULL,
      "subtype" TEXT,
      "currentBalance" REAL,
      "availableBalance" REAL,
      "providerConnectionId" TEXT,
      "providerConnectionName" TEXT,
      "providerInstitutionId" TEXT,
      "providerInstitutionDomain" TEXT,
      "rawJson" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "ConnectionAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    `CREATE UNIQUE INDEX "ConnectionAccount_connectionId_externalAccountId_key" ON "ConnectionAccount"("connectionId", "externalAccountId");`,
    `CREATE TABLE "AccountLink" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "actualAccountId" TEXT NOT NULL,
      "actualAccountName" TEXT NOT NULL,
      "assetType" TEXT NOT NULL DEFAULT 'BANK',
      "provider" TEXT,
      "connectionId" TEXT,
      "connectionAccountId" TEXT,
      "syncFrequency" TEXT NOT NULL DEFAULT 'MANUAL',
      "syncHour" INTEGER,
      "syncDayOfWeek" INTEGER,
      "isEnabled" BOOLEAN NOT NULL DEFAULT false,
      "lastSyncedAt" DATETIME,
      "nextSyncAt" DATETIME,
      "migrationStartedAt" DATETIME,
      "migrationCompletedAt" DATETIME,
      "supersededAt" DATETIME,
      "replacedByLinkId" TEXT,
      "configJson" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "AccountLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "AccountLink_connectionAccountId_fkey" FOREIGN KEY ("connectionAccountId") REFERENCES "ConnectionAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );`,
    `CREATE INDEX "AccountLink_actualAccountId_status_idx" ON "AccountLink"("actualAccountId", "status");`,
    `CREATE INDEX "AccountLink_isEnabled_status_nextSyncAt_idx" ON "AccountLink"("isEnabled", "status", "nextSyncAt");`,
    `CREATE INDEX "AccountLink_replacedByLinkId_idx" ON "AccountLink"("replacedByLinkId");`,
    `CREATE TABLE "SyncRun" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "accountLinkId" TEXT,
      "connectionId" TEXT,
      "status" TEXT NOT NULL,
      "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finishedAt" DATETIME,
      "summary" TEXT,
      "error" TEXT,
      CONSTRAINT "SyncRun_accountLinkId_fkey" FOREIGN KEY ("accountLinkId") REFERENCES "AccountLink" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "SyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );`,
    `CREATE TABLE "ImportedTransaction" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "accountLinkId" TEXT NOT NULL,
      "importedId" TEXT NOT NULL,
      "transactionDate" TEXT,
      "actualTransactionId" TEXT,
      "primarySourceCategory" TEXT,
      "appliedCategoryId" TEXT,
      "observedCategoryId" TEXT,
      "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "ImportedTransaction_accountLinkId_fkey" FOREIGN KEY ("accountLinkId") REFERENCES "AccountLink" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    `CREATE UNIQUE INDEX "ImportedTransaction_accountLinkId_importedId_key" ON "ImportedTransaction"("accountLinkId", "importedId");`,
    `CREATE INDEX "ImportedTransaction_accountLinkId_lastSeenAt_idx" ON "ImportedTransaction"("accountLinkId", "lastSeenAt");`,
    `CREATE INDEX "ImportedTransaction_accountLinkId_transactionDate_idx" ON "ImportedTransaction"("accountLinkId", "transactionDate");`
  ];

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }
}

export async function createSqliteDatabase(url: string) {
  const prisma = createPrismaClient(url);

  await prisma.$connect();
  await initializeSchema(prisma);

  return prisma;
}

export async function createTestDatabase() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "actual-sync-tests-"));
  const dbPath = path.join(directory, "test.db");
  const url = `file:${dbPath}`;
  const prisma = await createSqliteDatabase(url);

  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}
