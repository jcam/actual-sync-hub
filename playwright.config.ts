import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_WEB_PORT || "4173");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `npm run dev -w apps/web -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ]
});
