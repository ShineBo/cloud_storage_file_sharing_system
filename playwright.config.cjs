const { defineConfig } = require("@playwright/test");
const { existsSync } = require("node:fs");
const { loadEnvFile } = require("node:process");

if (existsSync(".env")) loadEnvFile(".env");

module.exports = defineConfig({
  testDir: "./tests",
  use: {
    baseURL: process.env.CLASS_APP_ORIGIN || "http://127.0.0.1:3080",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
    trace: "retain-on-failure",
  },
});
