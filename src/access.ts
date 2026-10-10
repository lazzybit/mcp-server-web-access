import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import type { AppEnv } from "./env";

/** Identity from the validated `Cf-Access-Jwt-Assertion` payload. */
export interface Principal {
  subject: string;
  email?: string;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

// Built once per trusted issuer; `createRemoteJWKSet` caches keys internally.
const jwksCache = new Map<string, JwksResolver>();

/**
 * `TEAM_DOMAIN` holds a bare domain; the HTTPS issuer origin is derived here.
 * A leading scheme or trailing slash is tolerated and stripped.
 */
function issuerUrl(teamDomain: string): string {
  const domain = teamDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return `https://${domain}`;
}

function jwksFor(issuer: string): JwksResolver {
  const cached = jwksCache.get(issuer);
  if (cached !== undefined) return cached;
  const resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksCache.set(issuer, resolver);
  return resolver;
}

/**
 * Verifies the Access assertion. Signature, `iss`, `aud` and `exp` are
 * required; failures throw {@link AuthenticationError}.
 */
export async function authenticate(request: Request, env: AppEnv): Promise<Principal> {
  if (
    env.ENVIRONMENT === "development" &&
    typeof env.DEV_PRINCIPAL === "string" &&
    env.DEV_PRINCIPAL.length > 0
  ) {
    return parseDevPrincipal(env.DEV_PRINCIPAL);
  }

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion === null || assertion.length === 0) {
    throw new AuthenticationError("missing Cf-Access-Jwt-Assertion header");
  }

  let payload: JWTPayload;
  try {
    const issuer = issuerUrl(env.TEAM_DOMAIN);
    const verified = await jwtVerify(assertion, jwksFor(issuer), {
      issuer,
      audience: env.APPLICATION_AUD,
    });
    payload = verified.payload;
  } catch (error) {
    throw new AuthenticationError(
      error instanceof Error ? error.message : "invalid Access assertion",
    );
  }

  // Require an explicit expiry; jose only validates `exp` when present.
  if (typeof payload.exp !== "number") {
    throw new AuthenticationError("assertion is missing an expiry claim");
  }
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new AuthenticationError("assertion is missing a subject");
  }

  const principal: Principal = { subject };
  const email = payload["email"];
  if (typeof email === "string" && email.length > 0) {
    principal.email = email;
  }
  return principal;
}

function parseDevPrincipal(raw: string): Principal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthenticationError("DEV_PRINCIPAL is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AuthenticationError("DEV_PRINCIPAL must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const subject = record["subject"];
  if (typeof subject !== "string" || subject.length === 0) {
    throw new AuthenticationError("DEV_PRINCIPAL must contain a subject");
  }
  const principal: Principal = { subject };
  if (typeof record["email"] === "string" && record["email"].length > 0) {
    principal.email = record["email"];
  }
  return principal;
}
