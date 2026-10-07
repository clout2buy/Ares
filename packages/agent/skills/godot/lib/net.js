// Network helpers: the loopback RPC client for the Godot bridge/runtime, a
// tolerant fetch, HTML → text, Godot docs lookup, YouTube transcript/search,
// Godot Asset Library + Poly Haven discovery. Everything that reaches the
// internet caches under <ares home>/godot/ and fails soft with a clear error.

import net from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AresGodotProvider/1.0";

// ---- loopback RPC ---------------------------------------------------------

let rpcId = 0;

/** One request → one response over a fresh loopback socket. */
export function rpcCall(port, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`rpc ${method} timed out after ${timeoutMs}ms (port ${port})`)), timeoutMs);
    socket.setNoDelay(true);
    socket.once("connect", () => {
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line);
        if (msg.ok === false) finish(new Error(msg.error ?? `rpc ${method} failed`));
        else finish(null, msg.result);
      } catch (error) {
        finish(new Error(`rpc ${method}: bad response: ${String(error)}`));
      }
    });
    socket.once("error", (error) => finish(new Error(`rpc ${method}: ${error.code ?? error.message} (is the bridge listening on ${port}?)`)));
    socket.once("close", () => finish(new Error(`rpc ${method}: connection closed before a response`)));
  });
}

export async function rpcPing(port, timeoutMs = 700) {
  try {
    return await rpcCall(port, "ping", {}, timeoutMs);
  } catch {
    return null;
  }
}

export async function waitForPort(port, { timeoutMs = 30_000, intervalMs = 250, isAlive } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (isAlive && !isAlive()) return null;
    const pong = await rpcPing(port, 600);
    if (pong) return pong;
    await sleep(intervalMs);
  }
  return null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- fetch ---------------------------------------------------------------

export async function fetchText(url, { timeoutMs = 20_000, headers = {}, maxBytes = 6_000_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...headers }, signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`response too large (${buf.length} bytes) for ${url}`);
    return buf.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, headers: { accept: "application/json", ...(opts.headers ?? {}) } });
  return JSON.parse(text);
}

export async function fetchBinary(url, { timeoutMs = 120_000, maxBytes = 400_000_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`download too large (${buf.length} bytes)`);
    return { buffer: buf, contentType: res.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

// ---- HTML → text -----------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©" };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function htmlToText(html, { mainOnly = true } = {}) {
  let src = html;
  if (mainOnly) {
    const main = src.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i) ?? src.match(/<div[^>]+role="main"[^>]*>([\s\S]*)<\/div>\s*<footer/i);
    if (main) src = main[1];
  }
  src = src.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  src = src.replace(/<(h[1-6])[^>]*>/gi, (_, tag) => `\n\n${"#".repeat(Number(tag[1]))} `);
  src = src.replace(/<\/(h[1-6])>/gi, "\n");
  src = src.replace(/<(?:p|div|section|article|li|tr|br|hr|pre|blockquote|dt|dd)[^>]*>/gi, "\n");
  src = src.replace(/<\/(?:p|div|section|article|li|tr|pre|blockquote|table|ul|ol|dl)>/gi, "\n");
  src = src.replace(/<(?:td|th)[^>]*>/gi, " | ");
  src = src.replace(/<code[^>]*>/gi, "`").replace(/<\/code>/gi, "`");
  src = src.replace(/<[^>]+>/g, "");
  src = decodeEntities(src);
  src = src.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return src.trim();
}

// ---- cache ---------------------------------------------------------------

export function cacheDir(home, bucket) {
  return path.join(home || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".ares"), "godot", bucket);
}

