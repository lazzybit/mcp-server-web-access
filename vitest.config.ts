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
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
