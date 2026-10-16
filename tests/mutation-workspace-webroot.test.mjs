// A static web project (index.html + assets, no package manager) is a
// project. Field case (runestone, 2026-10-15): writing assets/leaf-1.svg into
// D:\game\ — approved, outside the Ares workspace — picked the not-yet-existing
// assets\ folder as the mutation root, so Write was refused ("workspace does
// not exist"), and once the folder existed the recovery journal landed at
// assets\.ares\ inside the owner's project.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { mutationWorkspaceForPaths } from "../packages/tools/dist/index.js";

const norm = (p) => path.resolve(p).toLowerCase();

test("a folder with index.html is the project root, even for a file in a folder that does not exist yet", async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), "ares-webroot-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-ws-"));
  t.after(() => Promise.all([rm(outside, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]));
  const project = path.join(outside, "game");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "index.html"), "<!doctype html>");

  const root = await mutationWorkspaceForPaths(workspace, [path.join(project, "assets", "leaf-1.svg")]);
  assert.equal(norm(root), norm(project), "assets/ does not exist yet and must not become the journal root");

  await mkdir(path.join(project, "assets"), { recursive: true });
  const again = await mutationWorkspaceForPaths(workspace, [path.join(project, "assets", "leaf-2.svg")]);
  assert.equal(norm(again), norm(project), "an existing assets/ folder is still not a project of its own");
});

test("with no marker at all, the root climbs to the nearest directory that exists", async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), "ares-nomarker-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-ws-"));
  t.after(() => Promise.all([rm(outside, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]));
  const scratch = path.join(outside, "scratch");
  await mkdir(scratch, { recursive: true });

  const root = await mutationWorkspaceForPaths(workspace, [path.join(scratch, "deep", "er", "file.txt")]);
  assert.equal(norm(root), norm(scratch), "a missing deep/er/ chain resolves to the existing parent");
});
