import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface JavaProbe {
  available: boolean;
  message: string;
  raw?: string;
}

export class JavaBridge {
  constructor(private readonly workspace: string) {}

  async probe(): Promise<JavaProbe> {
    const classDir = path.join(this.workspace, "java", "crix-java-worker", "build", "classes");
    if (!existsSync(classDir)) {
      return { available: false, message: "Java worker is not built. Run .\\crix.bat java." };
    }
    return await new Promise<JavaProbe>((resolve) => {
      const child = spawn("java", ["-cp", classDir, "com.crix.worker.CrixJavaWorker", "probe"], { cwd: this.workspace, shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => resolve({ available: false, message: error.message }));
      child.on("close", (code) => {
        if (code === 0) resolve({ available: true, message: "Java worker available", raw: stdout.trim() });
        else resolve({ available: false, message: stderr.trim() || `Java worker exited ${code}`, raw: stdout.trim() });
      });
    });
  }
}
