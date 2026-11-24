import { defineConfig } from "@playwright/test";
const external = process.env.E2E_ORIGIN;
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: external || "http://127.0.0.1:3190",
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: external
    ? undefined
    : {
        command: "npm run dev -- --port 3190",
        url: "http://127.0.0.1:3190",
        env: { DORM_DB: ":memory:" },
        reuseExistingServer: false,
        timeout: 120000,
      },
});
