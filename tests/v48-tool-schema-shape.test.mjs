// Every tool the model can see must serialize to a JSON Schema whose top level
// is `type: "object"`. Anthropic and OpenAI reject anything else with a 400 on
// the WHOLE request — one bad tool bricks every turn. RemotePC shipped as a
// zod discriminatedUnion (→ anyOf, no top-level type) and did exactly that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TOOLS, RemotePCTool } from "../packages/tools/dist/index.js";

function inputSchemaOf(tool) {
  return tool.schema.inputJsonSchema;
}

test("every default tool has a top-level object input schema", () => {
  const offenders = DEFAULT_TOOLS
    .filter((tool) => inputSchemaOf(tool)?.type !== "object")
    .map((tool) => `${tool.schema.name} (type=${String(inputSchemaOf(tool)?.type)})`);
  assert.deepEqual(offenders, []);
});

test("RemotePC validates per-action requirements without a union schema", async () => {
  const schema = inputSchemaOf(RemotePCTool);
  assert.equal(schema.type, "object");
  assert.ok(!("anyOf" in schema) && !("oneOf" in schema), "no top-level union");
  const ok = RemotePCTool.validateInput?.({ action: "generate_link", label: "Dave" }) ?? { ok: true };
  assert.notEqual(ok.ok, false);
  const missing = RemotePCTool.validateInput?.({ action: "exec_on_pc", pc_id: "x" });
  if (missing) assert.equal(missing.ok, false, "exec_on_pc without command must be rejected");
});
