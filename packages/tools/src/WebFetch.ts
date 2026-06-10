// WebFetch — fetch a URL, convert HTML to text, optionally summarize.
//
// When a `prompt` is provided, the result is summarized through the
// SUMMARIZE slot (cheap Ollama Cloud model) — your main REASONER slot
// never sees the raw page. This makes documentation lookups close to
// free in terms of context window usage.

import { z } from "zod";
import { buildTool } from "./_shared.js";

export interface Summarizer {
  summarize(req: { input: string; instructions?: string; signal?: AbortSignal }): Promise<string>;
}

export interface WebFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  /** Plain-text rendering of the page. */
  text: string;
  /** Truncated to a sensible size for context use. */
  truncated: boolean;
  /** Present when a prompt was passed and summarization succeeded. */
  summary?: string;
}

const inputSchema = z
  .object({
    url: z.string().url().describe("The URL to fetch. HTTP gets upgraded to HTTPS."),
    prompt: z
      .string()
      .optional()
      .describe(
        "Optional: what you want extracted from the page. When set, the page is summarized via the cheap SUMMARIZE slot before being returned.",
      ),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(20_000)
      .describe("Cap on returned text. Default 20k chars."),
  })
  .strict();

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export function makeWebFetchTool(summarizer?: Summarizer) {
  return buildTool({
    name: "WebFetch",
    description:
      "Fetch a URL and return its text content. Pass a `prompt` to have the page summarized via the cheap SUMMARIZE slot first (recommended — keeps your context lean). Use for: looking up current docs, reading specific pages the user pointed at, fact-checking framework APIs. HTTPS is enforced; HTTP is upgraded.",
    safety: "external-state",
    concurrency: "parallel-safe",
    inputZod: inputSchema,
    activityDescription: (i) => `Fetching ${shortUrl(i.url)}`,

    async call(i, ctx): Promise<{ output: WebFetchOutput; display: string }> {
      const upgraded = upgradeToHttps(i.url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      // Honor parent signal too.
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener("abort", onAbort);

      try {
        const res = await fetch(upgraded, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "Ares/0.3 (+https://ares.dev)" },
        });
        clearTimeout(timeout);
        ctx.signal.removeEventListener("abort", onAbort);

        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const isHtml = /text\/html|application\/xhtml/i.test(contentType) ||
          (!contentType && /^\s*<!DOCTYPE html|<html/i.test(raw));
        const rendered = isHtml ? htmlToText(raw) : raw;
        const truncated = rendered.length > i.max_chars;
        const text = truncated ? rendered.slice(0, i.max_chars) + "\n\n…[truncated]…" : rendered;

        let summary: string | undefined;
        if (i.prompt && summarizer) {
          try {
            summary = await summarizer.summarize({
              input: text,
              instructions: `You are summarizing a web page for a coding agent. The agent asked: "${i.prompt}". Return ONLY the information that answers that question. Preserve URLs, code snippets, and exact identifiers. Be concise.`,
              signal: ctx.signal,
            });
          } catch (err) {
            summary = `(summarization failed: ${err instanceof Error ? err.message : String(err)})`;
          }
        }

        return {
          output: {
            url: upgraded,
            finalUrl: res.url,
            status: res.status,
            contentType,
            text,
            truncated,
            summary,
          },
          display: summary
            ? `Fetched ${shortUrl(res.url)} (${res.status}, summarized)`
            : `Fetched ${shortUrl(res.url)} (${res.status}, ${text.length} chars${truncated ? ", truncated" : ""})`,
        };
      } catch (err) {
        clearTimeout(timeout);
        ctx.signal.removeEventListener("abort", onAbort);
        throw new Error(`WebFetch failed for ${upgraded}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

function upgradeToHttps(url: string): string {
  return url.startsWith("http://") ? "https://" + url.slice(7) : url;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Minimal HTML → text. Not a full reader. Strips scripts/styles, drops
 * tags, collapses whitespace, preserves heading-ish structure and code
 * blocks via line breaks. Good enough for docs and changelogs.
 */
export function htmlToText(html: string): string {
  // Drop script/style/noscript blocks entirely.
  let s = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  // Drop HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Break around block-level elements.
  s = s.replace(/<\/(h[1-6]|p|div|li|tr|article|section|header|footer|pre|blockquote)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>(?=\s*)/gi, "\n");
  // Replace links with [text](href) so the URL survives.
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) =>
    `[${stripTags(inner).trim()}](${href})`,
  );
  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
  // Collapse whitespace, preserve paragraph breaks.
  s = s.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
