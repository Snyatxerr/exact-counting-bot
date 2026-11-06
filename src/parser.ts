export type Ast = { op: string; args: Ast[]; text?: string };
export class MathFault extends Error {
  constructor(
    public kind: "INVALID" | "UNKNOWN",
    message: string,
  ) {
    super(message);
  }
}
export const invalid = (s = "未対応です"): never => {
  throw new MathFault("INVALID", s);
};
export const unknown = (): never => {
  throw new MathFault("UNKNOWN", "整数との一致を確定できません");
};
export const n = (s: string | bigint | number): Ast => ({
  op: "num",
  text: String(s),
  args: [],
});
export const a = (op: string, ...args: Ast[]): Ast => ({ op, args });
export function candidate(s: string) {
  return /^\s*`?\s*(?:[\d.(+\-−√π]|(?:pi|e|x|[a-z]+\s*\())/.test(s);
}
export function parse(input: string): Ast {
  if (input.length > 512) invalid("計算上限です");
  let s = input.trim();
  if (s.startsWith("`") && s.endsWith("`")) s = s.slice(1, -1);
  s = s
    .replace(/π/g, "pi")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-");
  const tokens =
    s.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-z]+|\*\*|[^\s]/g) ??
    [];
  let p = 0,
    count = 0,
    depth = 0;
  const peek = () => tokens[p];
  const take = () => tokens[p++];
  const node = (op: string, ...args: Ast[]) => {
    if (++count > 256) invalid("計算上限です");
    return a(op, ...args);
  };
  function atom(): Ast {
    if (++depth > 24) invalid("計算上限です");
    let r: Ast;
    const t = take();
    if (t === "(") {
      r = expr(0);
      if (take() !== ")") invalid("構文エラーです");
    } else if (t === "√") {
      if (peek() !== "(" && !/^(?:\d|\.\d)/.test(peek() ?? ""))
        invalid("根号の範囲を括弧で指定してください");
      r = node("sqrt", atom());
    } else if (/^(?:\d|\.\d)/.test(t ?? "")) {
      if ((t.match(/\d/g) ?? []).length > 128) invalid("計算上限です");
      r = n(t);
      ++count;
    } else if (t === "pi" || t === "e" || t === "x") r = node(t);
    else if (/^[a-z]+$/.test(t ?? "") && peek() === "(") {
      take();
      const args: Ast[] = [];
      if (peek() !== ")") {
        do {
          args.push(expr(0));
          if (peek() !== ",") break;
          take();
        } while (true);
      }
      if (take() !== ")") invalid("構文エラーです");
      r = node(t, ...args);
    } else return invalid("構文エラーです");
    depth--;
    return r;
  }
  function expr(min: number): Ast {
    let r: Ast;
    if (peek() === "+" || peek() === "-") {
      const t = take();
      r = node(t === "-" ? "neg" : "pos", expr(25));
    } else r = atom();
    while (true) {
      const t = peek();
      if (t === "!" && 40 >= min) {
        take();
        r = node("factorial", r);
        continue;
      }
      const bp =
        t === "+" || t === "-"
          ? 10
          : t === "*" || t === "/"
            ? 20
            : t === "^" || t === "**"
              ? 30
              : -1;
      if (bp < min) break;
      take();
      r = node(t === "**" ? "^" : t, r, expr(bp + (bp === 30 ? 0 : 1)));
    }
    return r;
  }
  const result = expr(0);
  if (p !== tokens.length) invalid("構文エラーです");
  function check(t: Ast, bound = false, calculus = 0, d = 0) {
    if (d > 24) invalid("計算上限です");
    const arities: Record<string, number[]> = {
      num: [0],
      pi: [0],
      e: [0],
      x: [0],
      neg: [1],
      pos: [1],
      "+": [2],
      "-": [2],
      "*": [2],
      "/": [2],
      "^": [2],
      sqrt: [1],
      abs: [1],
      factorial: [1],
      sin: [1],
      cos: [1],
      tan: [1],
      exp: [1],
      ln: [1],
      log: [1, 2],
      diff: [3],
      integrate: [4],
    };
    if (!arities[t.op]?.includes(t.args.length)) invalid();
    if (t.op === "x" && !bound) invalid("自由変数は使えません");
    if (t.op === "diff" || t.op === "integrate") {
      if (++calculus > 2) invalid("計算上限です");
      if (t.args[1].op !== "x") invalid();
      check(t.args[0], true, calculus, d + 1);
      t.args.slice(2).forEach((z) => check(z, bound, calculus, d + 1));
    } else t.args.forEach((z) => check(z, bound, calculus, d + 1));
  }
  check(result);
  return result;
}
