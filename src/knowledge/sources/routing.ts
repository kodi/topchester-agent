const EXPLICIT_PRODUCT_PATTERNS = [
  /\btopchester\b/iu,
  /\btopchester\.jsonc\b/iu,
  /\bTOPCHESTER_[A-Z0-9_]+\b/u,
  /(?:^|\s)\/kb(?:\s|$)/iu,
  /\btopchester\s+kb\b/iu,
];

const PRODUCT_PHRASES = [
  "knowledge sync",
  "knowledge base",
  "project instructions",
  "provider setup",
  "model provider",
  "kb sync",
  "kb context",
  "kb search",
];

export function shouldRouteToTopchesterProduct(query: string): boolean {
  if (EXPLICIT_PRODUCT_PATTERNS.some((pattern) => pattern.test(query))) return true;
  const normalized = query.toLowerCase();
  return PRODUCT_PHRASES.some((phrase) => normalized.includes(phrase));
}
