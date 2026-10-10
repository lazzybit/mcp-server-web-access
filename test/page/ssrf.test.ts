import { describe, expect, it } from "vitest";
import { parseIpv4, parseIpv6, parsePageUrl, isAllowedUrlString } from "../../src/page/ssrf";
import { PageFailure } from "../../src/page/types";

function code(input: string): string {
  try {
    parsePageUrl(input);
    return "ALLOWED";
  } catch (error) {
    if (error instanceof PageFailure) return error.pageError.code;
    throw error;
  }
}

describe("parsePageUrl", () => {
  it("allows ordinary http and https URLs", () => {
    expect(code("https://example.com/path?q=1")).toBe("ALLOWED");
    expect(code("http://example.com/")).toBe("ALLOWED");
    expect(code("https://example.com:8443/")).toBe("BLOCKED_URL");
    expect(code("https://example.com:443/")).toBe("ALLOWED");
    expect(code("http://example.com:80/")).toBe("ALLOWED");
  });

  it("rejects non-http schemes and credentials", () => {
    expect(code("ftp://example.com/")).toBe("BLOCKED_URL");
    expect(code("data:text/plain,hi")).toBe("BLOCKED_URL");
    expect(code("file:///etc/passwd")).toBe("BLOCKED_URL");
    expect(code("blob:https://example.com/abc")).toBe("BLOCKED_URL");
    expect(code("https://user:pass@example.com/")).toBe("BLOCKED_URL");
    expect(code("not a url")).toBe("BLOCKED_URL");
    expect(code("   ")).toBe("BLOCKED_URL");
  });

  it("rejects blocked hostnames", () => {
    for (const host of [
      "localhost",
      "localhost.",
      "api.localhost",
      "printer.local",
      "metadata.internal",
      "device.home.arpa",
    ]) {
      expect(code(`http://${host}/`)).toBe("BLOCKED_URL");
    }
    expect(code("https://example.com./")).toBe("ALLOWED");
  });

  it("rejects private, loopback and reserved IPv4 ranges", () => {
    for (const host of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
    ]) {
      expect(code(`http://${host}/`)).toBe("BLOCKED_URL");
    }
    for (const host of ["172.32.0.1", "100.128.0.1", "198.20.0.1", "192.0.2.1", "8.8.8.8"]) {
      expect(code(`http://${host}/`)).toBe("ALLOWED");
    }
  });

  it("rejects non-canonical IPv4 literals", () => {
    expect(code("http://2130706433/")).toBe("BLOCKED_URL");
    expect(code("http://0x7f000001/")).toBe("BLOCKED_URL");
    expect(code("http://0177.0.0.1/")).toBe("BLOCKED_URL");
    expect(code("http://0x7f.1/")).toBe("BLOCKED_URL");
  });

  it("rejects loopback, ULA, link-local and mapped IPv6", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
      expect(code(`http://${host}/`)).toBe("BLOCKED_URL");
    }
    expect(code("http://[2606:4700:4700::1111]/")).toBe("ALLOWED");
    expect(code("http://[2001:4860:4860::8888]/")).toBe("ALLOWED");
  });

  it("enforces the length cap", () => {
    const long = `https://example.com/${"a".repeat(3000)}`;
    expect(code(long)).toBe("BLOCKED_URL");
  });
});

describe("parseIpv4", () => {
  it("parses canonical and shorthand forms", () => {
    expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0x7f.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("1.2.65535")).toEqual([1, 2, 255, 255]);
  });

  it("rejects invalid forms", () => {
    expect(parseIpv4("999.1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("300.1")).toBeNull();
    expect(parseIpv4("example.com")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("parses expanded and compressed forms", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("2001:db8::1")).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
    ]);
  });

  it("rejects non-IPv6 input", () => {
    expect(parseIpv6("127.0.0.1")).toBeNull();
    expect(parseIpv6("2001:db8::1::2")).toBeNull();
    expect(parseIpv6("2001:db8:1")).toBeNull();
  });
});

describe("isAllowedUrlString", () => {
  it("matches the policy without throwing", () => {
    expect(isAllowedUrlString("https://example.com/")).toBe(true);
    expect(isAllowedUrlString("http://127.0.0.1/")).toBe(false);
    expect(isAllowedUrlString("javascript:alert(1)")).toBe(false);
  });
});
