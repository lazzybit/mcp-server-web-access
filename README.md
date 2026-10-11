# mcp-server-web-access

Remote MCP server (Streamable HTTP) on Cloudflare Workers, exposing two tools:

- `search_topic` — web search with cross-provider fallback, backed by a Durable Object.
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
              │ search_topic                               │ fetch_page
              ▼                                            ▼
   SearchService Durable Object                 src/page/*
   (singleton "global")                         ├─ probe (one bounded GET)
              │                                 ├─ OpenRouter decisions (needs_render)
              ▼                                 ├─ Browser Run (one render, if needed)
   DuckDuckGo HTML endpoint                     └─ Readability → plain text
              │                                            │
              └──────────────┬─────────────────────────────┘
                             ▼
              BrowserService Durable Object (singleton "global")
              one reusable Browser Run session id; one incognito
              context per operation, 60 s idle keep_alive
```

The Worker authenticates, serves MCP and validates input/output.

- `search_topic`: `SearchService` owns an ordered provider list (`ddg-html`,
  plus `ddg-browser` when enabled). For each complete search the coordinator
  tries the first ready provider and, on a challenge or any other failure,
  switches to the next ready provider within the same search, carrying partial
  results over. Each provider owns its pagination, spacing, failure state and
  cooldown; only when no provider is ready does the coordinator wait a bounded
  amount before returning `NO_SEARCH_PROVIDER_AVAILABLE`.
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
| `BROWSER_ENABLED` | no | `true` / `false` | Browser kill switch for the `fetch_page` render and the `search_topic` browser provider. Defaults to `true`. |

`MCP_DOMAIN` and `TEAM_DOMAIN` are never derived from a request. `TEAM_DOMAIN` is
a bare domain: the issuer is `https://<TEAM_DOMAIN>` and the JWKS URL is
`https://<TEAM_DOMAIN>/cdn-cgi/access/certs`.

### Secrets and bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Secrets Store secret | OpenRouter API key (secret name `openrouter_api_key`, scope `workers`). Read via `await env.OPENROUTER_API_KEY.get()` and used only as the `Authorization: Bearer` header for the decisions request. |
| `BROWSER` | Browser Run | Headless Chromium for the optional `fetch_page` render and the `search_topic` browser provider. Accessed only through the `BrowserService` session broker. |
| `SEARCH_SERVICE` | Durable Object | The search service (singleton `global`). |
| `BROWSER_SERVICE` | Durable Object | The Browser Run session broker (singleton `global`). Owns one reusable `sessionId`; never holds a browser object. |
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

### `search_topic`

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

Provider selection: `SearchService` owns an ordered provider list — `ddg-html`
always, and `ddg-browser` when `BROWSER_ENABLED !== "false"` and the `BROWSER`
binding exists. For each complete search the coordinator tries the first ready,
untried provider; on a challenge or any other failure it moves to the next
ready provider within the same search, carrying over any partial results. Each
provider owns its pagination, spacing, failure state and cooldown under its own
storage namespace:

- `ddg-html` (`search/providers/v2/ddg-html/state`): a fixed 5 s minimum between
dispatch starts, across pagination and consecutive searches. A challenge (or
HTTP 429) immediately opens a 30-minute cooldown; a network/parser failure opens
a 1.5 s cooldown. Both hand the partial results to the coordinator and switch
providers; there is no same-provider retry.
- `ddg-browser` (`search/providers/v2/ddg-browser/state`): the same cooldown
split (30 minutes for a challenge, 1.5 s otherwise), no dispatch pacing and no
quota system. Searches are serialized so one browser search runs at a time; each
search connects to the shared session below in its own incognito context.

#### Shared Browser Run session

Both browser call sites go through one `BrowserService` Durable Object
(`global`), which brokers a single Browser Run session id:

- The broker acquires a session with `keep_alive: 60_000` only when none is
  stored or when the stored id is confirmed absent by `puppeteer.sessions()`. A
  failing `sessions()` call keeps the stored id: a duplicate session is worse
  than a possibly stale one.
- Callers `puppeteer.connect()` themselves and run the whole operation in a
  private `createBrowserContext()`. Cleanup closes only that context and the
  operation's own CDP connection, so cookies and storage never leak and the
  shared session is never closed for other callers.
- Concurrent callers may share the session, each with its own context; browser
  operations are no longer serialized globally, while the `ddg-browser`
  provider keeps its own FIFO. A failed connect refreshes the session at most
  once, and only when the broker returns a different id; navigation and
  pagination are never replayed.
- The id lives in Durable Object storage, so eviction is harmless and the next
  call reconnects. `keep_alive` closes the session after 60 s of inactivity;
  there is no alarm, heartbeat or explicit shutdown.

Only when no provider is ready does the coordinator wait: it waits for the
soonest recovering provider when the remainder is at most 10 s (`10_000` waits,
`10_001` does not), at most once per provider, and never while another provider
is usable. After that bounded fallback the search is `interrupted` with the
retained partial results, or `failed` + `NO_SEARCH_PROVIDER_AVAILABLE` with
`retryAfterMs` set to the minimum known provider recovery. `ok`, `exhausted`
(including zero matches) and `PAGE_LIMIT` are complete outcomes and stop the
fallback; a `PAGE_LIMIT` surfaces as `interrupted`.

The `ddg-browser` provider drives the JavaScript `duckduckgo.com` site with the
desktop Chrome User-Agent, viewport and `accept-language`, and paginates by
clicking the text-matched `More results` button up to `MAX_PAGES` batches. URLs
are normalized and deduplicated across batches through the same
`normalizeResultUrl`.

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
| `search_topic` upstream attempt (headers + body) | 10 s |
| `search_topic` browser provider session acquisition | 20 s |
| `search_topic` browser provider connect / context creation | 20 s each |
| `search_topic` browser provider navigation | 20 s |
| `search_topic` browser provider setup / extraction / click | 20 s each |
| `search_topic` browser provider result wait (shared across polls) | 15 s per load |
| `search_topic` browser provider context close / disconnect (giving up is acceptable) | 5 s |
| Probe redirect hop (headers + body) | 15 s |
| Decisions call (secret fetch + request + body) | 8 s |
| Browser session acquisition (broker) | 20 s |
| Browser connect / context creation | 20 s each |
| Browser navigation | 20 s |
| Browser setup / `content()` call | 20 s |
| Browser context close / disconnect (giving up is acceptable) | 5 s |
| Rendered settling wait (intentional, not a timeout) | 3 s |

A per-operation timeout is not a new wire error: a stalled `search_topic`
attempt surfaces as an `UPSTREAM_ERROR` and opens the provider's transient
cooldown, and a stalled render surfaces as `RENDER_FAILED`. `ABORTED` and
`search_topic`'s `TIMEOUT` are kept in the schemas for wire compatibility but
are no longer emitted.

Synchronous CPU work after the body is read (HTML parsing, Readability,
Markdown conversion, feature collection) cannot be interrupted by these timers;
it is bounded by the 2 MiB body cap.

#### Browser provider residual risk

- The browser provider depends on an emulated desktop-browser fingerprint;
  DuckDuckGo may change its detection at any time, so challenge detection is
  mandatory and a challenge opens the provider's 30-minute cooldown.
- Browser Run can fail with `429` on session acquisition; such a failure opens
  the browser provider's 1.5 s transient cooldown and the coordinator may still
  return `NO_SEARCH_PROVIDER_AVAILABLE` when no provider recovers.
- The worst case for one browser search is finite: session acquisition 20 s +
  connect 20 s + context 20 s + `newPage` 20 s + setup 20 s + navigation 20 s +
  results 15 s + extraction 20 s + up to four loads of (click 20 s + wait 15 s) +
  close 5 s.
- `withTimeout` does not cancel remote work, and synchronous parsing is not
  interruptible; a session acquisition, connect or context creation that
  resolves after its timeout is disconnected/closed under a bound, but a leaked
  remote session cannot be strictly guaranteed against.

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

- `search_topic`: one provider line per attempt (`event: "search_provider"`,
  with provider id, status, count, pages, dispatches, elapsed time and error
  code) plus one coordinator line per search (`event: "search_coordinator"`,
  with status, count, requested, the providers tried, elapsed time and error
  info).
- `fetch_page`: one JSON line per call (`event: "fetch_page"`) with status,
  rendered, extraction, format, decision source/model/needsRender, `renderMs`,
  `elapsedMs`, `redirects`, `finalHost`, `bytes` and `chars`.

Query strings, page URLs, content and credentials are never logged. Alert on
`NO_SEARCH_PROVIDER_AVAILABLE`, provider `PROVIDER_CHALLENGE` log lines,
`exceededCpu`, and a rising `decision.source: "error"` rate for `fetch_page`.

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
- The browser provider was verified through a throwaway, token-gated Browser
  Run worker: the JavaScript DuckDuckGo page returned the challenge under the
  default headless configuration and returned results under one combined
  configuration (desktop Chrome UA + viewport + `accept-language`). 10 result
  containers were observed, and clicking the text-matched `More results` button
  twice produced 40 containers. Ad exclusion, the explicit no-results/last-page
  markers and the real effect of `kl`/`df` remain unverified; the 10 → 40 figure
  is a container count, not a unique-URL count.

## Testing

```sh
npm test          # workerd (Cloudflare runtime)
npm run test:node # Node-only subset
```

On Termux/Android, see [`TERMUX.md`](./TERMUX.md).