export async function cached(home, bucket, key, ttlMs, produce) {
  const dir = cacheDir(home, bucket);
  const file = path.join(dir, `${key.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120)}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const entry = JSON.parse(raw);
    if (Date.now() - entry.at < ttlMs) return { ...entry.value, cached: true, cachedAt: new Date(entry.at).toISOString() };
  } catch {
    // miss
  }
  const value = await produce();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ at: Date.now(), value }), "utf8");
  return { ...value, cached: false };
}

// ---- Godot docs ------------------------------------------------------------

const DOCS_BASE = "https://docs.godotengine.org/en/stable";

export function docsUrlForClass(cls) {
  return `${DOCS_BASE}/classes/class_${String(cls).toLowerCase()}.html`;
}

export async function fetchClassDoc(home, cls, { refresh = false } = {}) {
  const key = `class_${String(cls).toLowerCase()}`;
  const produce = async () => {
    const html = await fetchText(docsUrlForClass(cls));
    const text = htmlToText(html);
    return { class: cls, url: docsUrlForClass(cls), text };
  };
  if (refresh) {
    const value = await produce();
    await fs.mkdir(cacheDir(home, "docs"), { recursive: true });
    await fs.writeFile(path.join(cacheDir(home, "docs"), `${key}.json`), JSON.stringify({ at: Date.now(), value }), "utf8");
    return { ...value, cached: false };
  }
  return cached(home, "docs", key, 7 * 24 * 3600_000, produce);
}

export async function fetchDocPage(home, slug, { refresh = false } = {}) {
  const clean = String(slug).replace(/^\/+|\.html$/g, "");
  const url = `${DOCS_BASE}/${clean}.html`;
  const produce = async () => ({ slug: clean, url, text: htmlToText(await fetchText(url)) });
  return refresh ? { ...(await produce()), cached: false } : cached(home, "docs", `page_${clean}`, 7 * 24 * 3600_000, produce);
}

/** Return the window of `text` around a heading/term, so the model can ask for
 * "move_and_slide" inside CharacterBody3D without reading 40 KB. */
export function sectionOf(text, term, { before = 300, after = 2_500 } = {}) {
  if (!term) return text;
  const lower = text.toLowerCase();
  const needle = String(term).toLowerCase();
  // The class reference lists every member twice: a summary table near the
  // top and the full description further down. Prefer the LAST line-start
  // occurrence (the description), then a heading, then any mention.
  const lineStartRe = new RegExp(`^[^\\n]{0,60}\\b${escapeRegex(needle)}\\b`, "gim");
  let idx = -1;
  for (const m of text.matchAll(lineStartRe)) {
    const tail = text.slice(m.index, m.index + 400);
    if (!/\|\s*$/m.test(tail.split("\n")[0])) idx = m.index;
  }
  if (idx < 0) {
    const h = text.match(new RegExp(`^#+ .*${escapeRegex(needle)}`, "im"));
    if (h) idx = h.index;
  }
  if (idx < 0) idx = lower.lastIndexOf(needle);
  if (idx < 0) return null;
  return text.slice(Math.max(0, idx - before), Math.min(text.length, idx + after));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function searchDocsCache(home, query, { limit = 12 } = {}) {
  const dir = cacheDir(home, "docs");
  const entries = await fs.readdir(dir).catch(() => []);
  const needle = String(query).toLowerCase();
  const hits = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      const text = entry.value?.text ?? "";
      const lower = text.toLowerCase();
      let idx = lower.indexOf(needle);
      let count = 0;
      while (idx >= 0 && count < 3) {
        hits.push({ source: entry.value.class ?? entry.value.slug, url: entry.value.url, snippet: text.slice(Math.max(0, idx - 120), idx + 240).replace(/\s+/g, " ") });
        idx = lower.indexOf(needle, idx + needle.length);
        count++;
      }
    } catch {
      // skip
    }
  }
  return hits.slice(0, limit);
}

// ---- YouTube ---------------------------------------------------------------

export function youtubeId(input) {
  const s = String(input ?? "").trim();
  const m = s.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/) ?? s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

