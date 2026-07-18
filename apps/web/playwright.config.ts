import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCi = Boolean((globalThis as { process?: { env?: { CI?: string } } }).process?.env?.CI);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: `powershell -Command "$env:PORT='${PORT}'; $env:HOST='127.0.0.1'; node .output/server/index.mjs"`,
    url: BASE_URL,
    reuseExistingServer: !isCi,
    timeout: 120_000,
  },
  projects: isCi
    ? [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'msedge',
          use: {
            ...devices['Desktop Chrome'],
            channel: 'msedge',
          },
        },
      ],
});
