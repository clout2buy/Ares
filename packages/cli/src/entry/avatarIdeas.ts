// Avatar ideas: an agent proposes its own profile picture (owner, 2026-10-24).
// The agent writes a few short ideas; each renders in ONE house style and the
// owner picks one in the chat. Picking is the approval: nothing is live until
// then. Renders on Nano Banana 2 through OpenRouter (the owner's pick; their
// GPU is often busy with a game), else OpenAI's GPT Image, else Gemini, else
// the local ComfyUI (FLUX.2 Klein).
//
// The style is also the rig's intake contract (tauri/src/avatarRig.ts): a
// front-facing, full-body character with arms at its sides and both eyes and
// mouth visible, so every avatar made here can later get the full rig.
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aresAgentHome } from "@ares/agent";
import { getCredential } from "@ares/core";
import { geminiImage, openaiImage, openrouterImage } from "@ares/tools";

export const AVATAR_STYLE =
  "cute 3D character mascot, soft plush collectible figurine, Pixar-style render, front-facing, full body, standing in a neutral pose with arms relaxed at its sides, " +
  "two clearly visible eyes and a small visible mouth, single character centered with room around it, plain soft off-white studio background, soft even studio lighting, " +
  "square 1:1 image, no text, no logo, no watermark";

type Comfy = {
  comfyConfig(home: string): Promise<{ dir: string | null; url: string; models: { flux: string; fluxClip: string; fluxVae: string } } & Record<string, unknown>>;
  ensureComfy(cfg: unknown, opts?: { startupTimeoutMs?: number }): Promise<unknown>;
  fluxKleinPrompt(o: { prompt: string; width?: number; height?: number; steps?: number; model: string; clip: string; vae: string; filenamePrefix?: string }): unknown;
  runPrompt(o: { url: string; prompt: unknown; waitMs?: number }): Promise<{ files: Array<{ file: string; type: string }>; seconds: number }>;
  outputPath(dir: string, file: { file: string; type: string }): string;
};

/** The ComfyUI client the bundled Godot skill installs (~/.ares/skills/godot). */
async function comfyClient(home: string): Promise<Comfy> {
  const file = path.join(home, "skills", "godot", "lib", "comfy.js");
  if (!(await fs.stat(file).catch(() => null))) throw new Error("local image generation is not set up (the Godot skill's ComfyUI client is missing)");
  return (await import(pathToFileURL(file).href)) as Comfy;
}

export async function generateAvatarIdeas(agentId: string, ideas: string[]): Promise<{ options: Array<{ n: number; idea: string; path: string }>; seconds: number; generator: string }> {
  const home = aresAgentHome(process.env.ARES_HOME);
  const outDir = path.join(home, "avatars", "ideas", agentId.replace(/[^\w-]/g, "_"), String(Date.now()));
  await fs.mkdir(outDir, { recursive: true });
  const started = Date.now();
  const render = await renderer(home);
  // the cloud renders run side by side; the local GPU takes them one at a time
  const one = async (idea: string, i: number) => {
    const dest = path.join(outDir, `option-${i + 1}.png`);
    await fs.writeFile(dest, await render.image(`${idea}. ${AVATAR_STYLE}`));
    return { n: i + 1, idea, path: dest };
  };
  const options = render.parallel ? await Promise.all(ideas.map(one)) : [];
  if (!render.parallel) for (const [i, idea] of ideas.entries()) options.push(await one(idea, i));
  return { options, seconds: Math.round((Date.now() - started) / 1000), generator: render.name };
}

async function renderer(home: string): Promise<{ name: string; parallel: boolean; image(prompt: string): Promise<Buffer> }> {
  const openrouterKey = await getCredential("OPENROUTER_API_KEY").catch(() => undefined);
  if (openrouterKey) return { name: "Nano Banana 2", parallel: true, image: async (prompt) => (await openrouterImage(openrouterKey, { prompt, model: process.env.ARES_AVATAR_IMAGE_MODEL?.trim() || "google/gemini-3.1-flash-image" })).bytes };
  const openaiKey = await getCredential("OPENAI_API_KEY").catch(() => undefined);
  if (openaiKey) return { name: "GPT Image", parallel: true, image: (prompt) => openaiImage(openaiKey, { prompt, size: "1024x1024" }) };
  const geminiKey = await getCredential("GEMINI_API_KEY", { envFallback: ["GOOGLE_API_KEY"] }).catch(() => undefined);
  if (geminiKey) return { name: "Gemini", parallel: true, image: async (prompt) => (await geminiImage(geminiKey, { prompt })).bytes };
  const comfy = await comfyClient(home);
  const cfg = await comfy.comfyConfig(home);
  if (!cfg.dir) throw new Error("no image generator: connect OpenAI or Gemini, or set up ComfyUI (comfyDir in ~/.ares/godot.json)");
  await comfy.ensureComfy(cfg, { startupTimeoutMs: 240_000 });
  return {
    name: "FLUX.2 Klein (local)",
    parallel: false,
    image: async (prompt) => {
      const run = await comfy.runPrompt({
        url: cfg.url,
        prompt: comfy.fluxKleinPrompt({ prompt, width: 768, height: 768, steps: 4, model: cfg.models.flux, clip: cfg.models.fluxClip, vae: cfg.models.fluxVae, filenamePrefix: "ares_avatar" }),
        waitMs: 300_000,
      });
      const image = run.files.find((f) => /\.(png|jpg|webp)$/i.test(f.file));
      if (!image) throw new Error("ComfyUI produced no image");
      return fs.readFile(comfy.outputPath(cfg.dir!, image));
    },
  };
}
