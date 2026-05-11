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
        "apps/server/src/services/{actual-service.ts,app-service.ts,home-values-service.ts,sync-review-service.ts}": {
          statements: 80,
          branches: 55,
          functions: 82,
          lines: 80
        },
        "apps/server/src/services/{account-link-schedule.ts,category-matching.ts,connection-metadata.ts,imported-transaction-ledger.ts,link-config.ts,provider-settings-service.ts,provider-sync-helpers.ts,scheduler.ts,simplefin-native-metadata.ts,sync-health.ts}": {
          statements: 78,
          branches: 65,
          functions: 80,
          lines: 78
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
