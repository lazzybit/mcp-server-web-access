# mcp-server-web-access

Remote MCP server (Streamable HTTP) on Cloudflare Workers, exposing two tools:

- `search_ddg` — DuckDuckGo search, backed by a Durable Object.
- `fetch_page` — fetch a URL and return its readable content as Markdown or
  plain text, rendering with a headless browser only when the static HTML is an
  app shell.

```
MCP client ──Bearer──▶ Cloudflare Access (Managed OAuth)
                              │  Cf-Access-Jwt-Assertion (JWT)
                              ▼
                     Worker: src/index.ts, src/access.ts, src/mcp.ts
                              │
              ┌───────────────┴────────────────────────────┐
              │ search_ddg                                 │ fetch_page
              ▼                                            ▼
   DdgService Durable Object                    src/page/*
   (singleton "global")                         ├─ probe (one bounded GET)
              │                                 ├─ OpenRouter decisions (needs_render)
              ▼                                 ├─ Browser Run (one render, if needed)
   DuckDuckGo HTML endpoint                     └─ Readability → plain text
```

The Worker authenticates, serves MCP and validates input/output.

- `search_ddg`: `DdgService` is the only component that contacts DuckDuckGo:
  FIFO complete searches, in-job pagination and retries, an adaptive persisted
  pacing interval (5–20 s) and a cooldown entered after three consecutive
  upstream failures.
- `fetch_page`: one probe GET (redirects validated per hop), at most one
  OpenRouter decisions call and at most one Browser Run render, each
  operation bounded by its own timeout. Readability is tried first and plain
  text is the fallback.

## Configuration (`wrangler.jsonc`)

| Variable | Required | Value | Where it comes from |
| --- | --- | --- | --- |
| `ENVIRONMENT` | yes | `production` or `development` | Only `development` enables dev-only paths. |
| `MCP_DOMAIN` | yes | Domain only, e.g. `search-mcp.example.com` | The custom-domain route in `routes[0].pattern` (must match). |
| `TEAM_DOMAIN` | yes | Domain only, e.g. `my-team.cloudflareaccess.com` | Zero Trust team domain. |
| `APPLICATION_AUD` | yes | Access application AUD tag | The Access application's settings. |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` | Defaults to `info`. |
| `PAGE_ROUTER` | no | `on` / `off` | `off` skips the decision model and never renders. Defaults to `on`. |
| `BROWSER_ENABLED` | no | `true` / `false` | Browser kill switch. Defaults to `true`. |

`MCP_DOMAIN` and `TEAM_DOMAIN` are never derived from a request. `TEAM_DOMAIN` is
a bare domain: the issuer is `https://<TEAM_DOMAIN>` and the JWKS URL is
`https://<TEAM_DOMAIN>/cdn-cgi/access/certs`.

### Secrets and bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Secrets Store secret | OpenRouter API key (secret name `openrouter_api_key`, scope `workers`). Read via `await env.OPENROUTER_API_KEY.get()` and used only as the `Authorization: Bearer` header for the decisions request. |
| `BROWSER` | Browser Run | Headless Chromium session for the single optional render. |
| `DDG_SERVICE` | Durable Object | The search service. |
| `SEARCH_VNC` | VPC Network (optional) | DuckDuckGo egress only. `fetch_page` never uses it. |

The OpenRouter key is never logged, measured, hashed, or echoed; decision
failures are normalised to `decision.source: "error"` and the static HTML is
used instead.

## Cloudflare Access (Managed OAuth)

1. Bind the custom domain; keep `workers_dev` and `preview_urls` disabled.
2. Zero Trust → Access → Applications → Add → **Self-hosted**, domain =
   `MCP_DOMAIN`, add a policy.
3. **Advanced settings** → enable **Managed OAuth**; token lifetime 5m–15m,
   session duration 1w–2w. For local clients, enable dynamic client registration
   on localhost/loopback.
4. Copy the team domain into `TEAM_DOMAIN` and the application AUD tag into
   `APPLICATION_AUD`.

The Worker re-verifies the injected `Cf-Access-Jwt-Assertion` (signature, `iss`,
`aud`, `exp`). Missing/invalid assertions return `401`.

## Tool contracts

### `search_ddg`

Input:

```ts
{ query: string /* trim 1..512 */, maxResults: 1..50, region?: "xx-xx" | "wt-wt", freshness?: "day"|"week"|"month"|"year" }
```

Output (`structuredContent` and `content[0].text` are the same object):

```ts
{
  query: { text; region; freshness?; requested },
  results: { rank; title; url; domain; snippet }[],
  count, truncated,
  status: "ok" | "exhausted" | "interrupted" | "failed",
  error?: { code; message; retryable; retryAfterMs? }
}
```

`isError` is true only for `failed`. Invalid arguments return a structured
`INVALID_INPUT` result. Outputs over 256 KiB are shrunk (snippets, then strings,
then results); an existing upstream error is preserved.

Upstream policy: a failed page is retried inside the same search, ahead of any
queued search, after the adaptive pacing interval. Each valid results page or
empty result resets the failure streak and decays the interval (`×0.7071`, floor
5 s); each upstream failure grows it (`×2`, ceiling 20 s). Three consecutive
failures open a cooldown — 30 minutes for a provider challenge / HTTP 429, 1.5 s
for any other upstream failure. While a cooldown is active, queued and new
searches are rejected with `RATE_LIMITED` and `retryAfterMs`; when at most 10 s
remain, the search is instead admitted and waits out the remainder in place
before dispatching. The search that triggered the cooldown still returns its
own upstream error.

