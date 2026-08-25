// The plugin kernel's two load-bearing properties, proven:
//
//   TEMPORAL — everything a plugin registers disappears with it, torn down in
//   reverse registration order. Unmount is the inverse of mount.
//   SPATIAL — a plugin activates only when its injected services exist and
//   deactivates BEFORE they vanish; the running state depends only on WHICH
//   plugins are mounted, never on arrival order (path independence).
//
// These are what make hot-swapping capabilities into a live daemon safe, and
// they are exactly the guarantees Ares's bespoke registries never had.

import test from "node:test";
import assert from "node:assert/strict";

import { PluginHost, definePlugin, HOST_EVENTS } from "../packages/plugins/dist/index.js";

test("temporal: cleanups run in reverse registration order on unmount", async () => {
  const host = new PluginHost();
  const trail = [];
  await host.mount(definePlugin({
    name: "ordered",
    setup(ctx) {
      ctx.effect(() => trail.push("first-registered"));
      ctx.effect(() => trail.push("second-registered"));
      ctx.effect(() => trail.push("third-registered"));
    },
  }));
  assert.equal(await host.unmount("ordered"), true);
  assert.deepEqual(trail, ["third-registered", "second-registered", "first-registered"]);
});

test("temporal: a throwing setup rolls back its partial registrations", async () => {
  const host = new PluginHost();
  const trail = [];
  const status = await host.mount(definePlugin({
    name: "half-built",
    setup(ctx) {
      ctx.effect(() => trail.push("undo-a"));
      ctx.provide("half-service", 42);
      ctx.effect(() => trail.push("undo-b"));
      throw new Error("setup exploded");
    },
  }));
  assert.equal(status.state, "failed");
  assert.match(status.error, /setup exploded/);
  assert.deepEqual(trail, ["undo-b", "undo-a"], "partial effects unwound in reverse");
  assert.equal(host.service("half-service"), undefined, "the half-provided service is gone");
});

test("spatial: a plugin waits for its dependency, then activates the moment it appears", async () => {
  const host = new PluginHost();
  const consumer = definePlugin({
    name: "consumer",
    inject: ["greeter"],
    setup(ctx) {
      ctx.provide("greeting", `${ctx.service("greeter")} world`);
    },
  });
  const parked = await host.mount(consumer);
  assert.equal(parked.state, "pending");
  assert.deepEqual(parked.waitingOn, ["greeter"]);

  await host.mount(definePlugin({
    name: "provider",
    setup(ctx) {
      ctx.provide("greeter", "hello");
    },
  }));
  assert.equal(host.statusOf("consumer").state, "active");
  assert.equal(host.service("greeting"), "hello world");
});

test("spatial: unmounting a provider deactivates dependents FIRST, and they return when it does", async () => {
  const host = new PluginHost();
  const trail = [];
  await host.mount(definePlugin({
    name: "consumer",
    inject: ["db"],
    setup(ctx) {
      ctx.effect(() => trail.push("consumer-down"));
      ctx.provide("repo", "repo-over-" + ctx.service("db"));
    },
  }));
  const provider = definePlugin({
    name: "provider",
    setup(ctx) {
      ctx.effect(() => trail.push("provider-down"));
      ctx.provide("db", "sqlite");
    },
  });
  await host.mount(provider);
  assert.equal(host.service("repo"), "repo-over-sqlite");

  await host.unmount("provider");
  assert.deepEqual(trail, ["consumer-down", "provider-down"], "dependent unwound before its provider");
  assert.equal(host.statusOf("consumer").state, "pending", "dependent parks, not fails");
  assert.equal(host.service("repo"), undefined);

  await host.mount(provider);
  assert.equal(host.statusOf("consumer").state, "active", "dependent reactivated on its own");
  assert.equal(host.service("repo"), "repo-over-sqlite");
});

test("path independence: any mount order converges to the same running state", async () => {
  const a = definePlugin({ name: "a", setup: (ctx) => ctx.provide("s-a", 1) });
  const b = definePlugin({ name: "b", inject: ["s-a"], setup: (ctx) => ctx.provide("s-b", ctx.service("s-a") + 1) });
  const c = definePlugin({ name: "c", inject: ["s-b"], setup: (ctx) => ctx.provide("s-c", ctx.service("s-b") + 1) });
  for (const order of [[a, b, c], [c, b, a], [b, c, a], [c, a, b]]) {
    const host = new PluginHost();
    for (const plugin of order) await host.mount(plugin);
    assert.equal(host.service("s-c"), 3, `order ${order.map((p) => p.name).join(",")} converges`);
    assert.deepEqual(host.status().map((s) => s.state), ["active", "active", "active"]);
    await host.dispose();
  }
});

