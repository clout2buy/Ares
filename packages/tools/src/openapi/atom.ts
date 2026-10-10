// A small Atom shim. arXiv (and a few other free services) answer in Atom XML,
// which costs the model more tokens and attention than the facts inside it.
// This pulls the feed header and each entry into plain JSON. It is not an XML
// parser and does not try to be one: Atom's shape is flat enough for this.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1]!.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function clean(text: string | undefined, max = 4000): string {
  if (!text) return "";
  const stripped = decodeEntities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m?.[1];
}

function attrs(tagText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagText.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

export interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  published?: string;
  updated?: string;
  authors: string[];
  link?: string;
  pdf?: string;
  categories: string[];
  primaryCategory?: string;
  comment?: string;
  doi?: string;
}

export interface AtomFeed {
  feed: { title: string; totalResults?: number; startIndex?: number; itemsPerPage?: number };
  entries: AtomEntry[];
}

export function atomToJson(xml: string): AtomFeed {
  if (!/<feed[\s>]/i.test(xml)) throw new Error("not an Atom feed");
  const head = xml.slice(0, xml.search(/<entry[\s>]/i) >= 0 ? xml.search(/<entry[\s>]/i) : undefined);
  const num = (name: string): number | undefined => {
    const v = tag(head, name);
    const n = v === undefined ? NaN : Number(clean(v));
    return Number.isFinite(n) ? n : undefined;
  };
  const feed: AtomFeed["feed"] = { title: clean(tag(head, "title"), 300) };
  const total = num("opensearch:totalResults");
  const start = num("opensearch:startIndex");
  const per = num("opensearch:itemsPerPage");
  if (total !== undefined) feed.totalResults = total;
  if (start !== undefined) feed.startIndex = start;
  if (per !== undefined) feed.itemsPerPage = per;
  const entries: AtomEntry[] = [];
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const links = [...block.matchAll(/<link\b[^>]*\/?>/gi)].map((l) => attrs(l[0]));
    const alt = links.find((l) => l.rel === "alternate") ?? links.find((l) => !l.title);
    const pdf = links.find((l) => l.title === "pdf" || l.type === "application/pdf");
    const primary = block.match(/<arxiv:primary_category\b[^>]*>/i);
    const entry: AtomEntry = {
      id: clean(tag(block, "id"), 300),
      title: clean(tag(block, "title"), 400),
      summary: clean(tag(block, "summary"), 1200),
      authors: [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((a) => clean(a[1], 120)).slice(0, 25),
      categories: [...block.matchAll(/<category\b[^>]*>/gi)].map((c) => attrs(c[0]).term).filter((t): t is string => Boolean(t)).slice(0, 12),
    };
    const published = clean(tag(block, "published"), 40);
    const updated = clean(tag(block, "updated"), 40);
    if (published) entry.published = published;
    if (updated) entry.updated = updated;
    if (alt?.href) entry.link = alt.href;
    if (pdf?.href) entry.pdf = pdf.href;
    if (primary) entry.primaryCategory = attrs(primary[0]).term;
    const comment = clean(tag(block, "arxiv:comment"), 300);
    if (comment) entry.comment = comment;
    const doi = clean(tag(block, "arxiv:doi"), 100);
    if (doi) entry.doi = doi;
    entries.push(entry);
  }
  return { feed, entries };
}
