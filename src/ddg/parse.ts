/**
 * DuckDuckGo HTML parsing via the Workers-native `HTMLRewriter`. Parses a byte
 * stream; text is accumulated per element and finalised at element boundaries.
 */

export interface ParsedResult {
  title: string;
  url: string;
  domain: string;
  snippet: string | null;
}

/** Hidden fields of a forward "Next" form. */
export interface NextForm {
  fields: ReadonlyArray<readonly [string, string]>;
}

export type ParsedPage =
  | { kind: "results"; results: ParsedResult[]; next: NextForm | null }
  | { kind: "no_results" }
  | { kind: "challenge" }
  | { kind: "unparseable" };

const CHALLENGE_MARKERS = ["bots use", "select all squares"];

/** True for DuckDuckGo ad links. */
export function isAdHref(href: string): boolean {
  return /^(https?:)?\/\/duckduckgo\.com\/y\.js/.test(href.trim());
}

/**
 * Conservatively normalizes a result href: resolves relative URLs, unwraps the
 * `/l/?uddg=` redirect, drops the fragment, and rejects non-HTTP(S) targets.
 */
export function normalizeResultUrl(
  rawHref: string,
  base: string,
): { url: string; domain: string } | null {
  const href = rawHref.trim();
  if (href === "" || isAdHref(href)) return null;

  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (isDuckDuckGoAd(url)) return null;

  if (isDuckDuckGoRedirect(url)) {
    const target = url.searchParams.get("uddg");
    if (target !== null && target !== "") {
      try {
        url = new URL(target);
      } catch {
        return null;
      }
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isDuckDuckGoAd(url)) return null;
  url.hash = "";
  return { url: url.toString(), domain: url.hostname.toLowerCase() };
}

function isDuckDuckGoAd(url: URL): boolean {
  return isDuckDuckGoHost(url.hostname) && url.pathname === "/y.js";
}

function isDuckDuckGoRedirect(url: URL): boolean {
  return isDuckDuckGoHost(url.hostname) && url.pathname === "/l/";
}

function isDuckDuckGoHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
}

interface FormCandidate {
  action: string;
  hasNext: boolean;
  fields: Array<readonly [string, string]>;
}

/**
 * Parses one response into organic results and the forward "Next" form.
 *
 * @param body  Raw response bytes or a byte stream (fragmented chunks are
 *              handled by accumulating text until element boundaries).
 * @param status HTTP status; `202` is always a challenge.
 * @param base  Base URL used to resolve relative result hrefs.
 */
export async function parsePage(
  body: Uint8Array | ReadableStream<Uint8Array>,
  status: number,
  base: string,
): Promise<ParsedPage> {
  const response = body instanceof Uint8Array
    ? new Response(toStream(body))
    : new Response(body);

  const state = createState(base);
  const rewriter = buildRewriter(state);

  // The transform only runs while its body is consumed.
  await rewriter.transform(response).arrayBuffer();

  if (status === 202 || state.anomalyScript || hasChallengeMarker(state.docText)) {
    return { kind: "challenge" };
  }
  if (state.pending !== null) {
    state.results.push({ ...state.pending, snippet: null });
    state.pending = null;
  }
  if (state.results.length > 0) {
    return { kind: "results", results: state.results, next: state.nextForm };
  }
  if (state.noResultsElement || /no results\./.test(state.docText.toLowerCase())) {
    return { kind: "no_results" };
  }
  return { kind: "unparseable" };
}

interface ParseState {
  base: string;
  results: ParsedResult[];
  pending: { title: string; url: string; domain: string } | null;
  /** Href/domain of the currently open `a.result__a`, if usable. */
  currentAnchor: { url: string; domain: string } | null;
  collectingTitle: boolean;
  titleChunks: string;
  snippetChunks: string;
  buttonChunks: string;
  docText: string;
  anomalyScript: boolean;
  noResultsElement: boolean;
  formStack: FormCandidate[];
  nextForm: NextForm | null;
}

function createState(base: string): ParseState {
  return {
    base,
    results: [],
    pending: null,
    currentAnchor: null,
    collectingTitle: false,
    titleChunks: "",
    snippetChunks: "",
    buttonChunks: "",
    docText: "",
    anomalyScript: false,
    noResultsElement: false,
    formStack: [],
    nextForm: null,
  };
}

