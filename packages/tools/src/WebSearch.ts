// WebSearch — query a search engine, return result snippets + URLs.
//
// Default backend: DuckDuckGo Lite (HTML scrape, no API key required).
// Configurable so you can swap in Brave/Tavily/Bing later.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import { htmlToText } from "./WebFetch.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  engine: string;
}

export interface SearchBackend {
  name: string;
  search(query: string, signal: AbortSignal): Promise<WebSearchResult[]>;
}

const inputSchema = z
  .object({
    query: z.string().min(2).describe("Search query."),
    max_results: z.number().int().positive().max(20).default(10),
  })
  .strict();

export function makeWebSearchTool(backend: SearchBackend = duckDuckGoLite()) {
  return buildTool({
    name: "WebSearch",
    description: `Search the web for current information beyond your knowledge cutoff. Returns titles + URLs + snippets. Pair with WebFetch to read the full page for promising results. Use for: docs that may have changed, library versions, framework APIs, real-world examples. Default backend: ${backend.name}.`,
    safety: "external-state",
    concurrency: "parallel-safe",
    inputZod: inputSchema,
    activityDescription: (i) => `Searching the web for ${truncate(i.query, 60)}`,

    async call(i, ctx): Promise<{ output: WebSearchOutput; display: string }> {
      const all = await backend.search(i.query, ctx.signal);
      const results = all.slice(0, i.max_results);
      return {
        output: { query: i.query, results, engine: backend.name },
        display: `${results.length} result${results.length === 1 ? "" : "s"} from ${backend.name}`,
      };
    },
  });
}

// ─── Default backend: DuckDuckGo Lite ──────────────────────────────────

export function duckDuckGoLite(): SearchBackend {
  return {
    name: "DuckDuckGo",
    async search(query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Ares/0.3)",
          accept: "text/html",
        },
      });
      if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
      const html = await res.text();
      return parseDuckDuckGoLite(html);
    },
  };
}

/** Parse DDG Lite HTML into result objects. Robust enough for v0.3. */
export function parseDuckDuckGoLite(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Result blocks are <div class="result"> ... </div>. Inside each:
  //   <a class="result__a" href="...">title</a>
  //   <a class="result__snippet">snippet</a>
  const blockRe = /<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe = /<a[^>]*class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/;

  for (const match of html.matchAll(blockRe)) {
    const block = match[0];
    const titleMatch = block.match(titleRe);
    if (!titleMatch) continue;
    let url = decodeDuckDuckGoUrl(titleMatch[1]);
    const title = htmlToText(titleMatch[2]).trim();
    const snippetMatch = block.match(snippetRe);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]).trim() : "";
    if (!url || !title) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function decodeDuckDuckGoUrl(href: string): string {
  // DDG wraps results in /l/?uddg=<encoded url> sometimes.
  try {
    if (href.startsWith("//duckduckgo.com/l/?") || href.startsWith("/l/?")) {
      const qIdx = href.indexOf("uddg=");
      if (qIdx >= 0) {
        const remainder = href.slice(qIdx + 5);
        const ampIdx = remainder.indexOf("&");
        const encoded = ampIdx >= 0 ? remainder.slice(0, ampIdx) : remainder;
        return decodeURIComponent(encoded);
      }
    }
    if (href.startsWith("//")) return "https:" + href;
    return href;
  } catch {
    return href;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