function unescapeJsonString(s) {
  return s.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/\\"/g, '"');
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function parseTimedText(xml) {
  const out = [];
  // <text start="1.23" dur="4.5">Hello &amp; world</text>  (also <p t="1230" d="4500"> in srv3)
  for (const m of xml.matchAll(/<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)) {
    out.push({ start: Number(m[1]), dur: Number(m[2] ?? 0), text: decodeEntities(decodeEntities(m[3])).replace(/\s+/g, " ").trim() });
  }
  if (out.length === 0) {
    for (const m of xml.matchAll(/<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g)) {
      out.push({ start: Number(m[1]) / 1000, dur: Number(m[2] ?? 0) / 1000, text: decodeEntities(m[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() });
    }
  }
  return out.filter((l) => l.text);
}

/** Group caption cues into ~chunkSeconds paragraphs with a leading timestamp. */
export function transcriptToText(cues, { chunkSeconds = 30 } = {}) {
  const lines = [];
  let current = null;
  for (const cue of cues) {
    if (!current || cue.start - current.start >= chunkSeconds) {
      if (current) lines.push(`[${fmtTime(current.start)}] ${current.text}`);
      current = { start: cue.start, text: cue.text };
    } else current.text += " " + cue.text;
  }
  if (current) lines.push(`[${fmtTime(current.start)}] ${current.text}`);
  return lines.join("\n");
}

/** InnerTube player call — the watch page no longer embeds caption tracks for
 * non-browser fetches, but the player endpoint used by the Android app still
 * returns them (same approach as youtube-transcript-api). */
async function innertubePlayer(id) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", "accept-language": "en-US,en;q=0.9" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!res.ok) throw new Error(`InnerTube player HTTP ${res.status}`);
  return res.json();
}

function chaptersFromDescription(description, lengthSeconds) {
  const out = [];
  for (const line of String(description ?? "").split("\n")) {
    const m = line.match(/^\s*(?:\(?(\d{1,2}):)?(\d{1,2}):(\d{2})\)?\s*[-–—:]?\s*(.+)$/);
    if (!m) continue;
    const start = (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
    if (lengthSeconds && start > lengthSeconds) continue;
    out.push({ title: m[4].trim(), start });
  }
  return out.length >= 2 ? out : [];
}

export async function youtubeTranscript(home, idOrUrl, { lang = "en", refresh = false } = {}) {
  const id = youtubeId(idOrUrl);
  if (!id) throw new Error(`not a YouTube id/url: ${idOrUrl}`);
  const produce = async () => {
    let title = "", channel = "", lengthSeconds = 0, description = "", tracks = [];
    try {
      const player = await innertubePlayer(id);
      const details = player.videoDetails ?? {};
      title = details.title ?? "";
      channel = details.author ?? "";
      lengthSeconds = Number(details.lengthSeconds ?? 0);
      description = String(details.shortDescription ?? "").slice(0, 3000);
      tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (player.playabilityStatus?.status && player.playabilityStatus.status !== "OK" && tracks.length === 0) {
        description ||= "";
        channel ||= "";
      }
    } catch {
      // fall through to the HTML scrape
    }
    if (tracks.length === 0) {
      const html = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { cookie: "CONSENT=YES+1; SOCS=CAI" } });
      title ||= decodeEntities((html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "").replace(/ - YouTube$/, ""));
      lengthSeconds ||= Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1] ?? 0);
      channel ||= html.match(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
      description ||= unescapeJsonString(html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "").replace(/\\n/g, "\n").slice(0, 3000);
      const tracksRaw = html.match(/"captionTracks":(\[[^\]]*\])/)?.[1];
      if (tracksRaw) tracks = JSON.parse(unescapeJsonString(tracksRaw).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    const base = { id, title, channel, lengthSeconds, description, url: `https://www.youtube.com/watch?v=${id}`, chapters: chaptersFromDescription(description, lengthSeconds) };
    if (tracks.length === 0) {
      return { ...base, transcript: null, error: "no captions available for this video (try another video, or WebFetch a written tutorial instead)" };
    }
    const byLang = tracks.filter((t) => String(t.languageCode ?? "").startsWith(lang));
    const pick = byLang.find((t) => t.kind !== "asr") ?? byLang[0] ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
    const xml = await fetchText(String(pick.baseUrl).replace(/&fmt=\w+/, ""), { headers: { "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip" } });
    const cues = parseTimedText(xml);
    return {
      ...base,
      language: pick.languageCode,
      auto: pick.kind === "asr",
      cueCount: cues.length,
      transcript: cues.length ? transcriptToText(cues) : null,
      error: cues.length ? undefined : "caption track exists but returned no cues",
    };
  };
  return refresh ? { ...(await produce()), cached: false } : cached(home, "videos", id, 30 * 24 * 3600_000, produce);
}

export async function youtubeSearch(home, query, { limit = 12 } = {}) {
  const produce = async () => {
    const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`, { headers: { cookie: "CONSENT=YES+1; SOCS=CAI" } });
    const results = [];
    const seen = new Set();
    for (const m of html.matchAll(/"videoRenderer":\{"videoId":"([\w-]{11})"/g)) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const chunk = html.slice(m.index, m.index + 6000);
      const title = unescapeJsonString(chunk.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
      const length = chunk.match(/"lengthText":\{[\s\S]{0,400}?"simpleText":"([^"]+)"/)?.[1] ?? "";
      const views = chunk.match(/"viewCountText":\{"simpleText":"([^"]+)"/)?.[1] ?? "";
      const channel = unescapeJsonString(chunk.match(/"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
      const published = chunk.match(/"publishedTimeText":\{"simpleText":"([^"]+)"/)?.[1] ?? "";
      results.push({ id, url: `https://www.youtube.com/watch?v=${id}`, title, channel, length, views, published });
      if (results.length >= limit) break;
    }
    return { query, results };
  };
  return cached(home, "video-search", query, 24 * 3600_000, produce);
}

