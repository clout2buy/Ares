// LSP — workspace_symbol / document_symbol over the regex symbol index.
//
// The TypeScript server is optional: when typescript-language-server is on
// PATH the TS file may come back via that engine, but Python/Rust results must
// always arrive from the symbol index, and existing nav actions stay intact.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LspTool } from "../packages/tools/dist/index.js";
import { resetSymbolIndexMemo } from "../packages/core/dist/index.js";

async function makeWorkspace() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lsp-sym-"));
  await fs.mkdir(path.join(ws, "src"), { recursive: true });
  await fs.writeFile(
    path.join(ws, "src", "auth.ts"),
    "export function authenticate(user: string) {\n  return user.length > 0;\n}\nexport class AuthService {\n  login(name: string) {\n    return authenticate(name);\n  }\n}\nconst x = authenticate('a');\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(ws, "src", "auth.py"),
    "class Authenticator:\n    def authenticate_user(self, name):\n        return True\n\ndef get_user_data(uid):\n    return {}\n",
    "utf8",
  );
  await fs.writeFile(path.join(ws, "src", "lib.rs"), "pub fn auth_token() -> u32 { 1 }\npub struct AuthCtx { id: u32 }\n", "utf8");
  await fs.writeFile(path.join(ws, "notes.txt"), "not code\n", "utf8");
  resetSymbolIndexMemo(ws);
  return ws;
}

function ctx(workspace) {
  return {
    workspace,
    sessionId: "sess_lsp_sym",
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

test("LSP workspace_symbol: prefix query finds declarations across languages", async () => {
  const ws = await makeWorkspace();
  const r = await LspTool.call({ action: "workspace_symbol", query: "auth", max_results: 25 }, ctx(ws));
  assert.equal(r.output.action, "workspace_symbol");
  assert.ok(["symbol-index", "typescript-language-server"].includes(r.output.engine));
  const names = r.output.symbols.map((s) => s.name);
  assert.ok(names.includes("authenticate"), `ts: ${names}`);
  assert.ok(names.includes("Authenticator"), `py class: ${names}`);
  assert.ok(names.includes("authenticate_user"), `py method: ${names}`);
  assert.ok(names.includes("auth_token"), `rs fn: ${names}`);
  assert.ok(names.includes("AuthCtx"), `rs struct: ${names}`);
  const py = r.output.symbols.find((s) => s.name === "authenticate_user");
  assert.equal(py.kind, "method");
  assert.equal(py.container, "Authenticator");
  assert.equal(py.line, 2);
  assert.ok(path.isAbsolute(py.path));
  assert.equal(r.output.locations.length, 0);
});

test("LSP workspace_symbol: camel/snake fuzzy + kind filter + max_results", async () => {
  const ws = await makeWorkspace();
  const fuzzy = await LspTool.call({ action: "workspace_symbol", query: "gud", max_results: 25 }, ctx(ws));
  assert.ok(fuzzy.output.symbols.some((s) => s.name === "get_user_data"), "snake-case initials");

  const only = await LspTool.call({ action: "workspace_symbol", query: "auth", kind: "struct", max_results: 25 }, ctx(ws));
  assert.deepEqual(only.output.symbols.map((s) => s.name), ["AuthCtx"]);

  const capped = await LspTool.call({ action: "workspace_symbol", query: "auth", max_results: 2 }, ctx(ws));
  assert.equal(capped.output.symbols.length, 2);

  const problem = await LspTool.validateInput?.({ action: "workspace_symbol", max_results: 25 });
  if (problem) assert.equal(problem.ok, false);
  await assert.rejects(() => LspTool.call({ action: "workspace_symbol", max_results: 25 }, ctx(ws)), /query/);
});

test("LSP document_symbol: outlines one file in line order via the symbol index", async () => {
  const ws = await makeWorkspace();
  const py = path.join(ws, "src", "auth.py");
  const r = await LspTool.call({ action: "document_symbol", file_path: py, max_results: 25 }, ctx(ws));
  assert.equal(r.output.engine, "symbol-index");
  assert.deepEqual(
    r.output.symbols.map((s) => [s.name, s.kind, s.line]),
    [["Authenticator", "class", 1], ["authenticate_user", "method", 2], ["get_user_data", "function", 5]],
  );
  assert.ok(r.output.symbols.every((s) => s.path === py));

  const rel = await LspTool.call({ action: "document_symbol", file_path: "src/lib.rs", max_results: 25 }, ctx(ws));
  assert.deepEqual(rel.output.symbols.map((s) => s.name), ["auth_token", "AuthCtx"]);

  await assert.rejects(() => LspTool.call({ action: "document_symbol", file_path: "notes.txt", max_results: 25 }, ctx(ws)), /no symbol extractor/);
  await assert.rejects(() => LspTool.call({ action: "document_symbol", max_results: 25 }, ctx(ws)), /file_path/);
});

test("LSP: existing nav actions still work with the widened schema", async () => {
  const ws = await makeWorkspace();
  const file = path.join(ws, "src", "auth.ts");
  const def = await LspTool.call({ action: "go_to_definition", file_path: file, line: 9, character: 12, max_results: 10 }, ctx(ws));
  assert.equal(def.output.symbol, "authenticate");
  assert.equal(def.output.locations[0].line, 1);
  await assert.rejects(() => LspTool.call({ action: "hover", file_path: file, max_results: 10 }, ctx(ws)), /line and character/);
});
