// Avatar poses: one base set of animation frames that any avatar is mapped
// onto (owner, 2026-10-24: "base frames for working, thinking, creating, and
// any images people give get overlayed onto those"). The pose set and the
// script that plays it (tauri/src/avatarRig.ts) are fixed; when an agent gets
// a new picture, Nano Banana redraws THAT character in each pose, keeping its
// own body, framing and background.
// Tried first: transferring poses from a grey base figure. Non-human avatars
// took on the figure's body (a raven came back as a humanoid), so each pose
// is described in words and edited onto the avatar itself.
// Runs in the background after the picture is set; the still is live at once.
import { promises as fs } from "node:fs";
import path from "node:path";
import { aresAgentHome } from "@ares/agent";
import { getCredential } from "@ares/core";

/** Every frame the script plays. `from` names the frame it is edited from:
 *  the avatar itself, or the first frame of the same loop (so a loop's two
 *  frames line up exactly and only the moving part changes). */
export const POSES = [
  { name: "blink", from: "avatar", edit: "blinking: both eyes shut tight, each drawn as a closed curved eyelid line with no eyeball or pupil showing. Everything else identical" },
  { name: "look_left", from: "avatar", edit: "with its head and eyes turned to look toward the left edge of the picture. Body, size and position unchanged" },
  { name: "look_right", from: "avatar", edit: "with its head and eyes turned to look toward the right edge of the picture. Body, size and position unchanged" },
  { name: "thinking", from: "avatar", edit: "in a thinking pose: eyes looking up and to the side, one hand (or wing, paw, limb) raised to its chin, with three small glowing glass orbs floating above its head" },
  { name: "thinking_b", from: "thinking", edit: "the hand (or wing, paw, limb) on its chin is now tapping a little lower on the chin, its eyes look up toward the other side, and the three orbs have drifted slightly. Everything else identical" },
  { name: "working", from: "avatar", edit: "working: typing on a floating, see-through frosted-glass holographic panel hovering in front of it at chest height, with a few soft lines of light on it, eyes on the panel, hands (or wings, paws, limbs) raised just above the panel" },
  { name: "working_b", from: "working", edit: "its hands (or wings, paws, limbs) are now pressed onto the glass panel mid-tap, head dipped very slightly toward it. Everything else identical" },
  { name: "creating", from: "avatar", edit: "creating something: shaping a small glowing ember-orange glass cube that floats between its hands (or wings, paws, limbs), looking at it with delight" },
  { name: "creating_b", from: "creating", edit: "its hands (or wings, paws, limbs) have moved a little and the cube has turned a quarter turn and floats a little higher, the same size and glow. Everything else identical" },
] as const;
export type PoseName = (typeof POSES)[number]["name"];

const MODEL = () => process.env.ARES_AVATAR_IMAGE_MODEL?.trim() || "google/gemini-3.1-flash-image";
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;

/** Nano Banana through OpenRouter's chat endpoint: text plus reference images in, one image out. */
async function nanoBanana(key: string, prompt: string, images: Buffer[] = []): Promise<Buffer> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL(),
      modalities: ["image", "text"],
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map((b) => ({ type: "image_url", image_url: { url: dataUrl(b) } }))] }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }> };
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url?.startsWith("data:")) throw new Error("Nano Banana returned no image");
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

const home = () => aresAgentHome(process.env.ARES_HOME);
const exists = (f: string) => fs.stat(f).then(() => true, () => false);

const posesDir = (agentId: string, version: string) => path.join(home(), "avatars", "poses", agentId.replace(/[^\w-]/g, "_"), version.replace(/[^\w-]/g, "_"));

/** The pose frames already made for this picture version, if complete. */
export async function readPoses(agentId: string, version: string): Promise<Record<PoseName, string> | null> {
  const dir = posesDir(agentId, version);
  const out = {} as Record<PoseName, string>;
  for (const pose of POSES) {
    const file = path.join(dir, `${pose.name}.png`);
    if (!(await exists(file))) return null;
    out[pose.name] = file;
  }
  return out;
}

/** Redraw `avatar` in every base pose. Null when no OpenRouter key is connected. */
export async function renderPoses(agentId: string, version: string, avatar: Buffer): Promise<Record<PoseName, string> | null> {
  const key = await getCredential("OPENROUTER_API_KEY").catch(() => undefined);
  if (!key) return null;
  const dir = posesDir(agentId, version);
  await fs.mkdir(dir, { recursive: true });
  const out = {} as Record<PoseName, string>;
  const made = new Map<string, Buffer>([["avatar", avatar]]);
  const one = async (pose: (typeof POSES)[number]) => {
    const file = path.join(dir, `${pose.name}.png`);
    const prompt =
      `Edit this image: the same character, ${pose.edit}. Keep the exact same character design, colours, materials and render style, ` +
      "the same camera, zoom and framing, the character the same size and in the same place, and the same plain background. Square image.";
    const bytes = await nanoBanana(key, prompt, [made.get(pose.from)!]);
    made.set(pose.name, bytes);
    await fs.writeFile(file, bytes);
    out[pose.name] = file;
  };
  // first frames from the avatar, then each loop's second frame from its first
  await Promise.all(POSES.filter((p) => p.from === "avatar").map(one));
  await Promise.all(POSES.filter((p) => p.from !== "avatar").map(one));
  return out;
}

