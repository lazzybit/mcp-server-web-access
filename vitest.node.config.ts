import { defineConfig } from "vitest/config";

/**
 * Node-only test project.
 *
 * The canonical Vitest project (`vitest.config.ts`) runs inside workerd via
 * `@cloudflare/vitest-pool-workers`, which cannot execute on this Android/
 * Termux host. These tests cover everything that does not need `HTMLRewriter`
 * or the Durable Object runtime, so they run in plain Node as well.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/ddg/request.test.ts",
      "test/ddg/browser-search.test.ts",
      "test/ddg/ddg-html-provider.test.ts",
      "test/ddg/ddg-browser-provider.test.ts",
      "test/ddg/coordinator.test.ts",
      "test/access/*.test.ts",
      "test/mcp/contract.test.ts",
      "test/page/ssrf.test.ts",
      "test/page/decide.test.ts",
    ],
  },
});
