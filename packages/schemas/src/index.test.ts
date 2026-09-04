import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSchema, extractJson, toProviderSchema, SCHEMAS, SCHEMA_NAMES } from "./index";

test("all schemas compile and every schema has schema_version", () => {
  for (const name of SCHEMA_NAMES) {
    const s = SCHEMAS[name] as any;
    assert.equal(s.properties.schema_version.const, "1.0", name);
    const r = validateSchema(name, {});
    assert.equal(r.ok, false);
  }
});

test("case_verdict: fail requires repro_steps", () => {
  const base = { schema_version: "1.0", verdict: "fail", reasoning: "x", evidence_refs: [], repro_steps: [], possibly_changed: false };
  assert.equal(validateSchema("case_verdict", base).ok, false);
  assert.equal(validateSchema("case_verdict", { ...base, repro_steps: ["a"] }).ok, true);
  assert.equal(validateSchema("case_verdict", { ...base, verdict: "pass" }).ok, true);
});

test("discussion_turn: max 3 questions, completeness enum", () => {
  const t = {
    schema_version: "1.0", message: "hi",
    questions: [{ item: "a", question: "?" }],
    draft_patch: { mode: "none", content: "" },
    completeness: { goal: "clear", roles: "partial" },
    target_proposals: [],
  };
  assert.equal(validateSchema("discussion_turn", t).ok, true);
  assert.equal(validateSchema("discussion_turn", { ...t, completeness: { goal: "done" } }).ok, false);
  assert.equal(validateSchema("discussion_turn", { ...t, questions: [1, 2, 3, 4].map(() => ({ item: "a", question: "b" })) }).ok, false);
});

test("extractJson handles fences and prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":[1,2]} hope that helps'), { a: [1, 2] });
  assert.throws(() => extractJson("no json here"));
});

test("toProviderSchema strips conditionals and meta", () => {
  const p = toProviderSchema(SCHEMAS.case_verdict as any) as any;
  assert.equal(p.if, undefined);
  assert.equal(p.$schema, undefined);
  assert.ok(p.properties.verdict);
});
