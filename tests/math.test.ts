import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../src/math.ts";
// Independent expected values: elementary identities, power rule and fundamental theorem.
export const accepted: [string, string][] = [
  ["1", "1"],
  ["2/2", "1"],
  ["1/3*3", "1"],
  ["0.1+0.2+0.7", "1"],
  ["9007199254740993-9007199254740992", "1"],
  ["3*5", "15"],
  ["(3+5)*2", "16"],
  ["2^3", "8"],
  ["2^3^2", "512"],
  ["-2^2", "-4"],
  ["(-2)^2", "4"],
  ["4!", "24"],
  ["sin(pi/4)*sqrt(2)", "1"],
  ["sin(π/4)*√2", "1"],
  ["sin(pi/12)*(sqrt(6)+sqrt(2))", "1"],
  ["cos(pi/3)*2", "1"],
  ["tan(pi/4)", "1"],
  ["sin(1)^2+cos(1)^2", "1"],
  ["sqrt(2)^2", "2"],
  ["(sqrt(2)+1)*(sqrt(2)-1)", "1"],
  ["sqrt((-3)^2)", "3"],
  ["ln(e^3)", "3"],
  ["log(8,2)", "3"],
  ["exp(ln(2))", "2"],
  ["ln((-1)*(-1))+1", "1"],
  ["diff(x^2,x,3)", "6"],
  ["diff(sin(x),x,0)", "1"],
  ["diff(exp(x),x,0)", "1"],
  ["diff(ln(x),x,1)", "1"],
  ["integrate(x^2,x,0,3)", "9"],
  ["integrate(sin(x),x,0,pi)", "2"],
  ["integrate(cos(x),x,0,pi/2)", "1"],
  ["integrate(1/x,x,1,e)", "1"],
];
for (const [input, value] of accepted)
  test(input, () =>
    assert.equal(judge(input, BigInt(value)).kind, "EXACT_MATCH"),
  );
for (const input of [
  "2",
  "1/2",
  "sqrt(2)",
  "1+1/10^40",
  "1-1/10^40",
  "1.00000000000000000001",
  "sin(pi/4)*sqrt(2)+1/10^40",
])
  test("mismatch " + input, () =>
    assert.equal(judge(input, 1n).kind, "EXACT_MISMATCH"),
  );
for (const input of [
  "2+",
  "1/0",
  "0*(1/0)+1",
  "tan(pi/2)",
  "ln(-1)-ln(-1)+1",
  "diff(abs(x),x,0)+1",
  "diff(x/x,x,0)+1",
  "integrate(1/x,x,-1,1)+1",
  "integrate(1/x^2,x,-1,1)",
  "foo(2)",
  "x",
  "x=1",
  "while(1)",
  "9^(9^9)",
  "201!",
  "(".repeat(25) + "1" + ")".repeat(25),
  "2²",
])
  test("invalid " + input, () =>
    assert.equal(judge(input, 1n).kind, "INVALID"),
  );
test("unknown", () => assert.equal(judge("sin(1)", 1n).kind, "UNKNOWN"));
test("budget then next simple", () => {
  assert.equal(judge("sin(pi/12)", 1n, 1).kind, "INVALID");
  assert.equal(judge("1", 1n).kind, "EXACT_MATCH");
});