function buildRewriter(state: ParseState): HTMLRewriter {
  const rewriter = new HTMLRewriter();

  rewriter.onDocument({
    text(chunk) {
      state.docText += chunk.text;
    },
  });

  rewriter.on("script", {
    element(element) {
      const src = element.getAttribute("src");
      if (src !== null && src.toLowerCase().includes("/anomaly.js")) {
        state.anomalyScript = true;
      }
    },
  });

  rewriter.on(".no-results", {
    element() {
      state.noResultsElement = true;
    },
  });

  rewriter.on("a.result__a", {
    element(element) {
      // A new title flushes any result still waiting for a snippet.
      if (state.pending !== null) {
        state.results.push({ ...state.pending, snippet: null });
        state.pending = null;
      }
      state.currentAnchor = null;
      state.collectingTitle = false;
      state.titleChunks = "";

      const href = element.getAttribute("href");
      if (href !== null) {
        const normalized = normalizeResultUrl(href, state.base);
        if (normalized !== null) {
          state.currentAnchor = normalized;
          state.collectingTitle = true;
        }
      }

      element.onEndTag(() => {
        const anchor = state.currentAnchor;
        if (state.collectingTitle && anchor !== null) {
          const title = cleanText(state.titleChunks);
          if (title !== "") {
            state.pending = { title, url: anchor.url, domain: anchor.domain };
          }
        }
        state.collectingTitle = false;
        state.currentAnchor = null;
        state.titleChunks = "";
      });
    },
    text(chunk) {
      if (state.collectingTitle) state.titleChunks += chunk.text;
    },
  });

  rewriter.on("a.result__snippet", {
    element(element) {
      state.snippetChunks = "";
      element.onEndTag(() => {
        if (state.pending !== null) {
          const snippet = cleanText(state.snippetChunks);
          state.results.push({
            ...state.pending,
            snippet: snippet === "" ? null : snippet,
          });
          state.pending = null;
        }
        state.snippetChunks = "";
      });
    },
    text(chunk) {
      state.snippetChunks += chunk.text;
    },
  });

  rewriter.on("form", {
    element(element) {
      const candidate: FormCandidate = {
        action: element.getAttribute("action") ?? "",
        hasNext: false,
        fields: [],
      };
      state.formStack.push(candidate);
      element.onEndTag(() => {
        const done = state.formStack.pop();
        if (
          done !== undefined &&
          done.hasNext &&
          state.nextForm === null &&
          done.action.endsWith("/html/")
        ) {
          state.nextForm = { fields: done.fields };
        }
      });
    },
  });

  rewriter.on("input", {
    element(element) {
      const form = state.formStack[state.formStack.length - 1];
      if (form === undefined) return;
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      const value = element.getAttribute("value") ?? "";
      // Submit controls often have no `name`; check them before requiring one.
      if (type === "submit") {
        if (value.trim() === "Next") form.hasNext = true;
        return;
      }
      if (type === "button" || type === "image" || type === "reset") return;
      const name = element.getAttribute("name");
      if (name === null || name === "") return;
      form.fields.push([name, value]);
    },
  });

  rewriter.on("button", {
    element(element) {
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      const value = element.getAttribute("value") ?? "";
      state.buttonChunks = "";
      element.onEndTag(() => {
        const form = state.formStack[state.formStack.length - 1];
        if (form === undefined) return;
        if (type !== "" && type !== "submit") return;
        if (value.trim() === "Next" || state.buttonChunks.trim() === "Next") {
          form.hasNext = true;
        }
      });
    },
    text(chunk) {
      state.buttonChunks += chunk.text;
    },
  });

  return rewriter;
}

function hasChallengeMarker(docText: string): boolean {
  const lower = docText.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * `HTMLRewriter` text chunks are not entity-decoded; decode one level after
 * accumulation (entities may be split across chunks).
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return codePoint(Number.parseInt(body.slice(2), 16), match);
    }
    if (body.startsWith("#")) {
      return codePoint(Number.parseInt(body.slice(1), 10), match);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function codePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code)) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function cleanText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

/** Wraps a buffer in a stream; used when callers pass raw bytes. */
function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
