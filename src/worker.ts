import { DurableObject } from "cloudflare:workers";
import { Store } from "./store";
import { transition, control } from "./game";
import { candidate } from "./parser";
import { judge } from "./math";
import { HELP } from "./help";
export interface Env {
  BOT: DurableObjectNamespace<CountingBot>;
  DISCORD_BOT_TOKEN: string;
  ALLOWED_GUILD_ID: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  TEST_MODE?: string;
}
type Packet = { op: number; s: number | null; t: string | null; d: any };
const json = (x: unknown, status = 200) => Response.json(x, { status });
const obj = (e: Env) => e.BOT.get(e.BOT.idFromName("singleton-v1"));
export default {
  async fetch(req: Request, env: Env) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return json({ ok: true });
    if (env.TEST_MODE === "local" && u.pathname === "/test")
      return obj(env).fetch(req);
    if (u.pathname !== "/interactions" || req.method !== "POST")
      return new Response("Not Found", { status: 404 });
    const raw = await req.text();
    if (raw.length > 65536) return new Response("Too Large", { status: 413 });
    const sig = req.headers.get("x-signature-ed25519"),
      time = req.headers.get("x-signature-timestamp");
    if (
      !sig ||
      !/^[a-fA-F0-9]{128}$/.test(sig) ||
      !time ||
      !/^\d+$/.test(time) ||
      Math.abs(Date.now() / 1000 - Number(time)) > 300
    )
      return new Response("Unauthorized", { status: 401 });
    try {
      const bytes = (s: string) =>
        Uint8Array.from(s.match(/../g) ?? [], (v) => parseInt(v, 16));
      const key = await crypto.subtle.importKey(
        "raw",
        bytes(env.DISCORD_PUBLIC_KEY),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (
        !(await crypto.subtle.verify(
          "Ed25519",
          key,
          bytes(sig),
          new TextEncoder().encode(time + raw),
        ))
      )
        return new Response("Unauthorized", { status: 401 });
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    let interaction: any;
    try { interaction = JSON.parse(raw); }
    catch { return new Response("Bad Request", { status: 400 }); }
    if (!interaction || typeof interaction !== "object")
      return new Response("Bad Request", { status: 400 });
    if (interaction.type === 1) return json({ type: 1 });
    if (interaction.guild_id !== env.ALLOWED_GUILD_ID)
      return json({
        type: 4,
        data: { content: "このサーバーでは使えません。", allowed_mentions: { parse: [] } },
      }); // Durable queue first; heavy CAS never runs in the ingress Worker
    await obj(env).enqueue(interaction);
    return json({ type: 5 });
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(obj(env).health());
  },
};
export class CountingBot extends DurableObject<Env> {
  db: Store;
  fifo: Promise<unknown> = Promise.resolve();
  ws?: WebSocket;
  gatewayReady = false;
  connecting = false;
  heartbeat?: ReturnType<typeof setInterval>;
  ack = true;
  received: number | null = null;
  retryAt = 0;
  failures = 0;
  fatal = false;
  draining = false;
  generation = 0;
  testFault = '';
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Store(ctx.storage.sql, (fn) =>
      ctx.storage.transactionSync(fn),
    );
    this.fatal = this.db.get("fatal", false);
  }
  serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.fifo.then(fn);
    this.fifo = result.catch(() => { this.disconnect(); });
    return result;
  }
  async enqueue(i: any) {
    await this.serial(() => this.db.atomic(() => {
      if (!this.db.seen(i.id) && BigInt(i.id)>BigInt(this.db.get('floor','0'))) {
        this.db.queue("cmd:" + i.id, { kind: "command", interaction: i });
        // HTTP commands join the same FIFO immediately, before subsequent dispatches.
        this.command(i);
        this.db.sql.exec("UPDATE outbox SET status='done' WHERE id=?",'cmd:'+i.id);
      }
    }));
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  async alarm() {
    await this.commands();
    await this.drain();
    await this.health();
  }
  async commands() {
    const commands = this.db.rows(
      "SELECT id,payload FROM outbox WHERE status='pending' AND id LIKE 'cmd:%' ORDER BY created,rowid LIMIT 20",
    );
    for (const row of commands)
      await this.serial(() => {
        const i = JSON.parse(String(row.payload)).interaction;
        this.command(i);
        this.db.sql.exec("UPDATE outbox SET status='done' WHERE id=?", row.id);
      });
  }
  command(i: any) {
    this.db.atomic(() => {
      if (this.db.seen(i.id)) return;
      if (BigInt(i.id)<=BigInt(this.db.get('floor','0'))) return;
      let s = this.db.state(),
        text = "未対応のコマンドです。";
      const name = i.data?.name,
        admin = (BigInt(i.member?.permissions ?? "0") & 40n) !== 0n;
      const guild = i.guild_id === this.env.ALLOWED_GUILD_ID;
      if (!guild) text = "このサーバーでは使えません。";
      else if (["set", "stop", "reset"].includes(name)) {
        if (!admin) text = "サーバー管理権限が必要です。";
        else if (name === "set" && i.channel?.type !== 0)
          text = "通常テキストチャンネルで実行してください。";
        else {
          s = control(s, name, i.channel_id, i.id);
          this.db.save(s);
          if(name==='set'){this.fatal=false;this.db.put('fatal',false);}
          text =
            name === "set"
              ? `このチャンネルで受付を開始します。次は${BigInt(s.current) + 1n}です。不確かな停止区間は判定しません。`
              : name === "stop"
                ? "受付を停止しました。進行と統計は保持します。"
                : `進行を初期化しました。次は1です。受付は${s.enabled && !s.recovery ? "継続中" : "停止中（/setで再開）"}です。`;
        }
      } else if (name === "status")
        text = `状態：${s.recovery ? "復旧待ち" : s.enabled ? "稼働中" : "停止中"}\nGateway：${this.fatal ? "設定エラー（トークン・Intentを確認）" : this.gatewayReady ? "接続済み" : "接続待ち（通常投稿を受信できません）"}\n現在 ${s.current}／次 ${BigInt(s.current) + 1n}\n最後 ${s.last ? `<@${s.last}>` : "なし"}\n最高 ${s.best}`;
      else if (name === "stats") {
        const id =
          i.data.options?.find((o: any) => o.name === "user")?.value ??
          i.member.user.id;
        const row = this.db.rows("SELECT score FROM users WHERE id=?", id)[0];
        text = `<@${id}>：累計正解 ${row?.score ?? 0}件`;
      } else if (name === "ranking") {
        const rows = this.db.rows(
          "SELECT id,score,RANK() OVER(ORDER BY score DESC) AS rank FROM users ORDER BY score DESC,id LIMIT 10",
        );
        text = rows.length
          ? rows
              .map((r) => `${r.rank}位 <@${r.id}>：${r.score}件`)
              .join("\n")
          : "まだ正解はありません。";
      } else if (name === "help") text = HELP;
      this.db.done(i.id, "command");
      this.db.queue("reply:" + i.id, {
        method: "PATCH",
        path: `/webhooks/${this.env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`,
        body: { content: text, allowed_mentions: { parse: [] } },
      });
    });
  }
  async message(p: Packet) {
    const m = p.d;
    const generation=this.generation;
    await this.serial(() => {
      if(generation!==this.generation)return;
      const checkpoint = () => {
        if (p.s !== null) this.db.put("checkpoint", p.s);
      };
      const s = this.db.state();
      const id = String(m.id);
      if (!/^\d+$/.test(id)) return;
      if (this.db.seen(id) || BigInt(id) <= BigInt(this.db.get("floor", "0"))) {
        this.db.atomic(checkpoint);
        return;
      }
      if (
        m.guild_id !== this.env.ALLOWED_GUILD_ID ||
        m.channel_id !== s.channel ||
        !s.enabled ||
        s.recovery ||
        m.author?.bot ||
        m.webhook_id ||
        BigInt(id) <= BigInt(s.boundary)
      ) {
        this.db.atomic(checkpoint);
        return;
      }
      const text = typeof m.content === "string" ? m.content : "";
      if (!candidate(text)) {
        this.db.atomic(() => {
          this.db.done(id, "chat");
          checkpoint();
        });
        return;
      }
      // Persist an attempt BEFORE synchronous math. Interrupted attempts are never retried unboundedly.
      const attempts = Number(
        this.db.rows("SELECT attempts FROM pending WHERE id=?", id)[0]
          ?.attempts ?? 0,
      );
      this.db.sql.exec(
        "INSERT OR REPLACE INTO pending VALUES(?,?)",
        id,
        attempts + 1,
      );
      const verdict =
        attempts >= 1
          ? {
              kind: "INVALID" as const,
              reason: "前回の計算が中断されたため無効です",
            }
          : judge(text, BigInt(s.current) + 1n);
      this.db.atomic(() => {
        const live = this.db.state();
        if (live.version !== s.version) throw Error("state version conflict");
        const r = transition(s, m.author.id, verdict);
        this.db.save(r.state);
        this.db.done(id, r.result);
        if (r.result === "success")
          this.db.sql.exec(
            "INSERT INTO users VALUES(?,1) ON CONFLICT(id) DO UPDATE SET score=score+1",
            m.author.id,
          );
        if(this.env.TEST_MODE==='local'&&this.testFault==='after-score'){
          this.testFault='';throw Error('injected transaction interruption');
        }
        if (r.result !== "invalid")
          this.db.queue("react:" + id, {
            method: "PUT",
            path: `/channels/${s.channel}/messages/${id}/reactions/${encodeURIComponent(r.result === "success" ? "✅" : "❌")}/@me`,
          });
        let notice = r.notice;
        if (r.result === "success" && notice) {
          const existed = this.db.rows(
            "SELECT value FROM milestones WHERE run=? AND value=?",
            s.run,
            r.state.current,
          ).length;
          this.db.sql.exec(
            "INSERT OR IGNORE INTO milestones VALUES(?,?)",
            s.run,
            r.state.current,
          );
          if (existed) notice = undefined;
        }
        if (r.result === "invalid") {
          const prev = this.db.get("invalidNotice", 0);
          if (Date.now() - prev < 5000) notice = undefined;
          else this.db.put("invalidNotice", Date.now());
        }
        if (notice)
          this.db.queue("notice:" + id, {
            method: "POST",
            path: `/channels/${s.channel}/messages`,
            body: {
              content: notice,
              nonce: id,
              enforce_nonce: true,
              allowed_mentions: { parse: [] },
            },
          });
        checkpoint();
      });
    });
  }
  async drain() {
    if (this.draining || Date.now()<this.db.get('rateLimitUntil',0)) return;
    this.draining = true;
    try {
      for (let k = 0; k < 10; k++) {
        const now = Date.now();
        this.db.sql.exec(
          "UPDATE outbox SET status='pending' WHERE status='inflight' AND lease<=?",
          now,
        );
        this.db.sql.exec(
          "UPDATE outbox SET status='failed' WHERE status='pending' AND (attempts>=5 OR created<?) AND id NOT LIKE 'cmd:%'",
          now - 1800000,
        );
        const row = this.db.rows(
          "SELECT * FROM outbox WHERE status='pending' AND next<=? AND id NOT LIKE 'cmd:%' ORDER BY created,rowid LIMIT 1",
          now,
        )[0];
        if (!row) break;
        const item = JSON.parse(String(row.payload));
        const tries = Number(row.attempts) + 1;
        this.db.sql.exec(
          "UPDATE outbox SET status='inflight',attempts=?,lease=? WHERE id=?",
          tries,
          now + 30000,
          row.id,
        );
        if(this.env.TEST_MODE==='local'&&this.testFault==='after-claim'){
          this.testFault='';return;
        }
        let status = 0,
          delay = 0;
        try {
          const res = await fetch("https://discord.com/api/v10" + item.path, {
            method: item.method,
            headers: {
              Authorization: "Bot " + this.env.DISCORD_BOT_TOKEN,
              "Content-Type": "application/json",
            },
            body: item.body ? JSON.stringify(item.body) : undefined,
            signal: AbortSignal.timeout(15000),
          });
          status = res.status;
          if (status === 429) {
            const data: any = await res.json();
            delay = Math.max(
              Number(data.retry_after ?? 1) * 1000,
              Number(res.headers.get("retry-after") ?? 0) * 1000,
            );
            this.db.put("rateLimitUntil", Date.now() + delay);
          } else if (res.headers.get("x-ratelimit-remaining") === "0")
            delay =
              Number(res.headers.get("x-ratelimit-reset-after") ?? 0) * 1000;
        } catch {}
        if (status >= 200 && status < 300)
          this.db.sql.exec(
            "UPDATE outbox SET status='done',lease=0,payload='{}' WHERE id=?",
            row.id,
          );
        else if (
          tries >= 5 ||
          (status >= 400 && status < 500 && status !== 429)
        )
          this.db.sql.exec(
            "UPDATE outbox SET status='failed',lease=0 WHERE id=?",
            row.id,
          );
        else {
          delay =
            Math.max(delay, 1000 * 2 ** tries) +
            Math.floor(Math.random() * 500);
          this.db.sql.exec(
            "UPDATE outbox SET status='pending',next=?,lease=0 WHERE id=?",
            Date.now() + delay,
            row.id,
          );
        }
        if(delay>0)this.db.put('rateLimitUntil',Date.now()+delay);
        if (delay > 0) break;
      }
    } finally {
      this.draining = false;
      const row = this.db.rows(
        "SELECT MIN(CASE WHEN status='inflight' THEN lease ELSE next END) AS due FROM outbox WHERE status IN ('pending','inflight')",
      )[0];
      if (row?.due != null)
        await this.ctx.storage.setAlarm(
          Math.max(
            Date.now() + 1000,
            Number(row.due),
            this.db.get("rateLimitUntil", 0),
          ),
        );
    }
  }
  async health() {
    this.db.cleanup();
    if (this.env.TEST_MODE === "local") return;
    if (!this.env.DISCORD_BOT_TOKEN || this.fatal) return;
    if (
      !this.ws &&
      !this.connecting &&
      Date.now() >= Math.max(this.retryAt, this.db.get("connectAt", 0))
    )
      await this.connect();
    await this.commands();
    if (Date.now() >= this.db.get("rateLimitUntil", 0)) await this.drain();
  }
  disconnect(fatal = false) {
    this.generation++;
    const socket = this.ws;
    this.ws = undefined;
    this.gatewayReady = false;
    clearInterval(this.heartbeat);
    this.fatal = fatal;
    if (fatal) this.db.put("fatal", true);
    this.retryAt =
      Date.now() +
      Math.min(300000, 1000 * 2 ** Math.min(this.failures++, 8)) +
      Math.random() * 1000;
    try {
      socket?.close(4000, "reconnect");
    } catch {}
  }
  recovery() {
    this.db.atomic(() => {
      const s = this.db.state();
      if (s.channel) {
        s.recovery = true;
        s.enabled = false;
        s.version++;
        this.db.save(s);
      }
      this.db.put("session", null);
      this.db.put("checkpoint", null);
    });
  }
  async connect() {
    this.connecting = true;
    try {
      const session = this.db.get<any>("session", null);
      let url = session?.url;
      let remaining = 1,
        reset = 60000;
      if (!url) {
        const res = await fetch("https://discord.com/api/v10/gateway/bot", {
          headers: { Authorization: "Bot " + this.env.DISCORD_BOT_TOKEN },
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            this.disconnect(true);
            return;
          }
          this.retryAt = Date.now() + 60000;
          return;
        }
        const data: any = await res.json();
        url = data.url;
        remaining = data.session_start_limit.remaining;
        reset = data.session_start_limit.reset_after;
        if (!remaining) {
          this.db.put("connectAt", Date.now() + reset);
          return;
        }
      }
      // Workers fetch() accepts HTTP(S), not the wss: URL returned by Discord.
      const gatewayUrl = new URL(url);
      if (gatewayUrl.protocol !== "wss:") throw Error("unexpected gateway protocol");
      gatewayUrl.protocol = "https:";
      gatewayUrl.searchParams.set("v", "10");
      gatewayUrl.searchParams.set("encoding", "json");
      const response = await fetch(gatewayUrl, {
        headers: { Upgrade: "websocket" },
      });
      if (!response.webSocket) throw Error("gateway upgrade failed");
      const ws = response.webSocket;
      this.ws = ws;
      ws.accept();
      this.received = this.db.get("checkpoint", null);
      this.ack = true;
      ws.addEventListener("message", (event) => {
        if (this.ws !== ws) return;
        let p: Packet;
        try {
          p = JSON.parse(String(event.data));
        } catch {
          this.disconnect();
          return;
        }
        if (p.s !== null) this.received = p.s;
        if (p.op === 11) {
          this.ack = true;
          return;
        }
        if (p.op === 1) {
          this.beat();
          return;
        }
        if (p.op === 10) {
          const heartbeat = () => {
            if (!this.ack) {
              this.disconnect();
              return;
            }
            this.beat();
          };
          this.heartbeat = setInterval(heartbeat, p.d.heartbeat_interval);
          setTimeout(() => {
            if (this.ws === ws) this.beat();
          }, Math.random() * p.d.heartbeat_interval);
          const saved = this.db.get<any>("session", null),
            seq = this.db.get("checkpoint", null);
          if (saved && seq !== null)
            ws.send(
              JSON.stringify({
                op: 6,
                d: {
                  token: this.env.DISCORD_BOT_TOKEN,
                  session_id: saved.id,
                  seq,
                },
              }),
            );
          else {
            this.db.put("connectAt", Date.now() + 5000);
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: this.env.DISCORD_BOT_TOKEN,
                  intents: 33281,
                  properties: {
                    os: "cloudflare",
                    browser: "exact-counting",
                    device: "exact-counting",
                  },
                },
              }),
            );
          }
          return;
        }
        if (p.op === 7) {
          this.disconnect();
          return;
        }
        if (p.op === 9) {
          if (!p.d) this.serial(() => this.recovery());
          this.disconnect();
          return;
        }
        if (p.op !== 0) return;
        if (p.t === "MESSAGE_CREATE") {
          this.ctx.waitUntil(
            this.message(p)
              .then(() => this.drain())
              .catch(() => {
                this.disconnect();
              }),
          );
          return;
        }
        const generation=this.generation;
        this.ctx.waitUntil(
          this.serial(() => {
            if(generation!==this.generation)return;
            this.db.atomic(() => {
              if (p.t === "READY") {
                this.gatewayReady = true;
                if (this.db.get("everReady", false)) this.recovery();
                this.db.put("everReady", true);
                this.db.put("session", {
                  id: p.d.session_id,
                  url: p.d.resume_gateway_url,
                });
                this.failures = 0;
              }
              if (p.t === "RESUMED") {
                this.gatewayReady = true;
                this.failures = 0;
              }
              if (p.s !== null) this.db.put("checkpoint", p.s);
            });
          }),
        );
      });
      ws.addEventListener("close", (event) => {
        if (this.ws !== ws) return;
        if ([4007, 4009].includes(event.code))
          this.serial(() => this.recovery());
        this.disconnect(
          [4004, 4010, 4011, 4012, 4013, 4014].includes(event.code),
        );
      });
      ws.addEventListener("error", () => {
        if (this.ws === ws) this.disconnect();
      });
    } catch {
      this.disconnect();
    } finally {
      this.connecting = false;
    }
  }
  beat() {
    if (this.ws) {
      this.ack = false;
      this.ws.send(JSON.stringify({ op: 1, d: this.received }));
    }
  }
  async fetch(req: Request) {
    if (this.env.TEST_MODE !== "local")
      return new Response("Forbidden", { status: 403 });
    const data: any = await req.json();
    if (data.kind === "math")
      return json(judge(data.input, BigInt(data.target), data.steps));
    if (data.kind === "command") {
      this.command(data.interaction);
      return json(this.db.state());
    }
    if (data.kind === "message") {
      await this.message(data.packet);
      return json({
        state: this.db.state(),
        users: this.db.rows("SELECT * FROM users"),
        outbox: this.db.rows("SELECT id,status,attempts FROM outbox"),
      });
    }
    if (data.kind === "recover") {
      this.recovery();
      return json(this.db.state());
    }
    if(data.kind==='fault'){this.testFault=data.at;return json({ok:true});}
    if(data.kind==='drain'){await this.drain();return json(this.db.rows('SELECT id,status,attempts,lease,next FROM outbox'));}
    if(data.kind==='retry-now'){this.db.sql.exec("UPDATE outbox SET next=0,lease=0 WHERE status IN ('pending','inflight')");this.db.put('rateLimitUntil',0);return json({ok:true});}
    if(data.kind==='prune'){this.db.sql.exec('UPDATE processed SET created=0');this.db.cleanup();return json({floor:this.db.get('floor','0')});}
    if(data.kind==='snapshot')return json({state:this.db.state(),users:this.db.rows('SELECT * FROM users'),checkpoint:this.db.get('checkpoint',null),pending:this.db.rows('SELECT * FROM pending'),outbox:this.db.rows('SELECT id,status,attempts FROM outbox'),milestones:this.db.rows('SELECT * FROM milestones')});
    return json({ state: this.db.state() });
  }
}