// ── living clips: real motion per state, rendered once per picture ──────────
// Each state gets a short image-to-video loop on OpenRouter (Seedance 2.0 Mini
// by default: cheap, square, and it takes a last frame). The clip starts AND
// ends on the state's own frame, so it loops with no seam. Until a clip lands
// (or if one fails), the pose frames above play that state instead.
export const CLIPS = [
  { state: "idle", from: "avatar", prompt: "The character stands still and breathes gently, blinks once, glances to one side and back, then settles exactly into its starting pose." },
  { state: "thinking", from: "thinking", prompt: "The character thinks: taps its chin slowly, eyes drifting up and to the side, the small glowing orbs above its head drift gently, then it settles exactly into its starting pose." },
  { state: "working", from: "working", prompt: "The character types on the floating glass panel with small natural finger taps and a slight head bob, then settles exactly into its starting pose." },
  { state: "creating", from: "creating", prompt: "The character turns the small glowing cube over between its hands, delighted, the cube rotating slowly with a steady glow, then settles exactly into its starting pose." },
] as const;
export type ClipState = (typeof CLIPS)[number]["state"];

const VIDEO_MODEL = () => process.env.ARES_AVATAR_VIDEO_MODEL?.trim() || "bytedance/seedance-2.0-mini";
const STILL = " Static camera, no zoom, no pan, no cut, plain background stays the same, no flashes, steady lighting.";

async function videoLoop(key: string, frame: Buffer, prompt: string, dest: string): Promise<void> {
  const url = dataUrl(frame);
  const submit = await fetch("https://openrouter.ai/api/v1/videos", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: VIDEO_MODEL(), duration: 4, resolution: "480p", aspect_ratio: "1:1", generate_audio: false, prompt: prompt + STILL,
      frame_images: [{ type: "image_url", image_url: { url }, frame_type: "first_frame" }, { type: "image_url", image_url: { url }, frame_type: "last_frame" }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const job = (await submit.json()) as { id?: string; error?: { message?: string } };
  if (!job.id) throw new Error(`video submit: ${job.error?.message ?? submit.status}`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const poll = (await (await fetch(`https://openrouter.ai/api/v1/videos/${job.id}`, { headers: { authorization: `Bearer ${key}` } })).json()) as { status?: string; error?: unknown };
    if (poll.status === "failed") throw new Error(`video failed: ${JSON.stringify(poll.error ?? "").slice(0, 200)}`);
    if (poll.status === "completed") {
      const video = await fetch(`https://openrouter.ai/api/v1/videos/${job.id}/content?index=0`, { headers: { authorization: `Bearer ${key}` } });
      if (!video.ok) throw new Error(`video download HTTP ${video.status}`);
      await fs.writeFile(dest, Buffer.from(await video.arrayBuffer()));
      return;
    }
  }
  throw new Error("video timed out");
}

/** The clips already made for this picture version (whichever exist). */
export async function readClips(agentId: string, version: string): Promise<Partial<Record<ClipState, string>> | null> {
  const dir = posesDir(agentId, version);
  const out: Partial<Record<ClipState, string>> = {};
  for (const clip of CLIPS) {
    const file = path.join(dir, `clip_${clip.state}.mp4`);
    if (await exists(file)) out[clip.state] = file;
  }
  return Object.keys(out).length ? out : null;
}

/** Render every state's loop; a clip that fails is skipped (its frames play). */
export async function renderClips(agentId: string, version: string, avatar: Buffer): Promise<Partial<Record<ClipState, string>> | null> {
  const key = await getCredential("OPENROUTER_API_KEY").catch(() => undefined);
  if (!key) return null;
  const dir = posesDir(agentId, version);
  const out: Partial<Record<ClipState, string>> = {};
  await Promise.all(CLIPS.map(async (clip) => {
    const frameFile = path.join(dir, `${clip.from}.png`);
    const frame = clip.from === "avatar" ? avatar : await fs.readFile(frameFile).catch(() => null);
    if (!frame) return;
    const dest = path.join(dir, `clip_${clip.state}.mp4`);
    try {
      await videoLoop(key, frame, clip.prompt, dest);
      out[clip.state] = dest;
    } catch {
      // that state keeps its pose frames
    }
  }));
  return Object.keys(out).length ? out : null;
}
