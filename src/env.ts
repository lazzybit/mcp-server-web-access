/**
 * Config values read by the app. Widens the `vars` literals from the generated
 * `Env` and adds `.dev.vars` keys; `Env` is assignable to `AppEnv`.
 */
export interface AppEnv {
  ENVIRONMENT: string;
  LOG_LEVEL?: "debug" | "info" | "warn" | "error";
  DEV_PRINCIPAL?: string;
  TEAM_DOMAIN: string;
  APPLICATION_AUD: string;
  /**
   * Optional VPC Network binding: when present, upstream egress uses it instead
   * of the built-in fetch. A failing VPC fetch is reported as an upstream error.
   */
  SEARCH_VNC?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  /**
   * Browser kill switch. Widened from the generated `"true"` literal so the
   * `"false"` test binding and runtime comparisons type-check.
   */
  BROWSER_ENABLED?: string;
  /** Browser Run binding, brokered by `BrowserService` for the browser provider and `fetch_page`. */
  BROWSER?: unknown;
}
