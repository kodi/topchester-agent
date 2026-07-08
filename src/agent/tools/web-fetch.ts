import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { defineTool, type ToolResult } from "./types.js";
import {
  assertWebFetchUrlAllowed,
  webFetchArgsSchema,
  type WebFetchFormat,
  type WebFetchToolArgs,
  type WebFetchToolCall,
  type WebFetchUrlPolicyOptions,
} from "./web-fetch-policy.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_REDIRECTS = 5;
const TRUNCATION_MARKER = "\n\n[truncated]";
const CHROME_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export { webFetchArgsSchema, type WebFetchFormat, type WebFetchToolArgs, type WebFetchToolCall };

export interface WebFetchToolResult extends ToolResult<"web_fetch"> {
  url: string;
  finalUrl?: string;
  status: number;
  contentType?: string;
  truncated: boolean;
  redirectedTo?: string;
  bytes: number;
}

export interface FetchWebContentOptions extends WebFetchUrlPolicyOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  description: "Fetch a public HTTP(S) URL and return bounded text, markdown, or HTML content.",
  prompt:
    'web_fetch: fetch a public HTTP(S) URL for current docs, changelogs, API references, issue pages, or package behavior; private network and localhost URLs are blocked. Prefer this over bash curl/wget. To use it, reply with only JSON: {"tool":"web_fetch","args":{"url":"https://example.com/docs","format":"markdown","timeout_seconds":30}}',
  argsSchema: webFetchArgsSchema,
  parallelSafe: true,
  mutatesWorkspace: false,
  resourceKeys: (args) => [`web_fetch:${args.url}`],
  execute: async (context, args) => fetchWebContent(args, { signal: context.abortSignal }),
});

export async function fetchWebContent(
  args: WebFetchToolArgs,
  options: FetchWebContentOptions = {}
): Promise<WebFetchToolResult> {
  const format = args.format ?? "markdown";
  const timeoutSeconds = Math.min(args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const request = await fetchWithPolicy(args.url, format, timeoutSeconds, options);

  if ("redirectedTo" in request) {
    return {
      tool: "web_fetch",
      url: args.url,
      status: request.status,
      redirectedTo: request.redirectedTo,
      truncated: false,
      bytes: 0,
      content: `web_fetch stopped at a cross-host redirect to ${request.redirectedTo}. Call web_fetch with that URL if it is expected.`,
    };
  }

  const contentType = request.response.headers.get("content-type") ?? undefined;

  if (contentType && !isReadableContentType(contentType)) {
    return {
      tool: "web_fetch",
      url: args.url,
      finalUrl: request.url,
      status: request.status,
      contentType,
      truncated: false,
      bytes: 0,
      content: `web_fetch skipped non-text content (${contentType}).`,
    };
  }

  const body = await readBoundedBody(request.response);
  const converted = convertFetchedContent(body.text, contentType, format);
  const truncated = truncateWebFetchContent(converted);

  return {
    tool: "web_fetch",
    url: args.url,
    finalUrl: request.url,
    status: request.status,
    contentType,
    truncated: truncated.truncated,
    bytes: body.bytes,
    content: truncated.content,
  };
}

export function convertFetchedContent(
  content: string,
  contentType: string | undefined,
  format: WebFetchFormat
): string {
  if (format === "html") {
    return content;
  }

  if (!isHtmlContentType(contentType)) {
    return content;
  }

  return format === "markdown" ? convertHtmlToMarkdown(content) : extractTextFromHtml(content);
}

export function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  turndown.remove(["script", "style", "meta", "link", "noscript", "iframe", "object", "embed"]);

  return turndown.turndown(html).trim();
}

