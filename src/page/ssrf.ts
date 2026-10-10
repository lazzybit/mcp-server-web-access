/**
 * URL policy for `fetch_page`.
 *
 * Only `http:`/`https:` URLs without credentials, on ports 80/443, whose host
 * is neither a blocked domain suffix nor a private / loopback / link-local IP
 * literal, are allowed. Every redirect hop is validated through the same code.
 *
 * Residual risk: the platform resolves DNS internally, so hostname checks
 * cannot defend against DNS rebinding. Browser subrequests are outside this
 * boundary too (documented, not claimed otherwise).
 */
import { MAX_URL_LENGTH } from "./constants";
import { pageFailure } from "./types";

/** Normalises and validates an initial (user supplied) URL. */
export function parsePageUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw pageFailure("BLOCKED_URL", "url must not be empty");
  if (trimmed.length > MAX_URL_LENGTH) {
    throw pageFailure("BLOCKED_URL", `url must be at most ${MAX_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw pageFailure("BLOCKED_URL", "url could not be parsed");
  }
  assertAllowedUrl(url);
  return url;
}

/** Throws {@link PageFailure} `BLOCKED_URL` when `url` violates the policy. */
export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw pageFailure("BLOCKED_URL", "only http and https are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw pageFailure("BLOCKED_URL", "url must not contain credentials");
  }
  const port = url.port;
  if (port !== "" && port !== "80" && port !== "443") {
    throw pageFailure("BLOCKED_URL", `port ${port} is not allowed`);
  }
  if (url.hostname === "") {
    throw pageFailure("BLOCKED_URL", "url must contain a host");
  }
  if (!isAllowedHostname(url.hostname)) {
    throw pageFailure("BLOCKED_URL", "host is not allowed");
  }
}

/** Non-throwing variant used for per-hop browser navigation checks. */
export function isAllowedUrlString(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  try {
    assertAllowedUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function isAllowedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return false;

  if (host.startsWith("[") && host.endsWith("]")) {
    return isAllowedIpv6(host.slice(1, -1));
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return isAllowedIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (ipv6 !== null) return isAllowedIpv6Bytes(ipv6);

  return isAllowedDomain(host);
}

function isAllowedDomain(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "local" || host.endsWith(".local")) return false;
  if (host === "internal" || host.endsWith(".internal")) return false;
  if (host === "home.arpa" || host.endsWith(".home.arpa")) return false;
  return true;
}

function isAllowedIpv4(bytes: number[]): boolean {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  const c = bytes[2] ?? 0;
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10/8
  if (a === 100 && (b & 0xc0) === 64) return false; // 100.64/10
  if (a === 127) return false; // 127/8
  if (a === 169 && b === 254) return false; // 169.254/16
  if (a === 172 && (b & 0xf0) === 16) return false; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0/24
  if (a === 192 && b === 168) return false; // 192.168/16
  if (a === 198 && (b & 0xfe) === 18) return false; // 198.18/15
  if ((a & 0xf0) === 224) return false; // 224/4 multicast
  if ((a & 0xf0) === 240) return false; // 240/4 reserved
  return true;
}

function isAllowedIpv6(text: string): boolean {
  const bytes = parseIpv6(text);
  if (bytes === null) return false;
  return isAllowedIpv6Bytes(bytes);
}

function isAllowedIpv6Bytes(bytes: number[]): boolean {
  // :: and ::1
  const allZero = bytes.every((value) => value === 0);
  if (allZero) return false;
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) return false;
  // fc00::/7 unique local
  if ((bytes[0]! & 0xfe) === 0xfc) return false;
  // fe80::/10 link local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false;
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96
  const prefixZero = bytes.slice(0, 10).every((value) => value === 0);
  if (prefixZero) {
    const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
    const compatible = bytes[10] === 0 && bytes[11] === 0;
    if (mapped || compatible) {
      return isAllowedIpv4(bytes.slice(12));
    }
  }
  return true;
}

/**
 * WHATWG-compatible IPv4 parser.
 *
 * Accepts dotted decimal, octal (`0177`), hex (`0x7f`) and the short numeric
 * forms (single integer, 2/3 parts) so non-canonical literals cannot slip
 * through as "domain names".
 */
export function parseIpv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let radix = 10;
    let digits = part;
    if (/^0[xX]/.test(part)) {
      radix = 16;
      digits = part.slice(2);
    } else if (part.length > 1 && part.startsWith("0")) {
      radix = 8;
      digits = part.slice(1);
    }
    if (digits === "") {
      numbers.push(0);
      continue;
    }
    const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
    if (!pattern.test(digits)) return null;
    numbers.push(Number.parseInt(digits, radix));
  }

  for (let i = 0; i < numbers.length - 1; i += 1) {
    if ((numbers[i] ?? 0) > 255) return null;
  }
  const last = numbers[numbers.length - 1] ?? 0;
  if (last >= 256 ** (5 - numbers.length)) return null;

  let value = last;
  for (let i = 0; i < numbers.length - 1; i += 1) {
    value += (numbers[i] ?? 0) * 256 ** (3 - i);
  }
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** IPv6 parser returning 16 bytes, or `null` when `input` is not IPv6. */
export function parseIpv6(input: string): number[] | null {
  let text = input;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = parseIpv4(text.slice(lastColon + 1));
    if (embedded === null) return null;
    const high = ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0);
    const low = ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColon = text.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    if (text.indexOf("::", doubleColon + 2) >= 0) return null;
    head = text.slice(0, doubleColon).split(":").filter((part) => part !== "");
    tail = text
      .slice(doubleColon + 2)
      .split(":")
      .filter((part) => part !== "");
  } else {
    head = text.split(":");
    tail = [];
    if (head.length !== 8) return null;
  }

  const groups = [...head, ...tail];
  if (groups.length > 8) return null;
  if (doubleColon < 0 && groups.length !== 8) return null;
  const fill = 8 - groups.length;

  const bytes: number[] = [];
  const push = (group: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 255, value & 255);
    return true;
  };
  for (const group of head) if (!push(group)) return null;
  for (let i = 0; i < fill; i += 1) bytes.push(0, 0);
  for (const group of tail) if (!push(group)) return null;

  return bytes.length === 16 ? bytes : null;
}
