/**
 * The single OpenRouter decisions call answering `needs_render`.
 *
 * Exactly one fixed-endpoint request per tool call. Any failure — missing
 * secret, non-2xx, timeout/cancel, malformed JSON, schema mismatch — is
 * normalised to `source: "error"`, which the caller treats as "no render".
 * The credential is only ever used as the `Authorization` header and is never
 * logged, measured, or included in an error.
 */
import { DECISION_TIMEOUT_MS, JEVIE_MODEL, OPENROUTER_DECISIONS_ENDPOINT } from "./constants";
import { operationWindow, withTimeout } from "./timeout";
import type { PageSnapshot, RouteDecision } from "./types";

export interface DecisionOptions {
  fetch: typeof fetch;
  /** Resolves the Secrets Store value; may throw. */
  getApiKey: () => Promise<string>;
  /** Upper bound for the secret fetch plus the request. Defaults to `DECISION_TIMEOUT_MS`. */
  timeoutMs?: number;
}

const ERROR_DECISION: RouteDecision = {
  source: "error",
  model: JEVIE_MODEL,
  needsRender: null,
};

const TIMEOUT_MESSAGE = "the decision request exceeded its deadline";

export async function decideNeedsRender(
  snapshot: PageSnapshot,
  options: DecisionOptions,
): Promise<RouteDecision> {
  // One window covers the secret fetch, the HTTP request and the response
  // body; `withTimeout` guarantees settlement even when neither propagates the
  // abort.
  const window = operationWindow(options.timeoutMs ?? DECISION_TIMEOUT_MS);
  try {
    let apiKey: string;
    try {
      apiKey = await withTimeout(options.getApiKey(), window.remaining(), TIMEOUT_MESSAGE);
    } catch {
      return ERROR_DECISION;
    }

    const response = await withTimeout(
      options.fetch(OPENROUTER_DECISIONS_ENDPOINT, {
        method: "POST",
        // workerd rejects `redirect: "error"` at runtime (`Invalid redirect
        // value`), so `manual` is used and every non-2xx (including 3xx) is
        // treated as a decision failure below. The intent (no redirect follow)
        // is preserved.
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: JEVIE_MODEL,
          state: buildState(snapshot),
          questions: QUESTIONS,
        }),
        signal: window.signal,
      }),
      window.remaining(),
      TIMEOUT_MESSAGE,
    );

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return ERROR_DECISION;
    }

    let payload: unknown;
    try {
      payload = await withTimeout(response.json(), window.remaining(), TIMEOUT_MESSAGE);
    } catch {
      return ERROR_DECISION;
    }

    const noul = readNoul(payload);
    if (noul === null) return ERROR_DECISION;
    return { source: "model", model: JEVIE_MODEL, needsRender: noul };
  } catch {
    return ERROR_DECISION;
  } finally {
    window.dispose();
  }
}

function readNoul(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const answers = (payload as Record<string, unknown>)["answers"];
  if (typeof answers !== "object" || answers === null) return null;
  const answer = (answers as Record<string, unknown>)["needs_render"];
  if (typeof answer !== "object" || answer === null) return null;
  const record = answer as Record<string, unknown>;
  if (record["type"] !== "noul") return null;
  const noul = record["noul"];
  if (typeof noul !== "number" || !Number.isFinite(noul)) return null;
  if (noul < 0 || noul > 1) return null;
  return noul;
}

function buildState(snapshot: PageSnapshot): Record<string, unknown> {
  const features = snapshot.features;
  return {
    http_status: snapshot.status,
    content_type: snapshot.mime,
    title: features.title,
    text_chars: features.textChars,
    block_count: features.blockCount,
    structure: features.structure,
    script: {
      count: features.script.count,
      bytes_ratio: Number(features.script.bytesRatio.toFixed(4)),
      empty_app_root: features.script.emptyAppRoot,
      has_noscript: features.script.hasNoscript,
    },
    sample: features.sample,
  };
}

const QUESTIONS = {
  needs_render: {
    type: "noul",
    instructions:
      "Is this page a JavaScript-rendered page whose main content is missing from the static HTML?",
    criteria: {
      true: "The static HTML is an app shell: little or no main text, and the content is produced by JavaScript.",
      false: "The static HTML already contains the page's main content.",
    },
  },
} as const;

/** Maps a decision to the render trigger. */
export function needsRender(decision: RouteDecision, threshold: number): boolean {
  return (
    decision.source === "model" &&
    decision.needsRender !== null &&
    decision.needsRender >= threshold
  );
}
