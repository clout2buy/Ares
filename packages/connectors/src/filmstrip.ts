// The filmstrip — visual proof + audit trail (Ares v5 / O6 / concept C12).
//
// Every browser action records a screenshot frame. The ordered sequence is a
// replayable film of exactly what Ares did — the thing that makes overnight
// autonomy legible ("show me what you did") and that, paired with the ledger's
// decision traces, earns the trust to extend a leash. Frames are real PNG files
// on disk; manifest.jsonl is the append-only index.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { Screenshot } from "./types.js";

export interface FilmstripEntry {
  frame: number;
  at: string;
  action: string;
  url: string;
  file: string;
  note?: string;
}

export class Filmstrip {
  constructor(private readonly dir: string) {}

  async record(input: { action: string; url: string; screenshot: Screenshot; note?: string; at?: Date }): Promise<FilmstripEntry> {
    const existing = await this.load();
    const frame = existing.length;
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `frame-${String(frame).padStart(4, "0")}.png`);
    await fs.writeFile(file, Buffer.from(input.screenshot.bytes, "base64"));
    const entry: FilmstripEntry = {
      frame,
      at: (input.at ?? new Date()).toISOString(),
      action: input.action,
      url: input.url,
      file,
      note: input.note,
    };
    await fs.appendFile(path.join(this.dir, "manifest.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  async load(): Promise<FilmstripEntry[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir, "manifest.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as FilmstripEntry)
        .sort((a, b) => a.frame - b.frame);
    } catch {
      return [];
    }
  }
}
