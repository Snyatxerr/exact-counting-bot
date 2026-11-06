import type { Verdict } from "./math";
export interface State {
  current: string;
  last: string | null;
  best: string;
  run: number;
  version: number;
  channel: string | null;
  enabled: boolean;
  recovery: boolean;
  boundary: string;
}
export const initial = (): State => ({
  current: "0",
  last: null,
  best: "0",
  run: 1,
  version: 0,
  channel: null,
  enabled: false,
  recovery: false,
  boundary: "0",
});
export function transition(s: State, user: string, v: Verdict) {
  const t = { ...s };
  const target = BigInt(s.current) + 1n;
  if (v.kind === "INVALID" || v.kind === "UNKNOWN")
    return {
      state: t,
      result: "invalid",
      notice: v.reason ?? "計算できません",
    };
  if (v.kind === "EXACT_MISMATCH" || s.last === user) {
    t.current = "0";
    t.last = null;
    t.run++;
    t.version++;
    return {
      state: t,
      result: "failure",
      notice: `期待値 ${target}：${v.kind === "EXACT_MISMATCH" ? "誤答" : "連続回答"}です。次は1です。`,
    };
  }
  t.current = String(target);
  t.last = user;
  t.version++;
  if (target > BigInt(t.best)) t.best = String(target);
  return {
    state: t,
    result: "success",
    notice:
      [10n, 50n, 100n, 500n].includes(target) ||
      (target >= 1000n && target % 1000n === 0n)
        ? `🎉 ${target}達成！`
        : undefined,
  };
}
export function control(
  s: State,
  command: string,
  channel: string,
  id: string,
): State {
  const t = { ...s, version: s.version + 1 };
  if (command === "set") {
    t.enabled = true;
    t.recovery = false;
    t.channel = channel;
    t.boundary = id;
  }
  if (command === "stop") t.enabled = false;
  if (command === "reset") {
    t.current = "0";
    t.last = null;
    t.run++;
  }
  return t;
}
