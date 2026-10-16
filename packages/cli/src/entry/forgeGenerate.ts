// Image -> 3D: when the owner wants an EXACT replica of a picture (a concept sheet, a photo, a turnaround),
// hand-placing primitives only resembles it. A dedicated image-to-3D model reconstructs the real mesh AND
// paints its texture from the picture. This module sends the reference image(s) to one, waits for the job,
// and saves the textured GLB into the project; runModelAction then places it as a `gltf` part so Ares can
// rig, animate, combine and export it like anything else.
//
// Providers (each needs its own API key in Ares credentials; images go out as data: URIs, nothing is hosted):
//  - meshy  (MESHY_API_KEY): POST /openapi/v1/image-to-3d {image_url, enable_pbr, should_texture},
//           or /openapi/v1/multi-image-to-3d {image_urls[1-4]} for turnarounds; poll GET .../{id} until
//           status SUCCEEDED, then model_urls.glb.
//  - fal    (FAL_KEY): queue API, fal-ai/hunyuan3d/v2 (default, textured) or fal-ai/trellis; POST input,
//           poll status_url until COMPLETED, read response_url -> model_mesh.url.
// The HTTP layer is injectable (tests), deadlines are hard, and every failure says which step failed.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type GenProvider = "meshy" | "fal";
export interface GenerateOptions {
  /** project-relative image paths (png/jpg/webp), 1-4: the front view first; more views help (side, back, 3/4). */
  images: string[];
  provider: GenProvider;
  key: string;
  cwd: string;
  /** project-relative output .glb */
  out: string;
  /** fal model id (fal-ai/hunyuan3d/v2, fal-ai/trellis, ...) */
  model?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  deadlineMs?: number;
  onProgress?: (msg: string) => void;
  resolvePath: (cwd: string, rel: string) => Promise<string>;
}

const IMG_MAX = 8_000_000;
async function dataUri(abs: string): Promise<string> {
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : /\.jpe?g$/.test(ext) ? "image/jpeg" : "";
  if (!mime) throw new Error(`${path.basename(abs)}: images must be png/jpg/webp`);
  const info = await stat(abs);
  if (info.size > IMG_MAX) throw new Error(`${path.basename(abs)} is ${(info.size / 1e6).toFixed(1)}MB (max 8MB)`);
  return `data:${mime};base64,${(await readFile(abs)).toString("base64")}`;
}

async function json(res: Response, step: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${step}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`${step}: not JSON: ${text.slice(0, 200)}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one image-to-3D job and save the GLB. Returns the project-relative path. */
export async function generateModel(o: GenerateOptions): Promise<{ glb: string; provider: string; model: string; seconds: number }> {
  const f = o.fetchImpl ?? fetch, poll = o.pollMs ?? 5000, deadline = Date.now() + (o.deadlineMs ?? 15 * 60_000), t0 = Date.now();
  if (!o.images.length || o.images.length > 4) throw new Error("generate needs 1-4 images (front view first)");
  if (!o.out.endsWith(".glb")) throw new Error("generate output must end in .glb");
  const uris = await Promise.all(o.images.map(async (rel) => dataUri(await o.resolvePath(o.cwd, rel))));
  let glbUrl = "", model = "";
  if (o.provider === "meshy") {
    const base = "https://api.meshy.ai/openapi/v1", multi = uris.length > 1, kind = multi ? "multi-image-to-3d" : "image-to-3d";
    model = `meshy ${kind}`;
    const auth = { authorization: `Bearer ${o.key}`, "content-type": "application/json" };
    const body = multi ? { image_urls: uris, should_texture: true, enable_pbr: true } : { image_url: uris[0], should_texture: true, enable_pbr: true };
    const created = await json(await f(`${base}/${kind}`, { method: "POST", headers: auth, body: JSON.stringify(body) }), "meshy create");
    const id = String(created.result ?? created.id ?? "");
    if (!id) throw new Error(`meshy create: no task id in ${JSON.stringify(created).slice(0, 200)}`);
    for (;;) {
      if (Date.now() > deadline) throw new Error(`meshy task ${id}: timed out`);
      const t = await json(await f(`${base}/${kind}/${id}`, { headers: auth }), "meshy poll");
      const status = String(t.status ?? "");
      if (status === "SUCCEEDED") { glbUrl = String((t.model_urls as Record<string, unknown> | undefined)?.glb ?? ""); break; }
      if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") throw new Error(`meshy task ${id}: ${status} ${JSON.stringify(t.task_error ?? "").slice(0, 200)}`);
      o.onProgress?.(`meshy ${status.toLowerCase() || "pending"} ${t.progress ?? 0}%`);
      await sleep(poll);
    }
  } else {
    model = o.model || "fal-ai/hunyuan3d/v2";
    const auth = { authorization: `Key ${o.key}`, "content-type": "application/json" };
    const input = model.includes("trellis") ? { image_url: uris[0] } : { input_image_url: uris[0], textured_mesh: true };
    const q = await json(await f(`https://queue.fal.run/${model}`, { method: "POST", headers: auth, body: JSON.stringify(input) }), "fal submit");
    const statusUrl = String(q.status_url ?? ""), responseUrl = String(q.response_url ?? "");
    if (!statusUrl || !responseUrl) throw new Error(`fal submit: missing status/response url in ${JSON.stringify(q).slice(0, 200)}`);
    for (;;) {
      if (Date.now() > deadline) throw new Error(`fal ${model}: timed out`);
      const s = await json(await f(statusUrl, { headers: auth }), "fal status");
      const status = String(s.status ?? "");
      if (status === "COMPLETED") break;
      if (status === "FAILED" || s.error) throw new Error(`fal ${model}: ${JSON.stringify(s.error ?? s).slice(0, 200)}`);
      o.onProgress?.(`fal ${status.toLowerCase() || "queued"}`);
      await sleep(poll);
    }
    const r = await json(await f(responseUrl, { headers: auth }), "fal result");
    const mesh = (r.model_mesh ?? r.model_glb ?? r.glb) as Record<string, unknown> | string | undefined;
    glbUrl = typeof mesh === "string" ? mesh : String(mesh?.url ?? "");
  }
  if (!/^https:\/\//.test(glbUrl)) throw new Error(`${model}: finished but returned no https GLB url`);
  const dl = await f(glbUrl);
  if (!dl.ok) throw new Error(`download GLB: HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length < 12 || buf.subarray(0, 4).toString("latin1") !== "glTF") throw new Error("download GLB: the file is not a binary glTF");
  const abs = await o.resolvePath(o.cwd, o.out);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return { glb: o.out, provider: o.provider, model, seconds: Math.round((Date.now() - t0) / 1000) };
}
