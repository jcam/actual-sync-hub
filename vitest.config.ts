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
      ]
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
          include: ["apps/web/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"]
        }
      }
    ]
  }
});
