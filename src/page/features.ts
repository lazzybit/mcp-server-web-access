/**
 * Static-HTML evidence collection and non-content filtering for the decision
 * model, using Workers `HTMLRewriter`.
 *
 * A single `on("*")` pass accumulates the decision evidence, removes
 * non-content markup (`script` except JSON-LD, `style`, `svg`) and strips
 * inline `data:` assets; `onDocument` removes HTML comments. The removal does
 * not change the evidence: `HTMLRewriter` still invokes the handlers for a
 * removed subtree, so counts and `script.bytesRatio` stay as they were when
 * the whole body was parsed unfiltered.
 *
 * `HTMLRewriter`'s `text` callback is invoked once per text node for the single
 * `*` handler. Because the callback carries no element context, an element
 * stack maintained through `onEndTag` is used to skip `script`/`style`/`head`
 * content and to detect empty application roots.
 */
import { SAMPLE_CHARS } from "./constants";
import type { PageFeatures } from "./types";

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "title"]);
const NON_CONTENT_TAGS = new Set(["script", "style", "svg"]);
const JSON_LD_SCRIPT_TYPE = "application/ld+json";
const URL_ATTRIBUTES = ["src", "href", "poster", "data"];
const SRCSET_ATTRIBUTES = ["srcset", "imagesrcset"];
const STYLE_URL_DATA = /url\(\s*(['"]?)data:[^)]*\1\s*\)/gi;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "td",
  "th",
  "blockquote",
  "figcaption",
  "dd",
  "dt",
]);
const STRUCTURE_TAGS = ["p", "h2", "h3", "pre", "table", "li", "a", "img"] as const;
const APP_ROOT_IDS = new Set(["root", "app", "__next", "__nuxt", "__gatsby", "main"]);

interface Frame {
  tag: string;
  skip: boolean;
  appRoot: boolean;
  block: boolean;
}

interface State {
  title: string;
  language: string | null;
  textChars: number;
  blockCount: number;
  structure: Record<string, number>;
  scriptCount: number;
  scriptBytes: number;
  hasNoscript: boolean;
  appRootSeen: boolean;
  appRootHasText: boolean;
  sampleRaw: string;
}

function initialState(): State {
  const structure: Record<string, number> = {};
  for (const tag of STRUCTURE_TAGS) structure[tag] = 0;
  return {
    title: "",
    language: null,
    textChars: 0,
    blockCount: 0,
    structure,
    scriptCount: 0,
    scriptBytes: 0,
    hasNoscript: false,
    appRootSeen: false,
    appRootHasText: false,
    sampleRaw: "",
  };
}

export interface EvidenceRewriter {
  /** The streaming pass that filters non-content markup and tallies evidence. */
  rewriter: HTMLRewriter;
  /** Builds the feature set; `rawBytes` is the UTF-8 length before filtering. */
  finish(rawBytes: number): PageFeatures;
}

/**
 * Creates the evidence/filter rewriter. The same instance must only be
 * transformed once; call the factory again for another pass.
 */
export function createEvidenceRewriter(sampleChars: number = SAMPLE_CHARS): EvidenceRewriter {
  const state = initialState();
  const stack: Frame[] = [];

  const rewriter = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        const keepScript = tag === "script" && isJsonLd(element);
        const id = element.getAttribute("id");
        const appRoot = id !== null && APP_ROOT_IDS.has(id.toLowerCase());
        const frame: Frame = {
          tag,
          skip: SKIP_TAGS.has(tag),
          appRoot,
          block: BLOCK_TAGS.has(tag),
        };

        if (tag === "html") {
          const lang = element.getAttribute("lang");
          state.language = lang !== null && lang.trim() !== "" ? lang.trim() : null;
        }
        if (tag === "script") state.scriptCount += 1;
        if (tag === "noscript") state.hasNoscript = true;
        if (appRoot) state.appRootSeen = true;
        if (frame.block) state.blockCount += 1;
        const structureCount = state.structure[tag];
        if (structureCount !== undefined) state.structure[tag] = structureCount + 1;

        stripInlineAssets(element);
        if (NON_CONTENT_TAGS.has(tag) && !keepScript) element.remove();

        if (!VOID_TAGS.has(tag)) {
          try {
            element.onEndTag(() => {
              stack.pop();
              if (frame.block && !frame.skip) {
                const underSkip = stack.some((ancestor) => ancestor.skip);
                if (!underSkip && !state.sampleRaw.endsWith("\n")) {
                  appendSample(state, "\n", sampleChars);
                }
              }
            });
            stack.push(frame);
          } catch {
            // Foreign/self-closing element without a synthesised end tag.
          }
        }
      },
      text(text) {
        const value = text.text;
        if (value === "") return;
        const frame = stack[stack.length - 1];
        if (frame !== undefined && frame.tag === "script") {
          state.scriptBytes += byteLength(value);
        }
        if (frame !== undefined && frame.tag === "title") {
          state.title += value;
          return;
        }
        if (stack.some((ancestor) => ancestor.skip)) return;
        if (value.trim() === "") return;
        state.textChars += value.length;
        if (stack.some((ancestor) => ancestor.appRoot)) state.appRootHasText = true;
        appendSample(state, value, sampleChars);
      },
    });

  return {
    rewriter,
    finish(rawBytes: number): PageFeatures {
      const title = decodeEntities(state.title).trim();
      return {
        title: title === "" ? null : title,
        language: state.language,
        textChars: state.textChars,
        blockCount: state.blockCount,
        structure: state.structure,
        script: {
          count: state.scriptCount,
          bytesRatio: rawBytes === 0 ? 0 : state.scriptBytes / rawBytes,
          emptyAppRoot: state.appRootSeen && !state.appRootHasText,
          hasNoscript: state.hasNoscript,
        },
        sample: normalizeSample(decodeEntities(state.sampleRaw), sampleChars),
      };
    },
  };
}

