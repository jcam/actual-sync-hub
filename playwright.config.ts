import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_WEB_PORT || "4173");
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || "4010");
const baseURL = `http://127.0.0.1:${port}`;
const apiBaseURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: `PLAYWRIGHT_API_PORT=${apiPort} npm run test:ui:server`,
      url: `${apiBaseURL}/api/auth/session`,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: `VITE_API_PROXY_TARGET=${apiBaseURL} npm run dev -w apps/web -- --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ]
});
