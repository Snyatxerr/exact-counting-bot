import { ComputeEngine } from "@cortex-js/compute-engine/core";
import { a, n, parse, MathFault, invalid, unknown, type Ast } from "./parser";
import { type Q, q, literal, add, mul, div, neg, cmp, bits } from "./rational";
export type Verdict = {
  kind: "EXACT_MATCH" | "EXACT_MISMATCH" | "INVALID" | "UNKNOWN";
  reason?: string;
};
type Box = ReturnType<ComputeEngine["box"]>;
type Interval = [Q, Q];
const zero = q(0n),
  one = q(1n);
// Each request has its own engine, assumptions and deterministic step span.
export function judge(input: string, target: bigint, steps = 20000): Verdict {
  try {
    const ast = parse(input),
      ce = new ComputeEngine();
    let work = 0;
    const tick = () => {
      if (++work > 2048) invalid("計算上限です");
    };
    const json = (v: Q): any => [
      "Rational",
      { num: v[0].toString() },
      { num: v[1].toString() },
    ];
    const exact = (b: Box): Q | undefined => {
      const v: any = (b as any).numericValue;
      if (typeof v === "number") {
        if (Number.isSafeInteger(v)) return q(BigInt(v));
        return;
      }
      if (v?.isExact && !v.isComplex && v.radical === 1)
        return q(BigInt(v.rational[0]), BigInt(v.rational[1]));
    };
    const run = (j: any): Box => {
      tick();
      const r = ce.box(j).evaluate({ numericApproximation: false }).simplify();
      if (ce.stepBudgetSpent) invalid("計算上限です");
      return r;
    };
    const rat = (t: Ast): Q | undefined => {
      tick();
      if (t.op === "num") return literal(t.text!);
      if (t.op === "neg") {
        const v = rat(t.args[0]);
        return v && neg(v);
      }
      if (t.op === "pos") return rat(t.args[0]);
      if (["+", "-", "*", "/", "^"].includes(t.op)) {
        const x = rat(t.args[0]),
          y = rat(t.args[1]);
        if (!x || !y) return;
        if (t.op === "+") return add(x, y);
        if (t.op === "-") return add(x, neg(y));
        if (t.op === "*") return mul(x, y);
        if (t.op === "/") return div(x, y);
        if (y[1] !== 1n) return;
        if (y[0] > 1024n || y[0] < -1024n) invalid("計算上限です");
        let e = y[0] < 0n ? -y[0] : y[0];
        if (BigInt(Math.max(bits(x[0]), bits(x[1]))) * e > 4096n)
          invalid("計算上限です");
        if (x[0] === 0n && e === 0n) invalid("未定義です");
        return y[0] >= 0n ? q(x[0] ** e, x[1] ** e) : q(x[1] ** e, x[0] ** e);
      }
      return;
    };
    function range(t: Ast, x?: Interval): Interval | undefined {
      tick();
      const r = rat(t);
      if (r) return [r, r];
      const z = t.args;
      if (t.op === "x") return x;
      if (t.op === "pi") return [q(3n), q(4n)];
      if (t.op === "e") return [q(2n), q(3n)];
      if (t.op === "neg") {
        const v = range(z[0], x);
        return v && [neg(v[1]), neg(v[0])];
      }
      if (t.op === "pos") return range(z[0], x);
      if (t.op === "sin" || t.op === "cos") return [q(-1n), one];
      if (t.op === "+" || t.op === "-") {
        const u = range(z[0], x),
          v = range(z[1], x);
        if (!u || !v) return;
        return t.op === "+"
          ? [add(u[0], v[0]), add(u[1], v[1])]
          : [add(u[0], neg(v[1])), add(u[1], neg(v[0]))];
      }
      if (t.op === "*" || t.op === "/") {
        const u = range(z[0], x),
          v = range(z[1], x);
        if (!u || !v) return;
        if (t.op === "/" && cmp(v[0], zero) <= 0 && cmp(v[1], zero) >= 0)
          return;
        const w = [u[0], u[1]]
          .flatMap((i) =>
            [v[0], v[1]].map((j) => (t.op === "*" ? mul(i, j) : div(i, j))),
          )
          .sort(cmp);
        return [w[0], w[3]];
      }
      if (t.op === "^") {
        const u = range(z[0], x),
          v = rat(z[1]);
        if (!u || !v || v[1] !== 1n || v[0] < 0n || v[0] > 16n) return;
        let r: Interval = [one, one];
        for (let i = 0n; i < v[0]; i++) {
          const w = r.flatMap((k) => u.map((j) => mul(k, j))).sort(cmp);
          r = [w[0], w[3]];
        }
        return r;
      }
      return;
    }
    function condition(
      t: Ast,
      mode: "positive" | "nonnegative" | "nonzero",
      x?: Interval,
    ) {
      const v = range(t, x);
      if (v) {
        if (
          (mode === "positive" && cmp(v[0], zero) > 0) ||
          (mode === "nonnegative" && cmp(v[0], zero) >= 0) ||
          (mode === "nonzero" && (cmp(v[0], zero) > 0 || cmp(v[1], zero) < 0))
        )
          return;
        if (cmp(v[0], v[1]) === 0) invalid("定義域の外です");
        if (x) invalid("区間の定義域を確認できません");
      }
      if (!x) {
        const v = exact(build(t));
        if (v) {
          if (
            (mode === "positive" && v[0] > 0n) ||
            (mode === "nonnegative" && v[0] >= 0n) ||
            (mode === "nonzero" && v[0] !== 0n)
          )
            return;
          invalid("定義域の外です");
        }
        const val: any = (build(t) as any).numericValue;
        if (val?.isExact && !val.isComplex) {
          const sign = val.sgn();
          if (
            sign === 1 ||
            (mode === "nonzero" && sign === -1) ||
            (mode === "nonnegative" && sign === 0)
          )
            return;
          invalid("定義域の外です");
        }
      }
      unknown();
    }
    function domain(t: Ast, x?: Interval, differentiating = false): void {
      tick();
      const z = t.args;
      if (t.op === "diff" || t.op === "integrate") return;
      z.forEach((v) => domain(v, x, differentiating));
      if (t.op === "/") condition(z[1], "nonzero", x);
      if (t.op === "sqrt") {
        if (differentiating) condition(z[0], "positive", x);
        else condition(z[0], "nonnegative", x);
      }
      if (t.op === "ln" || t.op === "log") {
        condition(z[0], "positive", x);
        if (z[1]) {
          condition(z[1], "positive", x);
          const b = rat(z[1]);
          if (!b) return unknown();
          if (cmp(b, one) === 0) invalid("底は1以外です");
        }
      }
      if (t.op === "abs" && differentiating) condition(z[0], "nonzero", x);
      if (t.op === "tan") condition(a("cos", z[0]), "nonzero", x);
      if (t.op === "^") {
        const e = rat(z[1]);
        if (!e || e[1] !== 1n)
          return invalid("累乗の指数は整数に限定しています");
        if (e[0] > 1024n || e[0] < -1024n) invalid("計算上限です");
        if (e[0] <= 0n) condition(z[0], "nonzero", x);
      }
    }
    function sub(t: Ast, v: Ast): Ast {
      return t.op === "x" ? v : { ...t, args: t.args.map((z) => sub(z, v)) };
    }
    function derivative(t: Ast): Ast {
      tick();
      const [u, v] = t.args;
      switch (t.op) {
        case "num":
        case "pi":
        case "e":
          return n(0);
        case "x":
          return n(1);
        case "neg":
          return a("neg", derivative(u));
        case "pos":
          return derivative(u);
        case "+":
        case "-":
          return a(t.op, derivative(u), derivative(v));
        case "*":
          return a("+", a("*", derivative(u), v), a("*", u, derivative(v)));
        case "/":
          return a(
            "/",
            a("-", a("*", derivative(u), v), a("*", u, derivative(v))),
            a("^", v, n(2)),
          );
        case "^": {
          const e = rat(v);
          if (!e || e[1] !== 1n) return unknown();
          return a("*", a("*", v, a("^", u, n(e[0] - 1n))), derivative(u));
        }
        case "sin":
          return a("*", a("cos", u), derivative(u));
        case "cos":
          return a("neg", a("*", a("sin", u), derivative(u)));
        case "exp":
          return a("*", a("exp", u), derivative(u));
        case "ln":
        case "log":
          if (v) unknown();
          return a("/", derivative(u), u);
        default:
          return unknown();
      }
    }
    function primitive(t: Ast): Ast {
      tick();
      const [u, v] = t.args;
      switch (t.op) {
        case "num":
        case "pi":
        case "e":
          return a("*", t, a("x"));
        case "x":
          return a("/", a("^", a("x"), n(2)), n(2));
        case "+":
        case "-":
          return a(t.op, primitive(u), primitive(v));
        case "^": {
          const e = rat(v);
          if (u.op !== "x" || !e || e[1] !== 1n || e[0] < 0n || e[0] > 32n)
            return unknown();
          return a("/", a("^", u, n(e[0] + 1n)), n(e[0] + 1n));
        }
        case "sin":
          if (u.op === "x") return a("neg", a("cos", u));
          break;
        case "cos":
          if (u.op === "x") return a("sin", u);
          break;
        case "exp":
          if (u.op === "x") return t;
          break;
        case "/":
          if (
            u.op === "num" &&
            rat(u)?.[0] === 1n &&
            rat(u)?.[1] === 1n &&
            v.op === "x"
          )
            return a("ln", v);
          break;
      }
      return unknown();
    }
    function build(t: Ast): Box {
      tick();
      const r = rat(t);
      if (r) return ce.box(json(r));
      const z = t.args;
      if (t.op === "pi") return ce.box("Pi");
      if (t.op === "e") return ce.box("ExponentialE");
      if (t.op === "x") return ce.box("x");
      if (t.op === "diff") {
        const point = range(z[2]);
        if (!point) return unknown();
        domain(z[0], point, true);
        const d = derivative(z[0]);
        return build(sub(d, z[2]));
      }
      if (t.op === "integrate") {
        domain(z[2]);
        domain(z[3]);
        const lo = range(z[2]),
          hi = range(z[3]);
        if (!lo || !hi) return unknown();
        const bounds = [lo[0], lo[1], hi[0], hi[1]].sort(cmp);
        domain(z[0], [bounds[0], bounds[3]], true);
        const f = primitive(z[0]); // finite whitelist of continuous elementary primitives; verify F'=f symbolically
        const proof = run([
          "Subtract",
          build(derivative(f)).json,
          build(z[0]).json,
        ]);
        if (exact(proof)?.[0] !== 0n) unknown();
        return run([
          "Subtract",
          build(sub(f, z[3])).json,
          build(sub(f, z[2])).json,
        ]);
      }
      if (t.op === "factorial") {
        const v = exact(build(z[0]));
        if (!v || v[1] !== 1n || v[0] < 0n || v[0] > 200n)
          return invalid("階乗は0〜200の整数です");
        let k = 1n;
        for (let i = 2n; i <= v[0]; i++) {
          tick();
          k *= i;
        }
        return ce.box(json(q(k)));
      }
      if (t.op === "^") {
        const exponent = rat(z[1]);
        if (
          !exponent ||
          exponent[1] !== 1n ||
          exponent[0] > 1024n ||
          exponent[0] < -1024n
        )
          return invalid("計算上限です");
        if (!rat(z[0]) && (exponent[0] > 16n || exponent[0] < -16n))
          invalid("記号展開の計算上限です");
      }
      if (t.op === "sqrt") {
        const v = rat(z[0]);
        if (v && (bits(v[0]) > 40 || bits(v[1]) > 40))
          invalid("根号の計算上限です");
      }
      const names: Record<string, string> = {
        "+": "Add",
        "-": "Subtract",
        "*": "Multiply",
        "/": "Divide",
        "^": "Power",
        neg: "Negate",
        pos: "Identity",
        sqrt: "Sqrt",
        abs: "Abs",
        sin: "Sin",
        cos: "Cos",
        tan: "Tan",
        exp: "Exp",
        ln: "Ln",
        log: "Ln",
      };
      let children = z.map(build);
      if (t.op === "log" && z.length === 2)
        return run([
          "Divide",
          ["Ln", children[0].json],
          ["Ln", children[1].json],
        ]);
      return run([names[t.op], ...children.map((v) => v.json)]);
    }
    return ce.withStepBudget({ steps, label: "counting-v1" }, () => {
      domain(ast);
      let result = build(ast);
      const rational = exact(result);
      if (rational)
        return {
          kind:
            cmp(rational, q(target)) === 0 ? "EXACT_MATCH" : "EXACT_MISMATCH",
        };
      const delta = run(["Subtract", result.json, json(q(target))]);
      const d = exact(delta);
      if (d) return { kind: d[0] === 0n ? "EXACT_MATCH" : "EXACT_MISMATCH" };
      const v: any = (result as any).numericValue;
      if (
        v?.isExact &&
        !v.isComplex &&
        !v.isNaN &&
        !v.isPositiveInfinity &&
        !v.isNegativeInfinity &&
        v.radical !== 1
      ) {
        // nonzero rational times sqrt(squarefree integer) is irrational
        if (v.rational?.[0] !== 0 && v.rational?.[0] !== 0n)
          return { kind: "EXACT_MISMATCH" };
      }
      return { kind: "UNKNOWN", reason: "整数との一致を確定できません" };
    });
  } catch (e) {
    if (e instanceof MathFault) return { kind: e.kind, reason: e.message };
    if ((e as any)?.cause === "step-budget")
      return { kind: "INVALID", reason: "計算上限です" };
    return { kind: "UNKNOWN", reason: "整数との一致を確定できません" };
  }
}