export async function collectFeatures(
  html: string,
  sampleChars: number = SAMPLE_CHARS,
): Promise<PageFeatures> {
  const { rewriter, finish } = createEvidenceRewriter(sampleChars);
  await rewriter
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();
  return finish(byteLength(html));
}

function isJsonLd(element: Element): boolean {
  const type = element.getAttribute("type");
  return type !== null && type.trim().toLowerCase() === JSON_LD_SCRIPT_TYPE;
}

/** Removes inline `data:` assets while keeping ordinary URLs and descriptors. */
function stripInlineAssets(element: Element): void {
  // Collect first: mutating attributes invalidates the iterator in workerd.
  const attributes: Array<[string, string]> = [];
  for (const attribute of element.attributes) {
    const name = attribute[0];
    const value = attribute[1];
    if (name !== undefined && value !== undefined) attributes.push([name.toLowerCase(), value]);
  }
  for (const [name, value] of attributes) {
    if (URL_ATTRIBUTES.includes(name)) {
      if (value.trim().toLowerCase().startsWith("data:")) element.removeAttribute(name);
      continue;
    }
    if (SRCSET_ATTRIBUTES.includes(name)) {
      const filtered = stripDataSrcset(value);
      if (filtered === null) element.removeAttribute(name);
      else if (filtered !== value) element.setAttribute(name, filtered);
      continue;
    }
    if (name === "style") {
      const stripped = value.replace(STYLE_URL_DATA, "");
      if (stripped === value) continue;
      const filtered = stripped.trim();
      if (filtered === "") element.removeAttribute(name);
      else element.setAttribute(name, filtered);
    }
  }
}

/**
 * Drops `data:` candidates from a `srcset` value, keeping other URL/descriptor
 * pairs. Splitting on commas would corrupt data URLs, so the URL token runs to
 * the first whitespace while descriptors run (paren-aware) to the next comma.
 */
function stripDataSrcset(value: string): string | null {
  const candidates: string[] = [];
  const length = value.length;
  let index = 0;
  while (index < length) {
    while (index < length && (isAsciiWhitespace(value[index]) || value[index] === ",")) index += 1;
    if (index >= length) break;
    const urlStart = index;
    while (index < length && !isAsciiWhitespace(value[index])) index += 1;
    let url = value.slice(urlStart, index);
    let descriptors = "";
    let terminatedByComma = false;
    while (url.endsWith(",")) {
      url = url.slice(0, -1);
      terminatedByComma = true;
    }
    if (!terminatedByComma) {
      const descriptorStart = index;
      let depth = 0;
      while (index < length) {
        const char = value[index];
        if (char === "(") depth += 1;
        else if (char === ")") depth = Math.max(0, depth - 1);
        else if (char === "," && depth === 0) break;
        index += 1;
      }
      descriptors = value.slice(descriptorStart, index).trim();
    }
    if (index < length && value[index] === ",") index += 1;
    if (url === "" || url.toLowerCase().startsWith("data:")) continue;
    candidates.push(descriptors === "" ? url : `${url} ${descriptors}`);
  }
  return candidates.length === 0 ? null : candidates.join(", ");
}

function isAsciiWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f";
}

/** Bounded sample accumulation, including block separators. */
function appendSample(state: State, value: string, sampleChars: number): void {
  const limit = sampleChars * 2;
  if (state.sampleRaw.length >= limit) return;
  const remaining = limit - state.sampleRaw.length;
  state.sampleRaw += value.length > remaining ? value.slice(0, remaining) : value;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** HTMLRewriter returns raw text nodes; decode entities for the model. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function normalizeSample(raw: string, limit: number): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
