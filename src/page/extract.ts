/**
 * Extraction pipeline.
 *
 * Exactly one shape: try Readability first; when it fails or yields nothing,
 * fall back to plain text. Static HTML and browser-rendered HTML share this
 * same code path.
 */
import { Readability } from "@mozilla/readability";
import { HTMLElement, parseHTML } from "linkedom/worker";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { READABILITY_CHAR_THRESHOLD } from "./constants";
import type { ExtractionResult } from "./types";

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dd",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

// linkedom's worker build does not implement `HTMLTableElement.rows`, which the
// GFM turndown plugin relies on. Providing it on the shared prototype survives
// turndown's internal `cloneNode`.
Object.defineProperty(HTMLElement.prototype, "rows", {
  configurable: true,
  get(this: { nodeName: string; querySelectorAll(selector: string): ArrayLike<unknown> }) {
    if (this.nodeName !== "TABLE") return undefined;
    return Array.from(this.querySelectorAll("tr"));
  },
});

/** Runs the full extraction pipeline; `null` when nothing readable remains. */
export function extract(html: string, url: string): ExtractionResult | null {
  const readable = tryReadability(html, url);
  if (readable !== null && readable.text.trim() !== "") return readable;

  const text = htmlToPlainText(html);
  if (text.trim() === "") return null;
  return {
    format: "text",
    text,
    method: "plain_text",
    title: null,
    siteName: null,
    byline: null,
    language: null,
  };
}

/** Readability → Markdown, resolving relative links against `url`. */
export function tryReadability(html: string, url: string): ExtractionResult | null {
  const parsed = parseHTML(html);
  const document = parsed.document;
  Object.defineProperty(document, "baseURI", { value: url, configurable: true });
  Object.defineProperty(document, "documentURI", { value: url, configurable: true });

  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document as never, {
      charThreshold: READABILITY_CHAR_THRESHOLD,
    }).parse();
  } catch {
    return null;
  }
  if (article === null || typeof article.content !== "string" || article.content.trim() === "") {
    return null;
  }

  const text = toMarkdown(article.content);
  if (text.trim() === "") return null;
  return {
    format: "markdown",
    text,
    method: "readability",
    title: article.title ?? null,
    siteName: article.siteName ?? null,
    byline: article.byline ?? null,
    language: article.lang ?? null,
  };
}

function toMarkdown(articleContent: string): string {
  const parsed = parseHTML(`<div id="turndown-root">${articleContent}</div>`);
  const root = parsed.document.getElementById("turndown-root");
  if (root === null) return "";
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(gfm);
  try {
    return service.turndown(root);
  } catch {
    return "";
  }
}

interface WalkNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<WalkNode>;
}

interface PlainDocument {
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
  body: WalkNode | null;
  documentElement: WalkNode;
}

/** Removes non-content tags and renders the remaining text with block breaks. */
export function htmlToPlainText(html: string): string {
  const document = parseHTML(html).document as unknown as PlainDocument;
  for (const element of Array.from(
    document.querySelectorAll("script, style, noscript, template, head, title"),
  )) {
    element.remove();
  }
  const root = document.documentElement;
  return normalizePlainText(collectText(root));
}

function collectText(node: WalkNode | null): string {
  if (node === null) return "";
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const tag = node.nodeName.toLowerCase();
  let inner = "";
  const children = node.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child !== undefined) inner += collectText(child);
  }
  if (tag === "br") return `\n${inner}`;
  if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
  return inner;
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
