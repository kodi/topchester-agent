import dns from "node:dns/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  convertHtmlToMarkdown,
  executeToolCall,
  extractTextFromHtml,
  fetchWebContent,
  isToolErrorResult,
  parseToolCall,
} from "../src/agent/tools.js";

describe("web_fetch tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("converts HTML to markdown and text while skipping active content", () => {
    const html = [
      "<!doctype html>",
      "<h1>Title</h1>",
      "<p>Hello <strong>world</strong>.</p>",
      "<script>alert('no')</script>",
      "<style>body{color:red}</style>",
      "<ul><li>One</li><li>Two</li></ul>",
    ].join("");

    expect(convertHtmlToMarkdown(html)).toContain("# Title");
    expect(convertHtmlToMarkdown(html)).toContain("Hello **world**.");
    expect(convertHtmlToMarkdown(html)).toContain("-   One");
    expect(convertHtmlToMarkdown(html)).not.toContain("alert");
    expect(extractTextFromHtml(html)).toContain("Title");
    expect(extractTextFromHtml(html)).toContain("Hello world");
    expect(extractTextFromHtml(html)).not.toContain("alert");
  });

  it("fetches HTML and returns bounded markdown", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/xhtml+xml; charset=utf-8" });
        response.end("<h1>Docs</h1><p>Read <code>web_fetch</code>.</p>");
      },
      async (baseUrl) => {
        const result = await fetchWebContent({ url: baseUrl, format: "markdown" }, { allowPrivateNetwork: true });

        expect(result).toMatchObject({
          tool: "web_fetch",
          status: 200,
          contentType: "application/xhtml+xml; charset=utf-8",
          truncated: false,
        });
        expect(result.content).toContain("# Docs");
        expect(result.content).toContain("`web_fetch`");
      }
    );
  });

  it("truncates converted output with an explicit marker", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("a".repeat(40_050));
      },
      async (baseUrl) => {
        const result = await fetchWebContent({ url: baseUrl, format: "text" }, { allowPrivateNetwork: true });

        expect(result.truncated).toBe(true);
        expect(result.content).toHaveLength(40_013);
        expect(result.content.endsWith("\n\n[truncated]")).toBe(true);
      }
    );
  });

  it("returns non-2xx statuses as ordinary tool results", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      },
      async (baseUrl) => {
        const result = await fetchWebContent({ url: baseUrl, format: "text" }, { allowPrivateNetwork: true });

        expect(result.status).toBe(404);
        expect(result.content).toBe("not found");
      }
    );
  });

  it("rejects oversized responses before reading the body when content-length is too large", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain", "content-length": `${5 * 1024 * 1024 + 1}` });
        response.end("too big");
      },
      async (baseUrl) => {
        await expect(fetchWebContent({ url: baseUrl, format: "text" }, { allowPrivateNetwork: true })).rejects.toThrow(
          "too large"
        );
      }
    );
  });

  it("times out slow responses", async () => {
    await withServer(
      (_request, response) => {
        setTimeout(() => response.end("late"), 1200);
      },
      async (baseUrl) => {
        await expect(
          fetchWebContent({ url: baseUrl, format: "text", timeout_seconds: 1 }, { allowPrivateNetwork: true })
        ).rejects.toThrow("timed out after 1 seconds");
      }
    );
  });

  it("follows same-host redirects and surfaces cross-host redirects", async () => {
    await withServer(
      (request, response) => {
        if (request.url === "/start") {
          response.writeHead(302, { location: "/final" });
          response.end();
          return;
        }

        if (request.url === "/cross") {
          response.writeHead(302, { location: "https://example.com/next" });
          response.end();
          return;
        }

        response.writeHead(200, { "content-type": "text/plain" });
        response.end("done");
      },
      async (baseUrl) => {
        const sameHost = await fetchWebContent(
          { url: `${baseUrl}/start`, format: "text" },
          { allowPrivateNetwork: true }
        );
        const crossHost = await fetchWebContent(
          { url: `${baseUrl}/cross`, format: "text" },
          {
            allowPrivateNetwork: true,
            lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          }
        );

        expect(sameHost.status).toBe(200);
        expect(sameHost.finalUrl).toBe(`${baseUrl}/final`);
        expect(sameHost.content).toBe("done");
        expect(crossHost.status).toBe(302);
        expect(crossHost.redirectedTo).toBe("https://example.com/next");
        expect(crossHost.content).toContain("cross-host redirect");
      }
    );
  });

  it("retries Cloudflare challenge responses once with the fallback user agent", async () => {
    const userAgents: string[] = [];

    await withServer(
      (request, response) => {
        userAgents.push(request.headers["user-agent"] ?? "");

        if (userAgents.length === 1) {
          response.writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/plain" });
          response.end("challenge");
          return;
        }

        response.writeHead(200, { "content-type": "text/plain" });
        response.end("retried");
      },
      async (baseUrl) => {
        const result = await fetchWebContent({ url: baseUrl, format: "text" }, { allowPrivateNetwork: true });

        expect(result.status).toBe(200);
        expect(result.content).toBe("retried");
        expect(userAgents).toHaveLength(2);
        expect(userAgents[1]).toBe("topchester");
      }
    );
  });

  it("returns a short descriptive result for non-text content", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      },
      async (baseUrl) => {
        const result = await fetchWebContent({ url: baseUrl, format: "text" }, { allowPrivateNetwork: true });

        expect(result.content).toBe("web_fetch skipped non-text content (image/png).");
        expect(result.bytes).toBe(0);
      }
    );
  });

  it("executes through the registry with production policy and mocked network", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }] as any);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<h1>Example</h1>", { status: 200, headers: { "content-type": "text/html" } }))
    );
    const call = parseToolCall('{"tool":"web_fetch","args":{"url":"https://example.com","format":"text"}}');

    if (!call) {
      throw new Error("Expected web_fetch tool call to parse.");
    }

    const result = await executeToolCall(process.cwd(), call);

    expect(isToolErrorResult(result)).toBe(false);
    expect(result).toMatchObject({
      tool: "web_fetch",
      status: 200,
      content: "Example",
    });
  });
});

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address() as AddressInfo;

    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