test("two live providers of one service is a setup error, not a silent shadow", async () => {
  const host = new PluginHost();
  await host.mount(definePlugin({ name: "first", setup: (ctx) => ctx.provide("clock", "real") }));
  const second = await host.mount(definePlugin({ name: "second", setup: (ctx) => ctx.provide("clock", "fake") }));
  assert.equal(second.state, "failed");
  assert.match(second.error, /already provided by first/);
  assert.equal(host.service("clock"), "real", "the incumbent survives untouched");
});

test("swap: hot reload replaces a plugin atomically, dependents ride through", async () => {
  const host = new PluginHost();
  await host.mount(definePlugin({
    name: "consumer",
    inject: ["version"],
    setup(ctx) {
      ctx.provide("report", `running ${ctx.service("version")}`);
    },
  }));
  const v1 = definePlugin({ name: "versioned", setup: (ctx) => ctx.provide("version", "v1") });
  const v2 = definePlugin({ name: "versioned", setup: (ctx) => ctx.provide("version", "v2") });
  await host.mount(v1);
  assert.equal(host.service("report"), "running v1");
  await host.swap(v2);
  assert.equal(host.service("report"), "running v2", "dependent rebuilt against the new provider");
});

test("event subscriptions die with their plugin", async () => {
  const host = new PluginHost();
  const seen = [];
  await host.mount(definePlugin({
    name: "listener",
    setup(ctx) {
      ctx.on("ping", (payload) => seen.push(payload));
    },
  }));
  host.emit("ping", 1);
  await host.unmount("listener");
  host.emit("ping", 2);
  assert.deepEqual(seen, [1], "no delivery after unmount");
});

test("lifecycle events narrate activation, failure, and deactivation", async () => {
  const host = new PluginHost();
  const lifecycle = [];
  await host.mount(definePlugin({
    name: "observer",
    setup(ctx) {
      ctx.on(HOST_EVENTS.activated, (e) => lifecycle.push(`up:${e.name}`));
      ctx.on(HOST_EVENTS.deactivated, (e) => lifecycle.push(`down:${e.name}`));
      ctx.on(HOST_EVENTS.failed, (e) => lifecycle.push(`failed:${e.name}`));
    },
  }));
  await host.mount(definePlugin({ name: "ok", setup: () => {} }));
  await host.mount(definePlugin({ name: "broken", setup: () => { throw new Error("no"); } }));
  await host.unmount("ok");
  // The observer's own listener is live by the time ITS activation event
  // fires (setup completes first), so it narrates itself coming up too.
  assert.deepEqual(lifecycle, ["up:observer", "up:ok", "failed:broken", "down:ok"]);
});

test("dispose tears everything down newest-first and seals the host", async () => {
  const host = new PluginHost();
  const trail = [];
  await host.mount(definePlugin({ name: "base", setup: (ctx) => { ctx.provide("s", 1); ctx.effect(() => trail.push("base-down")); } }));
  await host.mount(definePlugin({ name: "top", inject: ["s"], setup: (ctx) => ctx.effect(() => trail.push("top-down")) }));
  await host.dispose();
  assert.deepEqual(trail, ["top-down", "base-down"]);
  await assert.rejects(() => host.mount(definePlugin({ name: "late", setup: () => {} })), /disposed/);
});

test("async setups serialize — a mount arriving mid-setup observes the settled world", async () => {
  const host = new PluginHost();
  const order = [];
  const slow = host.mount(definePlugin({
    name: "slow",
    async setup(ctx) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow-done");
      ctx.provide("slow-service", true);
    },
  }));
  const fast = host.mount(definePlugin({
    name: "fast",
    inject: ["slow-service"],
    setup() {
      order.push("fast-done");
    },
  }));
  const [, fastStatus] = await Promise.all([slow, fast]);
  assert.deepEqual(order, ["slow-done", "fast-done"], "second mount waited for the first");
  assert.equal(fastStatus.state, "active");
});
