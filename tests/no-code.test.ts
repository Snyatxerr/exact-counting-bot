import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../src/math.ts";
test("permitted CAS paths work with dynamic code execution disabled", () => {
  const fn = globalThis.Function,
    ev = globalThis.eval;
  try {
    globalThis.Function = new Proxy(fn, {
      apply() {
        throw Error("dynamic Function forbidden");
      },
      construct() {
        throw Error("dynamic Function forbidden");
      },
    });
    globalThis.eval = () => {
      throw Error("eval forbidden");
    };
    for (const s of [
      "sin(pi/4)*sqrt(2)",
      "sin(pi/12)*(sqrt(6)+sqrt(2))",
      "sin(1)^2+cos(1)^2",
      "integrate(sin(x),x,0,pi)-1",
    ])
      assert.equal(judge(s, 1n).kind, "EXACT_MATCH", s);
  } finally {
    globalThis.Function = fn;
    globalThis.eval = ev;
  }
});
