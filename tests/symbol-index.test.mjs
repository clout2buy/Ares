// Symbol index — multi-language regex extractors, incremental cache, ranking.
//
// Temp workspace with TS/Python/Rust/Go/C samples; rebuilds after one file
// changes must re-extract exactly that file; the fuzzy tiers must order
// exact > prefix > camel-fuzzy > substring.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  buildSymbolIndex,
  querySymbols,
  workspaceSymbolsFor,
  extractSymbols,
  rankName,
  resetSymbolIndexMemo,
  symbolIndexCachePath,
} from "../packages/core/dist/index.js";

async function makeWorkspace() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "ares-symidx-"));
  await fs.mkdir(path.join(ws, "src"), { recursive: true });
  await fs.mkdir(path.join(ws, "node_modules", "junk"), { recursive: true });
  await fs.writeFile(
    path.join(ws, "src", "auth.ts"),
    [
      'import x from "y";',
      "export function authenticate(user: string) {",
      "  return user.length > 0;",
      "}",
      "export class AuthService {",
      "  constructor(private readonly db: Db) {}",
      "  async login(name: string): Promise<boolean> {",
      "    return authenticate(name);",
      "  }",
      "}",
      "export interface Db { query(q: string): void; }",
      "export type Token = string;",
      "const getUserData = async (id: string) => id;",
      "function argued() {}",
      "export { getUserData, argued };",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(ws, "src", "model.py"),
    ["def top_level(a, b):", "    return a + b", "", "class Widget:", "    def __init__(self):", "        pass", "", "    async def render(self):", "        return 1", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(ws, "src", "lib.rs"),
    ["pub struct Point { x: i32 }", "pub trait Draw { fn draw(&self); }", "impl Draw for Point {", "    fn draw(&self) {}", "}", "fn main() {}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(ws, "src", "server.go"),
    ["package main", "", "type Server struct {", "\tport int", "}", "", "func (s *Server) Start() error {", "\treturn nil", "}", "", "func NewServer() *Server { return nil }", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(ws, "src", "util.c"),
    ["#include <stdio.h>", "static int helper(int a);", "struct Point {", "  int x;", "};", "static int helper(int a) {", "  return a;", "}", "int main(int argc, char **argv)", "{", "  return helper(argc);", "}", ""].join("\n"),
  );
  await fs.writeFile(path.join(ws, "node_modules", "junk", "ignored.ts"), "export function shouldNotIndex() {}\n");
  return ws;
}

test("symbol index: extracts across TS, Python, Rust, Go, C and skips ignored dirs", async () => {
  const ws = await makeWorkspace();
  const index = await buildSymbolIndex(ws);
  const all = Object.values(index.files).flatMap((f) => f.symbols);
  const byName = (n) => all.find((s) => s.name === n);

  assert.equal(index.stats.mode, "walk");
  assert.equal(index.stats.files, 5);
  assert.ok(!byName("shouldNotIndex"), "node_modules must be skipped");

  const authenticate = byName("authenticate");
  assert.equal(authenticate.kind, "function");
  assert.equal(authenticate.exported, true);
  assert.equal(authenticate.line, 2);
  assert.equal(authenticate.endLine, 4);
  assert.equal(authenticate.file, "src/auth.ts");
  const login = byName("login");
  assert.equal(login.kind, "method");
  assert.equal(login.container, "AuthService");
  assert.equal(byName("Db").kind, "interface");
  assert.equal(byName("Token").kind, "type");
  assert.equal(byName("getUserData").kind, "function");
  assert.equal(byName("getUserData").exported, true, "export { name } marks the earlier const exported");

  const render = byName("render");
  assert.equal(render.kind, "method");
  assert.equal(render.container, "Widget");
  assert.equal(byName("top_level").kind, "function");
  assert.equal(byName("Widget").endLine, 9);

  assert.equal(byName("Point").kind, "struct");
  assert.equal(byName("Draw").kind, "trait");
  const draw = byName("draw");
  assert.equal(draw.kind, "method");
  assert.equal(draw.container, "Draw for Point");

  const start = byName("Start");
  assert.equal(start.kind, "method");
  assert.equal(start.container, "Server");
  assert.equal(start.exported, true);
  assert.equal(byName("NewServer").kind, "function");

  const helper = all.filter((s) => s.name === "helper" && s.file === "src/util.c");
  assert.equal(helper.length, 1, "prototype must not be indexed, only the definition");
  assert.equal(helper[0].line, 6);
  const main = all.find((s) => s.name === "main" && s.file === "src/util.c");
  assert.equal(main.line, 9);
  assert.equal(main.endLine, 12, "brace on the next line still brackets the body");

  const cache = JSON.parse(await fs.readFile(symbolIndexCachePath(ws), "utf8"));
  assert.equal(Object.keys(cache.files).length, 5);
});

test("symbol index: incremental rebuild re-extracts only the changed file", async () => {
  const ws = await makeWorkspace();
  const first = await buildSymbolIndex(ws);
  assert.equal(first.stats.extracted, 5);

  const second = await buildSymbolIndex(ws);
  assert.equal(second.stats.extracted, 0);
  assert.equal(second.stats.reused, 5);

  const py = path.join(ws, "src", "model.py");
  await fs.writeFile(py, (await fs.readFile(py, "utf8")) + "\ndef brand_new(x):\n    return x\n");
  // Force a distinct mtime even on coarse filesystems.
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(py, future, future);

  const third = await buildSymbolIndex(ws);
  assert.equal(third.stats.extracted, 1);
  assert.equal(third.stats.reused, 4);
  assert.ok(workspaceSymbolsFor(third, py).some((s) => s.name === "brand_new"));
  assert.ok(workspaceSymbolsFor(third, "src/model.py").some((s) => s.name === "brand_new"), "relative path accepted");

  await fs.rm(path.join(ws, "src", "util.c"));
  const fourth = await buildSymbolIndex(ws);
  assert.equal(fourth.stats.removed, 1);
  assert.ok(!Object.keys(fourth.files).includes("src/util.c"));
});

test("symbol index: ranking orders exact > prefix > camel-fuzzy > substring", async () => {
  const ws = await makeWorkspace();
  const index = await buildSymbolIndex(ws);

  const auth = querySymbols(index, "auth");
  assert.equal(auth[0].name, "AuthService" === auth[0].name ? "AuthService" : "authenticate");
  assert.ok(auth.slice(0, 2).every((s) => s.tier === "prefix"));

  const exact = querySymbols(index, "authenticate");
  assert.equal(exact[0].name, "authenticate");
  assert.equal(exact[0].tier, "exact");

  const gud = querySymbols(index, "gud");
  assert.equal(gud[0].name, "getUserData", "camel initials beat loose subsequence");
  assert.equal(gud[0].tier, "fuzzy");
  assert.ok(gud.some((s) => s.name === "argued" && s.tier === "subsequence"));

  assert.equal(rankName("authenticate", "authenticate").tier, "exact");
  assert.equal(rankName("authenticate", "auth").tier, "prefix");
  assert.equal(rankName("getUserData", "gud").tier, "fuzzy");
  assert.equal(rankName("authenticate", "ent").tier, "substring");
  assert.ok(rankName("authenticate", "authenticate").score > rankName("authenticate", "auth").score);
  assert.ok(rankName("getUserData", "gud").score > rankName("authenticate", "ent").score);
  assert.ok(rankName("authenticate", "auth").score > rankName("getUserData", "gud").score);
  assert.equal(rankName("parent", "zzz"), null);

  const onlyMethods = querySymbols(index, "a", { kind: "method" });
  assert.ok(onlyMethods.every((s) => s.kind === "method"));
  const onlyRust = querySymbols(index, "draw", { file: "src/lib.rs" });
  assert.ok(onlyRust.length >= 1 && onlyRust.every((s) => s.file === "src/lib.rs"));
});

test("symbol index: extractSymbols handles Java/C#/Kotlin/Ruby/PHP/shell", () => {
  const java = extractSymbols("A.java", "public class Account {\n  public int getBalance() {\n    return 1;\n  }\n}\n");
  assert.deepEqual(java.map((s) => [s.name, s.kind]), [["Account", "class"], ["getBalance", "method"]]);
  const cs = extractSymbols("S.cs", "namespace App {\n  public class Service {\n    public async Task<int> RunAsync() {\n      return 1;\n    }\n  }\n}\n");
  assert.ok(cs.some((s) => s.name === "RunAsync" && s.kind === "method" && s.container === "Service"));
  const kt = extractSymbols("R.kt", "class Repo {\n  fun find(id: Int): User? {\n    return null\n  }\n}\nfun top() {}\n");
  assert.ok(kt.some((s) => s.name === "find" && s.kind === "method"));
  assert.ok(kt.some((s) => s.name === "top" && s.kind === "function"));
  const rb = extractSymbols("b.rb", "module Billing\n  class Invoice\n    def total\n      1\n    end\n  end\nend\n");
  assert.deepEqual(rb.map((s) => [s.name, s.kind, s.container]), [["Billing", "module", undefined], ["Invoice", "class", "Billing"], ["total", "method", "Invoice"]]);
  const php = extractSymbols("c.php", "<?php\nclass Cart {\n  public function add($i) { return 1; }\n}\nfunction cart_total($c) { return 0; }\n");
  assert.ok(php.some((s) => s.name === "add" && s.kind === "method"));
  assert.ok(php.some((s) => s.name === "cart_total" && s.kind === "function"));
  const sh = extractSymbols("d.sh", "#!/bin/bash\nbuild() {\n  echo hi\n}\nfunction deploy {\n  echo x\n}\n");
  assert.deepEqual(sh.map((s) => s.name), ["build", "deploy"]);
});

test("symbol index: git fast path touches only dirty files when HEAD matches", async (t) => {
  const gitOk = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
  if (!gitOk) {
    t.skip("git not on PATH");
    return;
  }
  const ws = await makeWorkspace();
  const git = (...args) => spawnSync("git", args, { cwd: ws, windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");

  resetSymbolIndexMemo(ws);
  const first = await buildSymbolIndex(ws);
  assert.ok(first.head, "HEAD sha read without spawning git");
  assert.equal(first.stats.mode, "walk");

  const second = await buildSymbolIndex(ws);
  assert.equal(second.stats.mode, "git-status");
  assert.equal(second.stats.extracted, 0);

  const go = path.join(ws, "src", "server.go");
  await fs.writeFile(go, (await fs.readFile(go, "utf8")) + "\nfunc Extra() {}\n");
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(go, future, future);
  const third = await buildSymbolIndex(ws);
  assert.equal(third.stats.mode, "git-status");
  assert.equal(third.stats.extracted, 1);
  assert.ok(querySymbols(third, "Extra").some((s) => s.name === "Extra"));
});
