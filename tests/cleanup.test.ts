import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("retention cleanup stays cheap at 100 posts/day and bounds dedupe storage", async () => {
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import {DurableObject} from 'cloudflare:workers';
    import {Store} from './src/store.ts';
    export class Probe extends DurableObject {
      async fetch(req) {
        const count=Number(new URL(req.url).pathname.slice(1));
        const db=new Store(this.ctx.storage.sql,fn=>this.ctx.storage.transactionSync(fn));
        db.atomic(()=>{
          for(let i=0;i<count;i++) {
            db.sql.exec('INSERT INTO processed VALUES(?,?,?)',String(1000000+i),'success',Date.now());
            db.sql.exec("INSERT INTO outbox(id,payload,status,next,created) VALUES(?,'{}','done',0,?)",'react:'+i,Date.now());
            db.sql.exec("INSERT INTO outbox(id,payload,status,next,created) VALUES(?,'{}','done',0,?)",'notice:'+i,Date.now());
          }
        });
        let reads=0;
        const raw=db.sql;
        db.sql={exec:(...args)=>{
          const cursor=raw.exec(...args), rows=cursor.toArray();
          reads+=cursor.rowsRead;
          return {toArray:()=>rows};
        }};
        db.cleanup();
        return Response.json({reads,count:raw.exec('SELECT COUNT(*) AS n FROM processed').one().n,floor:db.get('floor','0')});
      }
    }
    export default {fetch(req,env){const id=env.PROBE.idFromName(new URL(req.url).pathname);return env.PROBE.get(id).fetch(req);}};
  ` }, bundle: true, format: "esm", write: false, external: ["cloudflare:workers"], target: "es2022" });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "cleanup-test", modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2026-11-06", durableObjects: { PROBE: { className: "Probe", useSQLite: true } } }));
  try {
    const small: any = await (await mf.dispatchFetch("http://local/3000")).json();
    assert.equal(small.count, 3000);
    assert.ok(small.reads < 100, `cleanup read ${small.reads} rows at 30 days of normal usage`);
    const capped: any = await (await mf.dispatchFetch("http://local/10001")).json();
    assert.equal(capped.count, 9999);
    assert.equal(capped.floor, "1000001");
    console.log(`cleanup at 3000 messages + 6000 completed notifications: ${small.reads} rows read`);
  } finally { await mf.dispose(); }
});