export function extractTextFromHtml(html: string): string {
  const chunks: string[] = [];
  const ignoredTags = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);
  const blockTags = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "div",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul",
  ]);
  let ignoredDepth = 0;

  const pushBreak = () => {
    if (chunks.length > 0 && chunks[chunks.length - 1] !== "\n") {
      chunks.push("\n");
    }
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (ignoredTags.has(name)) {
          ignoredDepth += 1;
          return;
        }

        if (ignoredDepth === 0 && blockTags.has(name)) {
          pushBreak();
        }
      },
      ontext(text) {
        if (ignoredDepth > 0) {
          return;
        }

        const normalized = text.replace(/\s+/gu, " ").trim();

        if (normalized) {
          chunks.push(normalized, " ");
        }
      },
      onclosetag(name) {
        if (ignoredTags.has(name) && ignoredDepth > 0) {
          ignoredDepth -= 1;
          return;
        }

        if (ignoredDepth === 0 && blockTags.has(name)) {
          pushBreak();
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  return chunks
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function truncateWebFetchContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_OUTPUT_CHARS) {
    return { content, truncated: false };
  }

  return {
    content: `${content.slice(0, MAX_OUTPUT_CHARS)}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

async function fetchWithPolicy(
  rawUrl: string,
  format: WebFetchFormat,
  timeoutSeconds: number,
  options: FetchWebContentOptions
): Promise<
  | {
      response: Response;
      headers: Headers;
      status: number;
      url: string;
      redirectedTo?: undefined;
    }
  | {
      status: number;
      url: string;
      redirectedTo: string;
    }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = (await assertWebFetchUrlAllowed(rawUrl, options)).url;
  const firstHost = current.hostname.toLowerCase();

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchOnce(fetchImpl, current, format, timeoutSeconds, options.signal);

    if (response.status === 403 && response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
      const retried = await fetchOnce(fetchImpl, current, format, timeoutSeconds, options.signal, "topchester");

      return {
        response: retried,
        headers: retried.headers,
        status: retried.status,
        url: current.toString(),
      };
    }

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        headers: response.headers,
        status: response.status,
        url: current.toString(),
      };
    }

    const location = response.headers.get("location");

    if (!location) {
      return {
        response,
        headers: response.headers,
        status: response.status,
        url: current.toString(),
      };
    }

    const next = new URL(location, current);
    const validatedNext = await assertWebFetchUrlAllowed(next.toString(), options);

    if (validatedNext.url.hostname.toLowerCase() !== firstHost) {
      return {
        status: response.status,
        url: current.toString(),
        redirectedTo: validatedNext.url.toString(),
      };
    }

    current = validatedNext.url;
  }

  throw new Error(`Too many redirects while fetching ${rawUrl}.`);
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  url: URL,
  format: WebFetchFormat,
  timeoutSeconds: number,
  externalSignal: AbortSignal | undefined,
  userAgent = CHROME_LIKE_USER_AGENT
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const abort = () => controller.abort();

  try {
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", abort, { once: true });
    }

    return await fetchImpl(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "accept": acceptHeader(format),
        "user-agent": userAgent,
      },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`web_fetch timed out after ${timeoutSeconds} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(response: Response): Promise<{ text: string; bytes: number }> {
  const contentLength = response.headers.get("content-length");

  if (contentLength) {
    const length = Number.parseInt(contentLength, 10);

    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      throw new Error(`web_fetch response is too large (${length} bytes, limit ${MAX_BODY_BYTES}).`);
    }
  }

  const body = await response.arrayBuffer();

  if (body.byteLength > MAX_BODY_BYTES) {
    throw new Error(`web_fetch response is too large (${body.byteLength} bytes, limit ${MAX_BODY_BYTES}).`);
  }

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(body),
    bytes: body.byteLength,
  };
}

function acceptHeader(format: WebFetchFormat): string {
  if (format === "html") {
    return "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1";
  }

  return "text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.1";
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isHtmlContentType(contentType: string | undefined): boolean {
  return Boolean(contentType && /(?:^|[/+])x?html(?:[;+]|$)/iu.test(contentType));
}

function isReadableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();

  return (
    normalized.startsWith("text/") ||
    /(?:json|xml|javascript|typescript|x-www-form-urlencoded|markdown)/u.test(normalized)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
