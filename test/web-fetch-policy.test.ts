import { describe, expect, it } from "vite-plus/test";
import { validateWebFetchUrl, type WebFetchDnsAddress } from "../src/agent/tools.js";

describe("web_fetch URL policy", () => {
  it("accepts public http and https URLs after DNS validation", async () => {
    const result = await validateWebFetchUrl("https://example.com/docs", {
      lookup: fakeLookup([{ address: "93.184.216.34", family: 4 }]),
    });

    expect(result).toMatchObject({
      ok: true,
      credentialsStripped: false,
    });
    expect(result.ok && result.url.toString()).toBe("https://example.com/docs");
  });

  it("strips credentials from accepted URLs", async () => {
    const result = await validateWebFetchUrl("https://user:secret@example.com/path", {
      lookup: fakeLookup([{ address: "93.184.216.34", family: 4 }]),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.credentialsStripped).toBe(true);
    expect(result.ok && result.url.toString()).toBe("https://example.com/path");
  });

  it("rejects unsupported schemes", async () => {
    const result = await validateWebFetchUrl("file:///etc/passwd");

    expect(result).toMatchObject({
      ok: false,
      code: "unsupported_scheme",
    });
  });

  it("rejects localhost and private literal addresses", async () => {
    await expectRejected("http://localhost", "blocked_host");
    await expectRejected("http://127.0.0.1", "blocked_host");
    await expectRejected("http://10.0.0.1", "blocked_host");
    await expectRejected("http://172.16.0.1", "blocked_host");
    await expectRejected("http://192.168.1.2", "blocked_host");
    await expectRejected("http://169.254.10.20", "blocked_host");
    await expectRejected("http://[::1]", "blocked_host");
    await expectRejected("http://[fc00::1]", "blocked_host");
    await expectRejected("http://[fe80::1]", "blocked_host");
  });

  it("accepts public IPv6 literal addresses", async () => {
    const result = await validateWebFetchUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/");

    expect(result.ok).toBe(true);
    expect(result.ok && result.url.toString()).toBe("https://[2606:2800:220:1:248:1893:25c8:1946]/");
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    const result = await validateWebFetchUrl("https://internal.example", {
      lookup: fakeLookup([{ address: "192.168.1.10", family: 4 }]),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "blocked_host",
    });
  });

  it("fails closed when DNS resolution fails or returns no addresses", async () => {
    const failed = await validateWebFetchUrl("https://missing.example", {
      lookup: async () => {
        throw new Error("no dns");
      },
    });
    const empty = await validateWebFetchUrl("https://empty.example", {
      lookup: fakeLookup([]),
    });

    expect(failed).toMatchObject({ ok: false, code: "dns_lookup_failed" });
    expect(empty).toMatchObject({ ok: false, code: "dns_lookup_empty" });
  });

  it("allows private addresses only through the test escape hatch", async () => {
    const result = await validateWebFetchUrl("http://127.0.0.1:1234", { allowPrivateNetwork: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.url.toString()).toBe("http://127.0.0.1:1234/");
  });
});

async function expectRejected(url: string, code: string): Promise<void> {
  const result = await validateWebFetchUrl(url);

  expect(result).toMatchObject({ ok: false, code });
}

function fakeLookup(addresses: readonly WebFetchDnsAddress[]): () => Promise<readonly WebFetchDnsAddress[]> {
  return async () => addresses;
}
