import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "./paths.js";

export interface EditResult {
  path: string;
  checkpointDir: string;
  message: string;
}

export class ReversibleEditor {
  constructor(private readonly workspace: string, private readonly checkpointDir: string) {}

  async createDir(target: string): Promise<EditResult> {
    const resolved = resolveInside(this.workspace, target);
    await this.checkpoint(resolved);
    await mkdir(resolved, { recursive: true });
    return { path: resolved, checkpointDir: this.checkpointDir, message: `created directory ${target}` };
  }

  async writeFile(target: string, content: string): Promise<EditResult> {
    const resolved = resolveInside(this.workspace, target);
    await this.checkpoint(resolved);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    return { path: resolved, checkpointDir: this.checkpointDir, message: `wrote ${content.length} bytes to ${target}` };
  }

  async replaceText(target: string, oldText: string, newText: string): Promise<EditResult> {
    const resolved = resolveInside(this.workspace, target);
    const before = await readFile(resolved, "utf8");
    const matches = before.split(oldText).length - 1;
    if (matches === 0) throw new Error(`oldText not found in ${target}`);
    if (matches > 1) throw new Error(`oldText appears ${matches} times in ${target}; narrow the edit`);
    await this.checkpoint(resolved);
    const after = before.replace(oldText, newText);
    await writeFile(resolved, after, "utf8");
    return { path: resolved, checkpointDir: this.checkpointDir, message: `replaced text in ${target}` };
  }

  async multiReplaceText(target: string, edits: Array<{ oldText: string; newText: string }>): Promise<EditResult> {
    if (edits.length === 0) throw new Error("multi_edit requires at least one edit");
    const resolved = resolveInside(this.workspace, target);
    let after = await readFile(resolved, "utf8");
    const checks: Array<{ oldText: string; matches: number }> = [];

    for (const edit of edits) {
      if (!edit.oldText) throw new Error("multi_edit oldText must not be empty");
      const matches = after.split(edit.oldText).length - 1;
      checks.push({ oldText: edit.oldText, matches });
      if (matches === 0) throw new Error(`oldText not found in ${target}: ${preview(edit.oldText)}`);
      if (matches > 1) throw new Error(`oldText appears ${matches} times in ${target}; narrow the edit: ${preview(edit.oldText)}`);
      after = after.replace(edit.oldText, edit.newText);
    }

    await this.checkpoint(resolved);
    await writeFile(resolved, after, "utf8");
    return {
      path: resolved,
      checkpointDir: this.checkpointDir,
      message: `applied ${checks.length} ordered edit${checks.length === 1 ? "" : "s"} to ${target}`,
    };
  }

  static async rollback(checkpointDir: string): Promise<void> {
    const manifest = JSON.parse(await readFile(path.join(checkpointDir, "manifest.json"), "utf8")) as Array<{ file: string; backup: string; existed: boolean }>;
    for (const entry of manifest.reverse()) {
      if (entry.existed) {
        await mkdir(path.dirname(entry.file), { recursive: true });
        await copyFile(entry.backup, entry.file);
      } else {
        await rm(entry.file, { force: true, recursive: true });
      }
    }
  }

  private async checkpoint(file: string): Promise<void> {
    await mkdir(path.join(this.checkpointDir, "files"), { recursive: true });
    const manifestPath = path.join(this.checkpointDir, "manifest.json");
    let manifest: Array<{ file: string; backup: string; existed: boolean }> = [];
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (manifest.some((entry) => entry.file === file)) return;
    const backup = path.join(this.checkpointDir, "files", `${manifest.length}.bak`);
    let existed = true;
    try {
      await copyFile(file, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
      await writeFile(backup, "", "utf8");
    }
    manifest.push({ file, backup, existed });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}
