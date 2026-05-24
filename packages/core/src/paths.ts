import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function resolveWorkspace(workspace: string): Promise<string> {
  return await realpath(workspace);
}

export function resolveInside(workspace: string, requested: string): string {
  const base = path.resolve(workspace);
  const candidate = path.resolve(base, requested);
  const relative = path.relative(base, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return candidate;
}

export function toRelative(workspace: string, file: string): string {
  return path.relative(workspace, file) || ".";
}
