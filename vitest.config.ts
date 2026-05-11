import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "apps/server/src/generated/prisma/**",
        "apps/**/dist/**",
        "coverage/**",
        "scripts/**"
      ],
      thresholds: {
        perFile: true,
        "apps/server/src/services/{actual-service.ts,app-service.ts,home-values-service.ts,sync-review-service.ts}": {
          statements: 79,
          branches: 61,
          functions: 81,
          lines: 79
        },
        "apps/server/src/services/{account-link-schedule.ts,category-matching.ts,connection-metadata.ts,imported-transaction-ledger.ts,link-config.ts,provider-fixture-cache.ts,provider-settings-service.ts,provider-sync-helpers.ts,scheduler.ts,simplefin-native-metadata.ts,sync-health.ts}": {
          statements: 78,
          branches: 67,
          functions: 80,
          lines: 77
        },
        "apps/server/src/services/{plaid-service.ts,simplefin-service.ts,teller-service.ts}": {
          statements: 70,
          branches: 60,
          functions: 66,
          lines: 70
        },
        "apps/server/src/services/stripe-service.ts": {
          statements: 81,
          branches: 61,
          functions: 86,
          lines: 81
        },
        "apps/server/src/{routes.ts,server.ts}": {
          statements: 85,
          branches: 61,
          functions: 85,
          lines: 85
        },
        "apps/server/src/lib/request-parsing.ts": {
          statements: 95,
          branches: 85,
          functions: 100,
          lines: 95
        }
      }
    },
    projects: [
      {
        test: {
          name: "server",
          include: ["apps/server/src/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./vitest.setup.ts"]
        }
      },
      {
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"]
        }
      }
    ]
  }
});
