import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("HTTP ingress authenticates Discord and keeps test controls private", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const compiled = await build({ entryPoints: ["src/worker.ts"], bundle: true, format: "esm", write: false, external: ["cloudflare:workers"], target: "es2022" });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "counting-ingress-test", modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-11-06", durableObjects: { BOT: { className: "CountingBot", useSQLite: true } },
    bindings: { ALLOWED_GUILD_ID: "1", DISCORD_APPLICATION_ID: "2", DISCORD_PUBLIC_KEY: publicKey },
    outboundService: async () => new Response(null, { status: 204 }),
  }));
  const send = (raw: string, seconds = String(Math.floor(Date.now() / 1000)), signature?: string) => mf.dispatchFetch("https://local/interactions", {
    method: "POST", body: raw,
    headers: { "x-signature-timestamp": seconds, "x-signature-ed25519": signature ?? sign(null, Buffer.from(seconds + raw), keys.privateKey).toString("hex") },
  });
  try {
    assert.equal((await mf.dispatchFetch("https://local/health")).status, 200);
    assert.equal((await mf.dispatchFetch("https://local/test")).status, 404);
    assert.equal((await mf.dispatchFetch("https://local/interactions", { method: "POST", body: '{"type":1}' })).status, 401);
    assert.deepEqual(await (await send('{"type":1}')).json(), { type: 1 });
    assert.equal((await send('{"type":1}', "1")).status, 401);
    assert.equal((await send('{"type":1}', undefined, "00".repeat(64))).status, 401);
    assert.equal((await send('{"type":1}', undefined, "ff")).status, 401);
    assert.equal((await send("{")).status, 400);
    assert.equal((await send("null")).status, 400);
    const denied = await (await send('{"type":2,"guild_id":"other"}')).json() as any;
    assert.equal((denied.data.flags ?? 0) & 64, 0);
    assert.equal(denied.data.content, "このサーバーでは使えません。");
    for (const [index, name] of ["set", "stop", "reset", "status", "stats", "ranking", "help"].entries()) {
      const response = await send(JSON.stringify({
        type: 2, id: String(1000 + index), guild_id: "1", channel_id: "10", channel: { type: 0 },
        token: "test-only-interaction", data: { name }, member: { permissions: "32", user: { id: "20" } },
      }));
      const reply = await response.json() as any;
      assert.equal(reply.type, 5, name);
      assert.equal((reply.data?.flags ?? 0) & 64, 0, `${name} must be public`);
    }
  } finally { await mf.dispose(); }
});
