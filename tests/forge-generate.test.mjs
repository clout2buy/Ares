// Image -> 3D: the provider flows (create, poll, download, save) against a fake HTTP layer.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateModel } from "../packages/cli/dist/entry/forgeGenerate.js";
import { projectPath } from "../packages/cli/dist/entry/modelStudio.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(20)]);
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets", "ref"), { recursive: true });
  for (const v of ["front", "side", "back"]) await writeFile(path.join(root, "assets", "ref", `${v}.png`), PNG);
  return root;
}

test("meshy: multi-view turnaround -> polls until SUCCEEDED -> saves the GLB inside the project", async (t) => {
  const root = await project(t);
  const calls = []; let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? "GET", String(url)]);
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.image_urls.length, 3, "all three views are sent");
      assert.match(body.image_urls[0], /^data:image\/png;base64,/);
      assert.equal(init.headers.authorization, "Bearer k-meshy");
      return res({ result: "task-1" });
    }
    if (String(url).endsWith("/task-1")) return res(++polls < 3 ? { status: "IN_PROGRESS", progress: polls * 30 } : { status: "SUCCEEDED", model_urls: { glb: "https://assets.meshy.ai/t/model.glb" } });
    if (String(url) === "https://assets.meshy.ai/t/model.glb") return new Response(GLB);
    return res("nope", 404);
  };
  const progress = [];
  const g = await generateModel({ images: ["assets/ref/front.png", "assets/ref/side.png", "assets/ref/back.png"], provider: "meshy", key: "k-meshy", cwd: root, out: "assets/models/bot.glb", fetchImpl, pollMs: 1, resolvePath: projectPath, onProgress: (m) => progress.push(m) });
  assert.equal(g.glb, "assets/models/bot.glb");
  assert.equal(g.model, "meshy multi-image-to-3d");
  assert.deepEqual(calls[0], ["POST", "https://api.meshy.ai/openapi/v1/multi-image-to-3d"]);
  assert.ok(progress.some((m) => /in_progress 30%/.test(m)));
  assert.ok((await readFile(path.join(root, "assets/models/bot.glb"))).equals(GLB));
});

test("fal: Hunyuan3D queue flow; failures and bad outputs come back as clear errors", async (t) => {
  const root = await project(t);
  let st = 0;
  const ok = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST") { assert.equal(u, "https://queue.fal.run/fal-ai/hunyuan3d/v2"); assert.equal(init.headers.authorization, "Key k-fal"); assert.ok(JSON.parse(init.body).input_image_url.startsWith("data:image/png")); return res({ status_url: "https://queue.fal.run/x/status", response_url: "https://queue.fal.run/x" }); }
    if (u.endsWith("/status")) return res({ status: ++st < 2 ? "IN_QUEUE" : "COMPLETED" });
    if (u === "https://queue.fal.run/x") return res({ model_mesh: { url: "https://fal.media/m.glb" } });
    if (u === "https://fal.media/m.glb") return new Response(GLB);
    return res("nope", 404);
  };
  const g = await generateModel({ images: ["assets/ref/front.png"], provider: "fal", key: "k-fal", cwd: root, out: "assets/models/a.glb", fetchImpl: ok, pollMs: 1, resolvePath: projectPath });
  assert.equal(g.model, "fal-ai/hunyuan3d/v2");
  const base = { images: ["assets/ref/front.png"], provider: "meshy", key: "k", cwd: root, pollMs: 1, resolvePath: projectPath };
  await assert.rejects(() => generateModel({ ...base, out: "assets/models/b.glb", fetchImpl: async () => res({ message: "Unauthorized" }, 401) }), /meshy create: HTTP 401/);
  await assert.rejects(() => generateModel({ ...base, out: "assets/models/b.glb", fetchImpl: async (u, i = {}) => (i.method === "POST" ? res({ result: "t" }) : res({ status: "FAILED", task_error: { message: "bad image" } })) }), /FAILED.*bad image/);
  await assert.rejects(() => generateModel({ ...base, out: "assets/models/b.glb", fetchImpl: async (u, i = {}) => (i.method === "POST" ? res({ result: "t" }) : String(u).endsWith("/t") ? res({ status: "SUCCEEDED", model_urls: { glb: "https://x/m.glb" } }) : new Response("<html>")) }), /not a binary glTF/);
  await assert.rejects(() => generateModel({ ...base, images: ["../../etc/passwd.png"], out: "assets/models/b.glb", fetchImpl: ok }), /escapes the project/);
  await assert.rejects(() => generateModel({ ...base, out: "assets/models/b.obj", fetchImpl: ok }), /must end in \.glb/);
});
