import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AgentTemplateName =
  | "BOOTSTRAP.md"
  | "IDENTITY.md"
  | "SOUL.md"
  | "USER.md"
  | "HEARTBEAT.md"
  | "MEMORY.md"
  | "CAPABILITIES.md"
  | "TOOLS.md";

export async function readTemplate(name: AgentTemplateName): Promise<string> {
  const distTemplate = path.resolve(__dirname, "..", "templates", name);
  const srcTemplate = path.resolve(__dirname, "..", "..", "templates", name);
  try {
    return await readFile(distTemplate, "utf8");
  } catch {
    return await readFile(srcTemplate, "utf8");
  }
}