// ---- discovery -------------------------------------------------------------

export async function assetLibrarySearch(home, { query = "", godotVersion = "4.3", category, type = "any", maxResults = 20, sort = "rating" } = {}) {
  const url = new URL("https://godotengine.org/asset-library/api/asset");
  if (query) url.searchParams.set("filter", query);
  url.searchParams.set("godot_version", godotVersion);
  url.searchParams.set("max_results", String(Math.min(40, maxResults)));
  url.searchParams.set("sort", sort);
  if (category) url.searchParams.set("category", String(category));
  if (type && type !== "any") url.searchParams.set("type", type);
  const produce = async () => {
    const data = await fetchJson(url.toString());
    const results = (data.result ?? []).map((a) => ({
      id: a.asset_id,
      title: a.title,
      author: a.author,
      category: a.category,
      version: a.version_string,
      godot: a.godot_version,
      license: a.cost,
      rating: a.rating,
      support: a.support_level,
      updated: a.modify_date,
      page: `https://godotengine.org/asset-library/asset/${a.asset_id}`,
      repo: a.browse_url,
      download: a.download_url,
    }));
    return { query, total: data.total_items ?? results.length, results };
  };
  return cached(home, "assetlib", `${query}|${godotVersion}|${category ?? ""}|${type}|${sort}`, 24 * 3600_000, produce);
}

export async function polyhavenSearch(home, { query = "", type = "models", limit = 20 } = {}) {
  const t = ["models", "textures", "hdris"].includes(type) ? type : "models";
  const all = await cached(home, "polyhaven", `index_${t}`, 24 * 3600_000, async () => ({ assets: await fetchJson(`https://api.polyhaven.com/assets?t=${t}`) }));
  const needle = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const [id, a] of Object.entries(all.assets ?? {})) {
    const hay = `${id} ${a.name ?? ""} ${(a.categories ?? []).join(" ")} ${(a.tags ?? []).join(" ")}`.toLowerCase();
    const score = needle.length === 0 ? (a.download_count ?? 0) / 1e6 : needle.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (needle.length && score === 0) continue;
    scored.push({ id, name: a.name, type: t, categories: a.categories, tags: (a.tags ?? []).slice(0, 8), downloads: a.download_count, authors: Object.keys(a.authors ?? {}), page: `https://polyhaven.com/a/${id}`, files: `https://api.polyhaven.com/files/${id}`, score });
  }
  scored.sort((x, y) => y.score - x.score || (y.downloads ?? 0) - (x.downloads ?? 0));
  return { query, type: t, total: scored.length, results: scored.slice(0, limit), note: "License CC0. Fetch `files` to get glTF/texture URLs by resolution; prefer 1k–2k for games." };
}

