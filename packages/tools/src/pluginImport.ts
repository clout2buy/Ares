// Plugins from anywhere. A plugin is a file or a folder in some other agent's
// shape, and the promise is that none of them is a dead end: what maps onto a
// module installs, and code written for another runtime is kept as source for
// Ares to rebuild natively. Nothing here runs anything it reads.
//
// The one real wall is encryption. A sealed module holds nothing readable, so
// that is said plainly rather than guessed around.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { aresHome } from "@ares/core";
import { surfaceHtmlProblem, type SurfaceDocument } from "@ares/protocol";

const MAX_FILES = 20_000;
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
const MAX_KEPT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_INLINED_ASSET_BYTES = 2 * 1024 * 1024;

export type PluginFileKind = "zip" | "gzip" | "tar" | "text" | "sealed" | "binary";

function entropy(bytes: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b] += 1;
  let bits = 0;
  for (const n of counts) {
    if (!n) continue;
    const p = n / bytes.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function pluginFileKind(buf: Buffer): PluginFileKind {
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)) return "zip";
  if (buf[0] === 0x1f && buf[1] === 0x8b) return "gzip";
  if (buf.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  const head = buf.subarray(0, 8192);
  if (!head.includes(0)) return "text";
  // Compressed or encrypted data looks like noise, and every archive this reads
  // was recognized above. What is left and random can only be read by its maker.
  const sample = buf.subarray(Math.min(64, buf.length), 65_536 + 64);
  return sample.length >= 256 && entropy(sample) > 7.9 ? "sealed" : "binary";
}

/** "PALLARIUM-SEALED-MODULE" → "Pallarium": the maker, when the file says so. */
function sealedBy(buf: Buffer): string | null {
  const word = /^[A-Za-z][A-Za-z0-9]{3,30}/.exec(buf.subarray(0, 40).toString("latin1"))?.[0];
  return word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : null;
}

export function sealedMessage(file: string, buf: Buffer): string {
  const maker = sealedBy(buf);
  return `${path.basename(file)} is sealed${maker ? ` by ${maker}` : ""}: it is encrypted, so only ${maker ?? "the app that made it"} can open it, and nothing inside can be read or converted here. Ask whoever made it for the unsealed module or its source folder and import that, or describe what it does and build it with Surface.`;
}

function safeJoin(root: string, name: string): string | null {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").includes("..")) return null;
  return path.join(root, clean);
}

async function writeEntry(root: string, name: string, data: Buffer): Promise<void> {
  const target = safeJoin(root, name);
  if (!target) return; // an entry that climbs out of the folder is simply not written
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
}

async function unzip(buf: Buffer, root: string): Promise<void> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("this zip has no directory, so it is damaged or incomplete");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new Error(`this archive holds ${count} files, more than Ares will unpack`);
  let at = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error("this zip's directory is damaged");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || (mode & 0o170000) === 0o120000) continue; // folders and symlinks
    if (flags & 1) throw new Error("this archive is password protected; unpack it yourself and import the folder");
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw new Error("this archive unpacks to more than 300 MB");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + packed);
    if (method !== 0 && method !== 8) continue;
    await writeEntry(root, name, method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) + 1024 }));
  }
}

async function untar(buf: Buffer, root: string): Promise<void> {
  let at = 0;
  let files = 0;
  while (at + 512 <= buf.length && buf[at] !== 0) {
    const text = (a: number, n: number) => buf.subarray(at + a, at + a + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12).trim(), 8) || 0;
    const type = text(156, 1);
    const prefix = text(345, 155);
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    if ((type === "0" || type === "") && !name.endsWith("/")) {
      files += 1;
      if (files > MAX_FILES) throw new Error("this archive holds too many files");
      await writeEntry(root, name, buf.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
}

/** Where a plugin's files live for Ares to read. Named by content, so unpacking
 * the same file twice is one folder. */
function importDir(name: string, content: Buffer, home?: string): string {
  const tag = createHash("sha256").update(content).digest("hex").slice(0, 10);
  return path.join(home ?? aresHome(), "imports", `${name}-${tag}`);
}

/** Unpack an archive and hand back its folder; an archive wrapping one folder
 * (an npm package, a GitHub download) gives that folder. */
export async function unpackPlugin(buf: Buffer, kind: "zip" | "gzip" | "tar", name: string, home?: string): Promise<string> {
  const root = importDir(name, buf, home);
  await mkdir(root, { recursive: true });
  if (kind === "zip") await unzip(buf, root);
  else if (kind === "tar") await untar(buf, root);
  else {
    const inner = gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES });
    if (pluginFileKind(inner) !== "tar") await writeFile(path.join(root, name), inner);
    else await untar(inner, root);
  }
  const top = await readdir(root, { withFileTypes: true });
  return top.length === 1 && top[0].isDirectory() ? path.join(root, top[0].name) : root;
}

const CODE_RE = /\.(m?[jt]sx?|cjs|py|lua|rb|go|rs|cs|java|kt|swift|vue|svelte|sh|ps1|php|wasm)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", ".venv", "__pycache__", "target", ".next"]);

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) await walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
}

export interface PluginPort {
  /** Where the plugin's own files are, for reading. */
  dir: string;
  files: string[];
  /** Whose runtime the code was written for. */
  runtime: string;
}

