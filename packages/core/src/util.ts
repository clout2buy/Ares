import { randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix = "id"): string {
  return `${prefix}_${randomUUID()}`;
}

export function tail(value: string, max = 8_000): string {
  if (value.length <= max) return value;
  return `...${value.slice(value.length - max)}`;
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/g)
    .filter((token) => token.length >= 2);
}

export function scoreText(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let score = 0;
  for (const token of queryTokens) if (textTokens.has(token)) score += 1;
  return score / queryTokens.size;
}
