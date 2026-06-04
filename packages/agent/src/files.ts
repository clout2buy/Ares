import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function readTextIfExists(file: string, maxChars = 24_000): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return null;
    const text = await readFile(file, "utf8");
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`
      : text;
  } catch {
    return null;
  }
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{([A-Z0-9_]+)}}/g, (_match, key: string) => values[key] ?? "");
}

export function nonCommentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

