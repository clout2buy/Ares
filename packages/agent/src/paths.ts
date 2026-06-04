import os from "node:os";
import path from "node:path";

export interface AgentPaths {
  home: string;
  identity: string;
  soul: string;
  user: string;
  heartbeat: string;
  memory: string;
  capabilities: string;
  config: string;
  bootstrap: string;
  vectorsDb: string;
  vectorsJson: string;
  memoryDir: string;
  transcriptsDir: string;
  skillsDir: string;
  dreamsDir: string;
  dreamsDiary: string;
  heartbeatState: string;
  missionsDir: string;
  selfDir: string;
  selfModel: string;
}

export function crixAgentHome(explicit?: string): string {
  return path.resolve(explicit ?? process.env.CRIX_HOME ?? path.join(os.homedir(), ".crix"));
}

export function agentPaths(home = crixAgentHome()): AgentPaths {
  return {
    home,
    identity: path.join(home, "IDENTITY.md"),
    soul: path.join(home, "SOUL.md"),
    user: path.join(home, "USER.md"),
    heartbeat: path.join(home, "HEARTBEAT.md"),
    memory: path.join(home, "MEMORY.md"),
    capabilities: path.join(home, "CAPABILITIES.md"),
    config: path.join(home, "config.json"),
    bootstrap: path.join(home, "BOOTSTRAP.md"),
    vectorsDb: path.join(home, "vectors.db"),
    vectorsJson: path.join(home, "vectors.json"),
    memoryDir: path.join(home, "memory"),
    transcriptsDir: path.join(home, "transcripts"),
    skillsDir: path.join(home, "skills"),
    dreamsDir: path.join(home, ".dreams"),
    dreamsDiary: path.join(home, "DREAMS.md"),
    heartbeatState: path.join(home, "memory", "heartbeat-state.json"),
    missionsDir: path.join(home, "missions"),
    selfDir: path.join(home, "self"),
    selfModel: path.join(home, "self", "model.json"),
  };
}

export function workspaceToolsPath(workspace: string): string {
  return path.join(path.resolve(workspace), ".crix", "TOOLS.md");
}