/** Code that cannot run here as it is: keep it where Ares can read it and rebuild it. */
export async function keepForPorting(source: string, name: string, runtime: string, home?: string): Promise<PluginPort | null> {
  const all: string[] = [];
  await walk(source, source, all);
  const code = all.filter((f) => CODE_RE.test(f));
  if (!code.length) return null;
  const base = path.join(home ?? aresHome(), "imports");
  if (path.resolve(source).startsWith(path.resolve(base) + path.sep)) return { dir: source, files: code.slice(0, 200), runtime };
  const tag = createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 10);
  const dir = path.join(base, `${name}-${tag}`);
  for (const file of all) {
    const from = path.join(source, file);
    if (((await stat(from).catch(() => null))?.size ?? Infinity) > MAX_KEPT_FILE_BYTES) continue;
    const to = path.join(dir, file);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  return { dir, files: code.slice(0, 200), runtime };
}

/** What the folder's own manifest says it is, for the name and for the message. */
export async function identifyPlugin(dir: string): Promise<{ name?: string; from?: string }> {
  const json = async (file: string) => JSON.parse(await readFile(path.join(dir, file), "utf8").catch(() => "null")) as Record<string, unknown> | null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const manifest = await json("manifest.json").catch(() => null);
  if (manifest?.manifest_version) return { name: text(manifest.name), from: "browser extension" };
  if (manifest?.minAppVersion) return { name: text(manifest.name), from: "Obsidian plugin" };
  const pkg = await json("package.json").catch(() => null);
  if ((pkg?.engines as { vscode?: unknown } | undefined)?.vscode) return { name: text(pkg?.displayName) ?? text(pkg?.name), from: "VS Code extension" };
  const plugin = await json("plugin.json").catch(() => null);
  return { name: text(plugin?.name) ?? text(manifest?.name) ?? text(pkg?.name), from: plugin ? "plugin" : undefined };
}

/** Coding-agent rule files that are plain instructions, whichever agent they came from. */
export async function ruleFiles(dir: string): Promise<Array<{ name: string; text: string }>> {
  const rules: Array<{ name: string; text: string }> = [];
  for (const file of [".cursorrules", ".windsurfrules", ".clinerules", "GEMINI.md"]) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => "");
    if (text.trim()) rules.push({ name: file.replace(/^\./, "").replace(/\.md$/, ""), text });
  }
  for (const file of await readdir(path.join(dir, ".cursor", "rules")).catch(() => [] as string[])) {
    if (!/\.mdc?$/.test(file)) continue;
    const text = await readFile(path.join(dir, ".cursor", "rules", file), "utf8").catch(() => "");
    if (text.trim()) rules.push({ name: file.replace(/\.mdc?$/, ""), text });
  }
  return rules;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };

/** A self-contained page becomes a surface: the sandbox is the same, so it just
 * works. Null when it needs a bundler or the network, which makes it a port. */
export async function surfaceFromHtml(file: string): Promise<{ title: string; document: SurfaceDocument } | null> {
  const page = await readFile(file, "utf8").catch(() => "");
  if (!page.trim()) return null;
  const dir = path.dirname(file);
  // A plugin's page may only pull in its own files, never one beside or above it.
  const inside = (ref: string) => {
    const full = path.resolve(dir, ref.replace(/^\.?[\\/]/, "").replace(/[?#].*$/, ""));
    return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
  };
  const local = async (ref: string) => {
    const full = /^[a-z]+:|^\/\//i.test(ref) ? null : inside(ref);
    return full ? readFile(full, "utf8").catch(() => null) : null;
  };
  let css = "";
  let js = "";
  let html = /<body[^>]*>([\s\S]*)<\/body>/i.exec(page)?.[1] ?? page.replace(/<!doctype[^>]*>|<\/?html[^>]*>|<head[\s\S]*?<\/head>/gi, "");
  for (const m of page.matchAll(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi)) {
    const href = /href=["']([^"']+)/i.exec(m[0])?.[1];
    const text = href ? await local(href) : null;
    if (text === null) return null;
    css += `${text}\n`;
  }
  for (const m of page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += `${m[1]}\n`;
  for (const m of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /src=["']([^"']+)/i.exec(m[1])?.[1];
    const text = src ? await local(src) : m[2];
    if (text === null) return null;
    if (/^\s*(import|export)\s/m.test(text) || /\bimport\s*\(/.test(text)) return null;
    js += `${text}\n`;
  }
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<(link|meta|base)\b[^>]*>/gi, "");
  for (const m of [...html.matchAll(/\bsrc=["']([^"':]+\.[a-z]+)["']/gi)]) {
    const mime = MIME[path.extname(m[1]).toLowerCase()];
    const asset = mime ? inside(m[1]) : null;
    const bytes = asset ? await readFile(asset).catch(() => null) : null;
    if (bytes && bytes.length <= MAX_INLINED_ASSET_BYTES) html = html.replace(m[0], `src="data:${mime};base64,${bytes.toString("base64")}"`);
  }
  const wrapped = `<div data-ares-region="main">${html}</div>`;
  if (surfaceHtmlProblem(wrapped)) return null;
  const title = /<title[^>]*>([^<]{1,120})/i.exec(page)?.[1]?.trim() ?? path.basename(dir);
  return { title, document: { title, html: wrapped, css, js } };
}
