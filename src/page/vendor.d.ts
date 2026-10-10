declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
    linkStyle?: "inlined" | "referenced";
    [key: string]: unknown;
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    use(plugin: unknown): this;
    addRule(key: string, rule: unknown): this;
    keep(filter: unknown): this;
    remove(filter: unknown): this;
    turndown(input: unknown): string;
  }
}

declare module "turndown-plugin-gfm" {
  export const gfm: unknown;
  export const tables: unknown;
  export const strikethrough: unknown;
  export const taskListItems: unknown;
  export const highlightedCodeBlock: unknown;
}
