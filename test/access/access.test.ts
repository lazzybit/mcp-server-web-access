import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationError, authenticate } from "../../src/access";
import type { AppEnv } from "../../src/env";

interface TestKey {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  jwk: JWK;
  /** Bare team domain, e.g. `team-1.cloudflareaccess.com`. */
  domain: string;
}

let counter = 0;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function makeKey(): Promise<TestKey> {
  counter += 1;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: `key-${counter}`, alg: "RS256" };
  return { privateKey, jwk, domain: `team-${counter}.cloudflareaccess.com` };
}

function stubJwks(key: TestKey): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${key.domain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [key.jwk] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ENVIRONMENT: "production",
    TEAM_DOMAIN: "example.cloudflareaccess.com",
    APPLICATION_AUD: "aud-tag",
    LOG_LEVEL: "info",
    ...overrides,
  };
}

async function signToken(
  key: TestKey,
  options: {
    audience?: string;
    issuer?: string;
    subject?: string;
    expiresAt?: number;
    omitExp?: boolean;
    email?: string;
  } = {},
): Promise<string> {
  let jwt = new SignJWT({ ...(options.email !== undefined ? { email: options.email } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: key.jwk.kid ?? `key-${counter}` })
    .setIssuer(options.issuer ?? `https://${key.domain}`)
    .setAudience(options.audience ?? "aud-tag")
    .setSubject(options.subject ?? "user-1")
    .setIssuedAt();
  if (options.omitExp !== true) {
    jwt = jwt.setExpirationTime(options.expiresAt ?? "5m");
  }
  return jwt.sign(key.privateKey);
}

function requestWith(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request("https://search-mcp.example.com/mcp", { headers });
}

describe("authenticate", () => {
  it("accepts a valid Access assertion (TEAM_DOMAIN is a bare domain)", async () => {
    const key = await makeKey();
    stubJwks(key);
    const token = await signToken(key, { email: "user@example.com" });
    const env = makeEnv({ TEAM_DOMAIN: key.domain, APPLICATION_AUD: "aud-tag" });

    await expect(authenticate(requestWith(token), env)).resolves.toEqual({
      subject: "user-1",
      email: "user@example.com",
    });
  });

  it("rejects a missing header", async () => {
    const key = await makeKey();
    stubJwks(key);
    const env = makeEnv({ TEAM_DOMAIN: key.domain });
    await expect(authenticate(requestWith(), env)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a wrong audience", async () => {
    const key = await makeKey();
    stubJwks(key);
    const token = await signToken(key, { audience: "other-aud" });
    const env = makeEnv({ TEAM_DOMAIN: key.domain, APPLICATION_AUD: "aud-tag" });
    await expect(authenticate(requestWith(token), env)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a wrong issuer", async () => {
    const key = await makeKey();
    stubJwks(key);
    const token = await signToken(key, { issuer: "https://evil.example.com" });
    const env = makeEnv({ TEAM_DOMAIN: key.domain });
    await expect(authenticate(requestWith(token), env)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an expired assertion", async () => {
    const key = await makeKey();
    stubJwks(key);
    const token = await signToken(key, { expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const env = makeEnv({ TEAM_DOMAIN: key.domain });
    await expect(authenticate(requestWith(token), env)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an assertion without exp", async () => {
    const key = await makeKey();
    stubJwks(key);
    const token = await signToken(key, { omitExp: true });
    const env = makeEnv({ TEAM_DOMAIN: key.domain });
    await expect(authenticate(requestWith(token), env)).rejects.toThrow(/expiry/);
  });

  it("injects a development principal only in development", async () => {
    const dev = makeEnv({
      ENVIRONMENT: "development",
      DEV_PRINCIPAL: JSON.stringify({ subject: "dev-user" }),
    });
    await expect(authenticate(requestWith(), dev)).resolves.toEqual({ subject: "dev-user" });

    const prod = makeEnv({
      ENVIRONMENT: "production",
      DEV_PRINCIPAL: JSON.stringify({ subject: "dev-user" }),
    });
    await expect(authenticate(requestWith(), prod)).rejects.toBeInstanceOf(AuthenticationError);
  });
});
