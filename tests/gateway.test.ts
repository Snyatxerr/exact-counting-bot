import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response as MFResponse } from "miniflare";

test("Gateway upgrades over HTTPS, identifies, receives counts and acknowledges heartbeats", async () => {
  const compiled = await build({ entryPoints: ["src/worker.ts"], bundle: true, format: "esm", write: false, external: ["cloudflare:workers"], target: "es2022" });
  let socket: InstanceType<typeof WebSocketPair>[1] | undefined;
  let identified: any;
  let beats = 0;
  const sent: { path: string; body: any }[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "counting-gateway-test", modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-11-06", durableObjects: { BOT: { className: "CountingBot", useSQLite: true } },
    bindings: { ALLOWED_GUILD_ID: "1", DISCORD_APPLICATION_ID: "2", DISCORD_PUBLIC_KEY: "", DISCORD_BOT_TOKEN: "test-only-fake" },
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v10/gateway/bot") return MFResponse.json({ url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 10000 } });
      if (url.hostname === "gateway.discord.gg") {
        assert.equal(url.protocol, "https:");
        assert.equal(req.headers.get("Upgrade"), "websocket");
        assert.equal(url.searchParams.get("v"), "10");
        const pair = new WebSocketPair(); socket = pair[1]; socket.accept();
        socket.addEventListener("message", e => {
          const p = JSON.parse(String(e.data));
          if (p.op === 2) identified = p.d;
          if (p.op === 1 && socket!.readyState === 1) {
            beats++;
            socket!.send(JSON.stringify({ op: 11, s: null, t: null, d: null }));
          }
        });
        socket.send(JSON.stringify({ op: 10, s: null, t: null, d: { heartbeat_interval: 60000 } }));
        return new MFResponse(null, { status: 101, webSocket: pair[0] });
      }
      sent.push({ path: url.pathname, body: req.method === "PATCH" || req.method === "POST" ? await req.json() : null });
      return new MFResponse(null, { status: 204 });
    },
  }));
  const waitFor = async (predicate: () => boolean) => {
    for (let k = 0; k < 100 && !predicate(); k++) await new Promise(r => setTimeout(r, 20));
    assert.ok(predicate(), "Gateway event did not reach the durable state/outbox");
  };
  try {
    const ns = await mf.getDurableObjectNamespace("BOT");
    const stub: any = ns.get(ns.idFromName("singleton-v1"));
    await stub.health();
    await waitFor(() => !!identified);
    assert.equal(identified.intents, 33281);
    socket!.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fake-session", resume_gateway_url: "wss://gateway.discord.gg" } }));
    await stub.enqueue({ id: "100", guild_id: "1", channel_id: "10", channel: { type: 0 }, token: "fake-interaction", data: { name: "set" }, member: { permissions: "32", user: { id: "A" } } });
    await waitFor(() => sent.some(x => x.path.endsWith("/@original")));
    socket!.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "101", guild_id: "1", channel_id: "10", content: "1", author: { id: "A" } } }));
    await waitFor(() => sent.some(x => x.path.includes("/messages/101/reactions/")));
    const reaction = sent.find(x => x.path.includes("/messages/101/reactions/"))!;
    assert.ok(decodeURIComponent(reaction.path).includes("✅"));
    await stub.enqueue({ id: "102", guild_id: "1", channel_id: "10", token: "fake-status", data: { name: "status" }, member: { user: { id: "A" } } });
    await waitFor(() => sent.some(x => x.path.includes("/fake-status/") && x.body?.content.includes("現在 1／次 2")));
    const status = sent.find(x => x.path.includes("/fake-status/"))!;
    assert.match(status.body.content, /Gateway：接続済み/);
    assert.match(status.body.content, /最後 <@A>/);
    for (const [id, name, expected] of [
      ["103", "ranking", "1位 <@A>：1件"],
      ["104", "stats", "<@A>：累計正解 1件"],
    ]) {
      await stub.enqueue({ id, guild_id: "1", channel_id: "10", token: `fake-${name}`, data: { name }, member: { user: { id: "A" } } });
      await waitFor(() => sent.some(x => x.path.includes(`/fake-${name}/`)));
      const reply = sent.find(x => x.path.includes(`/fake-${name}/`))!;
      assert.equal(reply.body.content, expected);
      assert.deepEqual(reply.body.allowed_mentions, { parse: [] });
    }
    const previousBeats = beats;
    socket!.send(JSON.stringify({ op: 1, s: null, t: null, d: null }));
    await waitFor(() => beats > previousBeats);
  } finally { socket?.close(1000, "test complete"); await mf.dispose(); }
});
