import { defineConfig, devices } from "@playwright/test";

/** E2E against the running basis-node stack (default http://127.0.0.1:8797) and the built app
 * served by `vite preview`. Override with BASIS_API / WEB_PORT. */
const api = process.env.BASIS_API ?? "http://127.0.0.1:8797";
const port = Number(process.env.WEB_PORT ?? 5417);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}/?api=${encodeURIComponent(api)}`,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } }],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
