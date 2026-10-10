import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "development",
          MCP_DOMAIN: "example.com",
          DEV_PRINCIPAL: JSON.stringify({ subject: "test-user" }),
          // Never launch a real browser from Durable Object tests; the fallback
          // tests inject a fake launcher via `setTestBrowserDeps`.
          BROWSER_ENABLED: "false",
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
