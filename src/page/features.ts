/**
 * Static-HTML evidence collection for the decision model, using
 * Workers `HTMLRewriter` on the already-buffered body.
 *
 * `HTMLRewriter`'s `text` callback is invoked once per text node for the single
 * `*` handler. Because the callback carries no element context, an element
 * stack maintained through `onEndTag` is used to skip `script`/`style`/`head`
 * content and to detect empty application roots.
 */
import { SAMPLE_CHARS } from "./constants";
import type { PageFeatures } from "./types";

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "title"]);
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

export async function collectFeatures(
  html: string,
  sampleChars: number = SAMPLE_CHARS,
): Promise<PageFeatures> {
  const state = initialState();
  const stack: Frame[] = [];

  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();
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

      if (!VOID_TAGS.has(tag)) {
        try {
          element.onEndTag(() => {
            stack.pop();
            if (frame.block && !frame.skip) {
              const underSkip = stack.some((ancestor) => ancestor.skip);
              if (!underSkip && !state.sampleRaw.endsWith("\n")) state.sampleRaw += "\n";
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
      if (state.sampleRaw.length < sampleChars * 2) state.sampleRaw += value;
    },
  });

  await rewriter
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();

  return {
    title: decodeEntities(state.title).trim() === "" ? null : decodeEntities(state.title).trim(),
    language: state.language,
    textChars: state.textChars,
    blockCount: state.blockCount,
    structure: state.structure,
    script: {
      count: state.scriptCount,
      bytesRatio: html.length === 0 ? 0 : state.scriptBytes / byteLength(html),
      emptyAppRoot: state.appRootSeen && !state.appRootHasText,
      hasNoscript: state.hasNoscript,
    },
    sample: normalizeSample(decodeEntities(state.sampleRaw), sampleChars),
  };
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
