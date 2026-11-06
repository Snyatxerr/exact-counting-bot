import { invalid } from "./parser";
export type Q = [bigint, bigint];
export const bits = (x: bigint) => (x < 0n ? -x : x).toString(2).length;
export function q(n: bigint, d = 1n): Q {
  if (d === 0n) invalid("未定義です");
  if (bits(n) > 4096 || bits(d) > 4096) invalid("計算上限です");
  let x = n < 0n ? -n : n,
    y = d < 0n ? -d : d;
  while (y) {
    [x, y] = [y, x % y];
  }
  return [(n / (x || 1n)) * (d < 0n ? -1n : 1n), (d < 0n ? -d : d) / (x || 1n)];
}
export const add = (a: Q, b: Q) => q(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
export const neg = (a: Q): Q => [-a[0], a[1]];
export const mul = (a: Q, b: Q) => q(a[0] * b[0], a[1] * b[1]);
export const div = (a: Q, b: Q) => q(a[0] * b[1], a[1] * b[0]);
export const cmp = (a: Q, b: Q) => {
  const x = a[0] * b[1] - b[0] * a[1];
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};
export function literal(s: string): Q {
  const [mant, ex = "0"] = s.toLowerCase().split("e");
  if (ex.length > 5) invalid("計算上限です");
  const exponent = BigInt(ex);
  if (exponent > 1024n || exponent < -1024n) invalid("計算上限です");
  const [i, f = ""] = mant.split(".");
  const scale = BigInt(f.length) - exponent;
  return scale >= 0n
    ? q(BigInt((i || "0") + f), 10n ** scale)
    : q(BigInt((i || "0") + f) * 10n ** -scale);
}