export async function polyhavenFiles(home, id, { resolution = "1k" } = {}) {
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const out = { id, resolution, gltf: null, blend: null, textures: {}, hdri: null };
  const gltf = files.gltf?.[resolution] ?? files.gltf?.["1k"] ?? files.gltf?.["2k"];
  if (gltf?.gltf) out.gltf = { url: gltf.gltf.url, size: gltf.gltf.size, include: Object.fromEntries(Object.entries(gltf.gltf.include ?? {}).map(([k, v]) => [k, v.url])) };
  if (files.hdri) out.hdri = Object.fromEntries(Object.entries(files.hdri).map(([res, fmts]) => [res, fmts.exr?.url ?? fmts.hdr?.url]));
  for (const key of ["Diffuse", "nor_gl", "Rough", "AO", "Displacement", "arm"]) {
    const entry = files[key]?.[resolution]?.png ?? files[key]?.[resolution]?.jpg;
    if (entry) out.textures[key] = entry.url;
  }
  return out;
}

export const LEARNING_SOURCES = [
  { name: "Godot docs — class reference", url: "https://docs.godotengine.org/en/stable/classes/index.html", bestFor: "exact API: properties, methods, signals (use docs op)" },
  { name: "Godot docs — tutorials", url: "https://docs.godotengine.org/en/stable/tutorials/index.html", bestFor: "physics, 2D/3D movement, animation, shaders, networking" },
  { name: "Godot docs — Your first 3D game", url: "https://docs.godotengine.org/en/stable/getting_started/first_3d_game/index.html", bestFor: "end-to-end CharacterBody3D + camera + mobs" },
  { name: "GDQuest", url: "https://www.gdquest.com/library/", bestFor: "polished patterns, state machines, juice, GDScript style" },
  { name: "KidsCanCode Godot Recipes", url: "https://kidscancode.org/godot_recipes/4.x/", bestFor: "bite-sized movement/physics/UI recipes for 4.x" },
  { name: "Godot Shaders", url: "https://godotshaders.com/", bestFor: "ready-made shaders (water, outline, dissolve, toon)" },
  { name: "Kenney", url: "https://kenney.nl/assets", bestFor: "CC0 game-ready 2D/3D/UI/audio kits" },
  { name: "Poly Haven", url: "https://polyhaven.com/", bestFor: "CC0 PBR textures, HDRIs, scanned models (discover op)" },
  { name: "Quaternius", url: "https://quaternius.com/", bestFor: "CC0 low-poly characters, props, animated packs" },
  { name: "Poly Pizza", url: "https://poly.pizza/", bestFor: "searchable low-poly CC0/CC-BY models" },
  { name: "ambientCG", url: "https://ambientcg.com/", bestFor: "CC0 materials and decals" },
  { name: "OpenGameArt", url: "https://opengameart.org/", bestFor: "sprites, tilesets, music (check license per asset)" },
  { name: "Mixamo", url: "https://www.mixamo.com/", bestFor: "humanoid animations (retarget in Godot 4)" },
  { name: "Sketchfab", url: "https://sketchfab.com/search?features=downloadable&type=models", bestFor: "downloadable models, filter by license" },
  { name: "freesound", url: "https://freesound.org/", bestFor: "SFX (check license)" },
  { name: "itch.io game assets", url: "https://itch.io/game-assets/free", bestFor: "free packs, pixel art, UI" },
  { name: "Godot Asset Library", url: "https://godotengine.org/asset-library/asset", bestFor: "addons: state machines, dialog, terrain, debug tools (discover op)" },
  { name: "Godot GitHub issues/discussions", url: "https://github.com/godotengine/godot/issues", bestFor: "confirming an engine bug or behaviour change before working around it" },
];

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
