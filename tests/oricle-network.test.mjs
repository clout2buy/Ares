// The Ares network seam: Ares as a client of a hosted Oricle estate.
//
//  1. connect to a live `oricle serve` with NO local estate → the estate is
//     cloned into ARES_ORICLE_DIR, the status says connected, records match;
//  2. a write through the Estate tool reaches the server after "Sync now";
//  3. a record another machine pushed to the server arrives here on the next
//     sync and is visible through the same mount (absorbed, no remount);
//  4. a wrong token fails loudly with a status that still says not connected;
//  5. disconnect stops the loop and the status flips.
//
// Skips when the Oricle library is not installed (D:/Oricle/dist).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORICLE_LIB = process.env.ARES_ORICLE_LIB ?? "D:/Oricle/dist/index.js";
let libAvailable = true;
try {
  await access(ORICLE_LIB);
} catch {
  libAvailable = false;
}

const adapter = await import(pathToFileURL(path.join(root, "packages", "cli", "dist", "entry", "oricleAdapter.js")).href);

let tick = Date.parse("2026-09-13T15:00:00.000Z");
const clock = () => new Date((tick += 1000)).toISOString();

test("ares network: connect clones, writes push, others' records arrive, disconnect stops", { skip: !libAvailable && `no Oricle library at ${ORICLE_LIB}` }, async () => {
  const { Oricle, initEstate, serveHttp, readAll } = await import(pathToFileURL(path.resolve(ORICLE_LIB)).href);
  const scratch = await mkdtemp(path.join(tmpdir(), "ares-net-"));
  const prevDir = process.env.ARES_ORICLE_DIR;
  const prevHome = process.env.ORICLE_HOME;
  const prevLib = process.env.ARES_ORICLE_LIB;
  process.env.ORICLE_HOME = path.join(scratch, "oricle-home");
  process.env.ARES_ORICLE_LIB = ORICLE_LIB;
  // the hosted estate, with one record from "the laptop"
  const serverDir = path.join(scratch, "server-estate");
  await initEstate(serverDir, { name: "Net test estate", ownerName: "Owner", now: clock() });
  const lap = await Oricle.mount(serverDir, { principal: "owner", agent: "ares", machineId: "laptop", now: clock });
  await lap.commit({ kind: "fact", text: "The laptop knew this first.", tier: "stated" });
  await lap.close();
  const token = "ork_test_token_for_ares_network_0001";
  const server = await serveHttp({ dir: serverDir, token, port: 0, now: clock });
  const localDir = path.join(scratch, "local-estate");
  process.env.ARES_ORICLE_DIR = localDir;
  try {
    // 4. wrong token → loud failure, not connected
    await assert.rejects(adapter.aresNetworkConnect({ url: server.url, token: "nope-nope-nope", persist: false }), /401|token/);
    let st = await adapter.aresNetworkStatus();
    assert.equal(st.connected, false);

    // 1. connect → clone
    st = await adapter.aresNetworkConnect({ url: server.url, token, persist: false });
    assert.equal(st.connected, true, JSON.stringify(st));
    assert.equal(st.estateName, "Net test estate");
    assert.equal(st.totalPulled, 1, "the laptop's record was cloned");
    assert.equal((await readAll(localDir)).records.length, 1);

    // 2. a local write reaches the server on sync
    const tool = adapter.makeEstateTool(() => "test-model");
    const ctx = { workspace: root, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map() };
    const committed = await tool.call({ action: "commit", kind: "fact", text: "The desktop learned this today." }, ctx);
    assert.equal(committed.output.kind, "fact");
    st = await adapter.aresNetworkSyncNow();
    assert.ok(st.totalPushed >= 1, `pushed: ${JSON.stringify(st)}`);
    assert.ok((await readAll(serverDir)).records.some((r) => r.text.includes("desktop learned")), "server holds the desktop's record");

    // 3. another machine pushes; the next sync absorbs it into the live mount
    const lap2 = await Oricle.mount(serverDir, { principal: "owner", agent: "ares", machineId: "laptop", now: clock });
    await lap2.commit({ kind: "decision", text: "Laptop decided something new.", tier: "stated" });
    await lap2.close();
    // the server's read mount must see it too — it reads the folder the laptop wrote directly, so refresh via a sync round-trip
    st = await adapter.aresNetworkSyncNow();
    const recalled = await tool.call({ action: "recall", query: "laptop decided" }, ctx);
    assert.ok(recalled.output.some((r) => r.text.includes("Laptop decided")), `absorbed into the live mount: ${JSON.stringify(recalled.output)}`);

    // 5. disconnect
    st = await adapter.aresNetworkDisconnect({ persist: false });
    assert.equal(st.connected, false);
    assert.equal(st.enabled, false);
  } finally {
    await adapter.aresNetworkDisconnect({ persist: false }).catch(() => {});
    await adapter.closeOricle().catch(() => {});
    await server.close();
    if (prevDir === undefined) delete process.env.ARES_ORICLE_DIR;
    else process.env.ARES_ORICLE_DIR = prevDir;
    if (prevHome === undefined) delete process.env.ORICLE_HOME;
    else process.env.ORICLE_HOME = prevHome;
    if (prevLib === undefined) delete process.env.ARES_ORICLE_LIB;
    else process.env.ARES_ORICLE_LIB = prevLib;
    await rm(scratch, { recursive: true, force: true });
  }
});