### `fetch_page`

Input:

```ts
{ url: string /* trim 1..2048, http/https only */ }
```

Output (`structuredContent` and `content[0].text` are the same object):

```ts
{
  url: { requested; final | null },
  page: { title; siteName; byline; language },
  rendered: boolean,
  extraction: "source" | "readability" | "plain_text" | "none",
  decision: { source: "model" | "fallback" | "error" | "none"; model | null; needsRender | null },
  content: { format: "markdown" | "text"; text; chars },
  status: "ok" | "failed",
  error?: { code; message; retryable; retryAfterMs? }
}
```

Pipeline:

1. SSRF validation (scheme, credentials, port 80/443, private/loopback/link-local
   hosts and IP literals, per-hop redirect checks).
2. One probe GET (`Accept: text/markdown, text/html;q=0.9, ...`, manual
   redirects, body cap 2 MiB). `text/markdown` / `text/plain` is returned
   directly (`extraction: "source"`).
3. One OpenRouter decisions call asking `needs_render` (`noul` in `[0,1]`).
   Missing key, non-2xx, timeout or malformed answer → `decision.source: "error"`
   and static HTML is used.
4. If `needs_render >= 0.5` and the browser is enabled, render once with
   Browser Run and keep the rendered HTML only if the render succeeds;
   otherwise the static HTML is used.
5. Extract with Readability → Markdown; on failure, fall back to plain text.
   Only an empty result is an objective failure (`NOT_READABLE`).

The full content is returned untruncated; truncation is the caller's job.
Recoverable failures (`decision: "error"`, `RENDER_FAILED`) still yield
`status: "ok"` when extraction succeeds.

#### Timeouts

There is no whole-call deadline. Each potentially hanging operation has its own
bound, and termination comes from these timeouts plus bounded page, attempt and
redirect counts.

| Operation | Bound |
| --- | --- |
| `search_ddg` upstream attempt (headers + body) | 10 s |
| Probe redirect hop (headers + body) | 15 s |
| Decisions call (secret fetch + request + body) | 8 s |
| Browser launch | 20 s |
| Browser navigation | 20 s |
| Browser setup / `content()` call | 20 s |
| Browser close (giving up is acceptable) | 5 s |
| Rendered settling wait (intentional, not a timeout) | 3 s |

A per-operation timeout is not a new wire error: a stalled `search_ddg` attempt
surfaces as an `UPSTREAM_ERROR` and feeds the retry/cooldown policy, and a
stalled render surfaces as `RENDER_FAILED`. `ABORTED` and `search_ddg`'s
`TIMEOUT` are kept in the schemas for wire compatibility but are no longer
emitted.

Synchronous CPU work after the body is read (HTML parsing, Readability,
Markdown conversion, feature collection) cannot be interrupted by these timers;
it is bounded by the 2 MiB body cap.

#### Request security and residual risk

- Every probe redirect is re-validated. Browser navigation requests (and their
  redirect chains) are validated when request interception is available.
- Workers `fetch` resolves DNS inside the platform, so hostname checks cannot
  defend against DNS rebinding; browser subrequests (scripts, frames, XHR) are
  outside this boundary. This is a documented limitation, not a claimed
  guarantee.
- Output never truncates content, and logs never contain content, query values,
  cookies or credentials.

## Deploy

```sh
npm install
npm run cf-typegen     # regenerate worker-configuration.d.ts after config changes
npm run typecheck
npm run deploy
```

Local development: copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars`
(`ENVIRONMENT=development`, `MCP_DOMAIN=localhost`, optional `DEV_PRINCIPAL`) and
run `npm run dev`. Plain local dev cannot resolve Secrets Store secrets, so the
decision path fails over to static HTML; use a remote-bindings setup
(`wrangler dev --remote`) to exercise the model and browser.

## Observability

- `search_ddg`: one JSON line per search (`event: "ddg_search"`) with status,
  count, pages, dispatches, wait/elapsed time and error info.
- `fetch_page`: one JSON line per call (`event: "fetch_page"`) with status,
  rendered, extraction, format, decision source/model/needsRender, `renderMs`,
  `elapsedMs`, `redirects`, `finalHost`, `bytes` and `chars`.

Query strings, page URLs, content and credentials are never logged. Alert on
`PROVIDER_CHALLENGE` / `RATE_LIMITED`, `exceededCpu`, and a rising
`decision.source: "error"` rate for `fetch_page`.

## Phase 0 findings

- `POST https://openrouter.ai/api/v1/systemone` with
  `{ model: "typesafe/jev-1.13", state, questions }` returns
  `answers.needs_render = { type: "noul", noul }`; validated with real bindings.
- workerd rejects `redirect: "error"` at runtime (`Invalid redirect value`), so
  the decisions request uses `redirect: "manual"` and treats any non-2xx
  (including 3xx) as a decision failure.
- `@cloudflare/puppeteer@1.4.0` has no `page.waitForTimeout`; the render waits
  with a plain timer. `launch`, `newPage`, `goto`, `content` and `close` were
  exercised through the Browser Run binding.
- `RENDER_THRESHOLD` is not calibrated; the bundled fixtures only verify
  behaviour, not the threshold.

## Testing

```sh
npm test          # workerd (Cloudflare runtime)
npm run test:node # Node-only subset
```

On Termux/Android, see [`TERMUX.md`](./TERMUX.md).
