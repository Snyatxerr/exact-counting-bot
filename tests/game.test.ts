import { test } from "node:test";
import assert from "node:assert/strict";
import { initial, transition, control } from "../src/game.ts";
const match = { kind: "EXACT_MATCH" as const },
  mismatch = { kind: "EXACT_MISMATCH" as const };
test("alternation, scores, best and resets", () => {
  let s = initial(),
    scores: Record<string, number> = {};
  for (const u of ["A", "B", "A"]) {
    const r = transition(s, u, match);
    s = r.state;
    if (r.result === "success") scores[u] = (scores[u] ?? 0) + 1;
  }
  assert.deepEqual(scores, { A: 2, B: 1 });
  assert.equal(s.current, "3");
  s = transition(s, "A", match).state;
  assert.equal(s.current, "0");
  assert.equal(s.last, null);
  assert.equal(s.best, "3");
  assert.equal(transition(s, "A", match).state.current, "1");
});
test("invalid and UNKNOWN preserve last user and state version", () => {
  const s = transition(initial(), "A", match).state;
  for (const kind of ["INVALID", "UNKNOWN"] as const) {
    assert.deepEqual(transition(s, "B", { kind }).state, s);
    assert.equal(
      transition(transition(s, "B", { kind }).state, "A", match).result,
      "failure",
    );
  }
});
test("wrong 1 is not applied to new run", () => {
  const s = transition(initial(), "A", match).state;
  const r = transition(s, "B", mismatch);
  assert.equal(r.state.current, "0");
  assert.equal(r.state.run, 2);
});
test("administrative controls preserve statistics and progress", () => {
  let s = transition(initial(), "A", match).state;
  for (const command of ["set", "stop", "set"])
    s = control(s, command, "2", "100");
  assert.equal(s.current, "1");
  assert.equal(s.last, "A");
  assert.equal(s.channel, "2");
  s = control(s, "stop", "2", "101");
  s = control(s, "reset", "2", "102");
  assert.equal(s.current, "0");
  assert.equal(s.best, "1");
  assert.equal(s.enabled, false);
});
