import dns from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { type ToolCall } from "./types.js";

export const webFetchArgsSchema = z.object({
  url: z.string(),
  format: z.enum(["markdown", "text", "html"]).default("markdown"),
  timeout_seconds: z.number().int().positive().max(120).optional(),
});

export type WebFetchFormat = z.infer<typeof webFetchArgsSchema>["format"];
export type WebFetchToolArgs = z.infer<typeof webFetchArgsSchema>;
export type WebFetchToolCall = ToolCall<"web_fetch", WebFetchToolArgs>;

export type WebFetchUrlRejectionCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "blocked_host"
  | "dns_lookup_failed"
  | "dns_lookup_empty";

export interface WebFetchUrlAccepted {
  ok: true;
  url: URL;
  credentialsStripped: boolean;
}

export interface WebFetchUrlRejected {
  ok: false;
  code: WebFetchUrlRejectionCode;
  reason: string;
}

export type WebFetchUrlValidation = WebFetchUrlAccepted | WebFetchUrlRejected;

export interface WebFetchUrlPolicyOptions {
  allowPrivateNetwork?: boolean;
  lookup?: (hostname: string) => Promise<readonly WebFetchDnsAddress[]>;
}

export interface WebFetchDnsAddress {
  address: string;
  family?: number;
}

export async function validateWebFetchUrl(
  rawUrl: string,
  options: WebFetchUrlPolicyOptions = {}
): Promise<WebFetchUrlValidation> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return reject("invalid_url", `Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject("unsupported_scheme", `web_fetch only supports http and https URLs: ${url.protocol}`);
  }

  const credentialsStripped = url.username !== "" || url.password !== "";
  url.username = "";
  url.password = "";

  if (!options.allowPrivateNetwork) {
    const hostResult = await validateHost(url.hostname, options);

    if (!hostResult.ok) {
      return hostResult;
    }
  }

  return { ok: true, url, credentialsStripped };
}

export async function assertWebFetchUrlAllowed(
  rawUrl: string,
  options: WebFetchUrlPolicyOptions = {}
): Promise<WebFetchUrlAccepted> {
  const validation = await validateWebFetchUrl(rawUrl, options);

  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  return validation;
}

async function validateHost(hostname: string, options: WebFetchUrlPolicyOptions): Promise<WebFetchUrlValidation> {
  const normalizedHost = stripIpv6Brackets(hostname).toLowerCase();
  const literalKind = isIP(normalizedHost);

  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
    return reject("blocked_host", `Blocked private or local host: ${hostname}`);
  }

  if (literalKind !== 0) {
    return isBlockedAddress(normalizedHost)
      ? reject("blocked_host", `Blocked private or local address: ${hostname}`)
      : acceptedHost();
  }

  let addresses: readonly WebFetchDnsAddress[];

  try {
    addresses = await (options.lookup ?? lookupAllAddresses)(normalizedHost);
  } catch {
    return reject("dns_lookup_failed", `DNS lookup failed for ${hostname}`);
  }

  if (addresses.length === 0) {
    return reject("dns_lookup_empty", `DNS lookup returned no addresses for ${hostname}`);
  }

  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));

  if (blocked) {
    return reject(
      "blocked_host",
      `DNS for ${hostname} resolved to blocked private or local address ${blocked.address}`
    );
  }

  return acceptedHost();
}

async function lookupAllAddresses(hostname: string): Promise<readonly WebFetchDnsAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function isBlockedAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);

  if (ipv4Mapped) {
    return isBlockedIpv4(ipv4Mapped[1]);
  }

  const kind = isIP(normalized);

  if (kind === 4) {
    return isBlockedIpv4(normalized);
  }

  if (kind === 6) {
    return isBlockedIpv6(normalized);
  }

  return true;
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));

  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);

  if (!groups) {
    return true;
  }

  const first = groups[0];

  return (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80
  );
}

function expandIpv6(address: string): number[] | undefined {
  const zoneIndex = address.indexOf("%");
  const withoutZone = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const ipv4Tail = withoutZone.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u);
  let normalized = withoutZone;
  let ipv4Groups: number[] = [];

  if (ipv4Tail) {
    const octets = ipv4Tail[2].split(".").map((part) => Number.parseInt(part, 10));

    if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) {
      return undefined;
    }

    ipv4Groups = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    normalized = `${ipv4Tail[1]}${ipv4Groups.map((group) => group.toString(16)).join(":")}`;
  }

  const parts = normalized.split("::");

  if (parts.length > 2) {
    return undefined;
  }

  const left = parseIpv6Groups(parts[0]);
  const right = parts.length === 2 ? parseIpv6Groups(parts[1]) : [];

  if (!left || !right) {
    return undefined;
  }

  const missing = 8 - left.length - right.length;

  if (missing < 0 || (parts.length === 1 && missing !== 0)) {
    return undefined;
  }

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Groups(value: string): number[] | undefined {
  if (value === "") {
    return [];
  }

  const groups = value.split(":").map((part) => Number.parseInt(part, 16));

  if (
    groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff) ||
    value.split(":").some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))
  ) {
    return undefined;
  }

  return groups;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function reject(code: WebFetchUrlRejectionCode, reason: string): WebFetchUrlRejected {
  return { ok: false, code, reason };
}

function acceptedHost(): WebFetchUrlAccepted {
  return { ok: true, url: new URL("http://example.com"), credentialsStripped: false };
}
