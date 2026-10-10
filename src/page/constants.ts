/** Fixed tuning values for the `fetch_page` pipeline. */

/** Hard upper bound for the input URL. */
export const MAX_URL_LENGTH = 2048;
/** Maximum number of redirect hops followed by the probe. */
export const MAX_REDIRECTS = 5;
/** Upper bound for a single GET (including body read). */
export const FETCH_ATTEMPT_TIMEOUT_MS = 15_000;
/** The single total deadline shared by every stage of one tool call. */
export const PAGE_RUN_DEADLINE_MS = 45_000;
/** Hard cap for the decoded response body (and the rendered HTML). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Maximum number of visible-text characters sent to the decision model. */
export const SAMPLE_CHARS = 1500;
/** `needs_render` value at or above which the page is rendered. */
export const RENDER_THRESHOLD = 0.5;
/** Minimum article length Readability accepts before falling back. */
export const READABILITY_CHAR_THRESHOLD = 250;
/** Upper bound for the single OpenRouter decisions request. */
export const DECISION_TIMEOUT_MS = 8_000;
/** Upper bound for one browser navigation. */
export const BROWSER_NAV_TIMEOUT_MS = 20_000;
/** Settling wait after the browser reaches `domcontentloaded`. */
export const RENDERED_WAIT_MS = 3_000;

/** OpenRouter System One / Decisions endpoint (decisions shape). */
export const OPENROUTER_DECISIONS_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
/** OpenRouter slug resolved through the `typesafe/` namespace. */
export const JEVIE_MODEL = "typesafe/jev-1.13";
/** Stable, non-identifying User-Agent prefix. */
export const USER_AGENT_NAME = "mcp-server-web-access/0.1";
/** `Accept` header advertised to upstream servers. */
export const ACCEPT_HEADER = "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8";
