// Heap allocation sampler — the attribution the idle-climb artifacts lacked.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HeapAllocationSampler,
  heapSamplerEnabled,
  heapSamplerIntervalBytes,
  summarizeSamplingProfile,
} from "../packages/core/dist/heapSampler.js";

test("summarizeSamplingProfile aggregates self sizes per frame and ranks by bytes", () => {
  const frame = (fn, url, line) => ({ functionName: fn, url, lineNumber: line });
  const head = {
    callFrame: frame("(root)", "", -1),
    selfSize: 0,
    children: [
      { callFrame: frame("grow", "file:///D:/Ares/packages/core/dist/a.js", 9), selfSize: 5000, children: [
        { callFrame: frame("leaf", "file:///D:/Ares/packages/core/dist/b.js", 1), selfSize: 100 },
      ] },
      { callFrame: frame("grow", "file:///D:/Ares/packages/core/dist/a.js", 9), selfSize: 7000 },
      { callFrame: frame("", "node:internal/x", 3), selfSize: 300 },
    ],
  };
  const top = summarizeSamplingProfile(head, 10);
  assert.equal(top[0].function, "grow");
  assert.equal(top[0].selfBytes, 12000, "same frame via two callers is one row");
  assert.equal(top[0].url, "packages/core/dist/a.js");
  assert.equal(top[0].line, 10, "protocol lines are 0-based; artifact lines are 1-based");
  assert.equal(top[1].function, "(anonymous)");
  assert.equal(top[1].url, "node:internal/x");
  assert.equal(top.length, 3);
  assert.equal(summarizeSamplingProfile(head, 1).length, 1);
});

test("knobs: ARES_HEAP_PROFILE=0 disables; interval defaults to 256KB and rejects nonsense", () => {
  assert.equal(heapSamplerEnabled({}), true);
  assert.equal(heapSamplerEnabled({ ARES_HEAP_PROFILE: "0" }), false);
  assert.equal(heapSamplerIntervalBytes({}), 256 * 1024);
  assert.equal(heapSamplerIntervalBytes({ ARES_HEAP_PROFILE_INTERVAL_BYTES: "65536" }), 65536);
  assert.equal(heapSamplerIntervalBytes({ ARES_HEAP_PROFILE_INTERVAL_BYTES: "12" }), 256 * 1024);
});

test("a live sampler attributes real allocations to a frame without stopping", () => {
  const sampler = new HeapAllocationSampler();
  const started = sampler.start(16 * 1024);
  if (!started) {
    // A host already attached to a debugger owns the profiler; nothing to assert.
    assert.equal(sampler.active, false);
    return;
  }
  assert.equal(sampler.active, true);
  const keep = [];
  function allocateALot() {
    for (let i = 0; i < 4000; i++) keep.push(new Array(256).fill(i));
  }
  allocateALot();
  const top = sampler.topSites(50);
  assert.ok(top.length > 0, "profile has frames");
  assert.ok(top.some((site) => site.function === "allocateALot"), `expected allocateALot among ${top.slice(0, 5).map((s) => s.function).join(",")}`);
  assert.equal(sampler.active, true, "reading the profile does not stop sampling");
  sampler.stop();
  assert.equal(sampler.active, false);
  assert.deepEqual(sampler.topSites(), [], "stopped sampler reports nothing");
  assert.ok(keep.length > 0);
});
