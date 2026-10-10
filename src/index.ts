import { AuthenticationError, authenticate } from "./access";
import { createWebSearchHandler } from "./mcp";
import { DdgService, DDG_OBJECT_NAME } from "./ddg-service";
import type { SearchParams, SearchResult } from "./types";

export { DdgService };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    let principal;
    try {
      principal = await authenticate(request, env);
    } catch (error) {
      const message = error instanceof AuthenticationError ? error.message : "unauthorized";
      return new Response(message, {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="mcp"' },
      });
    }

    const handler = createWebSearchHandler(
      {
        search: (params: SearchParams): Promise<SearchResult> =>
          env.DDG_SERVICE.getByName(DDG_OBJECT_NAME).search(params) as unknown as Promise<SearchResult>,
        page: {
          // Public egress only: the search VPC binding is deliberately not used.
          fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
          getApiKey: () => env.OPENROUTER_API_KEY.get(),
          ...(env.BROWSER !== undefined ? { browser: env.BROWSER } : {}),
          mcpDomain: env.MCP_DOMAIN,
          pageRouter: env.PAGE_ROUTER,
          browserEnabled: env.BROWSER_ENABLED,
        },
      },
      { allowedHostnames: [env.MCP_DOMAIN], principal },
    );

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
