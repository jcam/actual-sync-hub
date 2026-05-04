import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { env } from "./env.js";
import { PrismaClient } from "./generated/prisma/client.js";

function createSqliteAdapter(url: string) {
  return new PrismaBetterSqlite3(
    {
      url
    },
    {
      timestampFormat: "unixepoch-ms"
    }
  );
}

export function createPrismaClient(url = env.DATABASE_URL) {
  return new PrismaClient({
    adapter: createSqliteAdapter(url)
  });
}

export const prisma = createPrismaClient();
