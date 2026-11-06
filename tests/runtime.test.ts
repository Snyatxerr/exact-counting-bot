import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {accepted} from './math.test.ts';

test('workerd: exact math, SQLite atomicity, restart, leases, dedupe and recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'counting-test-'));let mf:Miniflare|undefined;let status=204,calls=0;
 const compiled=await build({entryPoints:['src/worker.ts'],bundle:true,format:'esm',write:false,external:['cloudflare:workers'],target:'es2022'});
 const options={name:"counting-runtime-test",modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-11-06',durableObjects:{BOT:{className:'CountingBot',useSQLite:true}},durableObjectsPersist:dir,bindings:{TEST_MODE:'local',ALLOWED_GUILD_ID:'1',DISCORD_APPLICATION_ID:'2',DISCORD_PUBLIC_KEY:'',DISCORD_BOT_TOKEN:'test-only-fake'},outboundService:async()=>{calls++;return new Response(status===429?JSON.stringify({retry_after:0.1,global:true}):null,{status,headers:status===429?{'content-type':'application/json','retry-after':'0.1'}:{}});}};
 const restart=async()=>{await mf?.dispose();mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:dir});await mf.ready;};
 const send=async(data:any)=>{const r=await mf!.dispatchFetch('http://local/test',{method:'POST',body:JSON.stringify(data)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json() as Promise<any>;};
 let id=1000n,seq=0;
 const command=async(name:string,channel='10',permissions='32',specific?:string)=>{const interaction={id:specific??String(++id),guild_id:'1',channel_id:channel,channel:{type:0},token:'dummy',data:{name},member:{permissions,user:{id:'A'}}};await send({kind:'command',interaction});return interaction;};
 const message=async(content:string,user='A',extra:any={},specific?:string)=>{const packet={op:0,s:++seq,t:'MESSAGE_CREATE',d:{id:specific??String(++id),guild_id:'1',channel_id:'10',content,author:{id:user},...extra}};const result=await send({kind:'message',packet});return{result,packet};};
 try{
 await restart();for(const[input,target]of accepted)assert.equal((await send({kind:'math',input,target})).kind,'EXACT_MATCH',input);
 assert.equal((await send({kind:'math',input:'sin(pi/12)',target:'1',steps:1})).kind,'INVALID');assert.equal((await send({kind:'math',input:'1',target:'1'})).kind,'EXACT_MATCH');
 await command('set');let r=await message('1');assert.equal(r.result.state.current,'1');const first=r.packet;
 await message('2','B');r=await message('3');assert.equal(r.result.state.current,'3');assert.deepEqual(r.result.users,[{id:'A',score:2},{id:'B',score:1}]);
 await message('sin(1)','B');r=await message('4');assert.equal(r.result.state.current,'0');assert.equal(r.result.state.last,null);
 await message('1');await message('hello');await message('1/0');r=await message('2');assert.equal(r.result.state.current,'0');
 const wrong=await message('2','B');await message('1','B');await send({kind:'message',packet:wrong.packet});let snap=await send({kind:'snapshot'});assert.equal(snap.state.current,'1');
 // Durable restart after commit, before any external send.
 const before=snap.users;await restart();snap=await send({kind:'snapshot'});assert.deepEqual(snap.users,before);assert.equal(snap.state.current,'1');await send({kind:'message',packet:first});assert.deepEqual((await send({kind:'snapshot'})).users,before);
 await command('stop');await message('2','A');assert.equal((await send({kind:'snapshot'})).state.current,'1');await command('set','11');await message('2','A');assert.equal((await send({kind:'snapshot'})).state.current,'1');await command('set');
 r=await message('2','A',{author:{id:'A',bot:true}});assert.equal(r.result.state.current,'1');r=await message('2','A',{webhook_id:'999'});assert.equal(r.result.state.current,'1');
 const reset=await command('reset');await send({kind:'command',interaction:reset});assert.equal((await send({kind:'snapshot'})).state.current,'0');
 // Rollback after score write: progress, score, dedupe and checkpoint roll back together.
 snap=await send({kind:'snapshot'});await send({kind:'fault',at:'after-score'});const crashPacket={op:0,s:++seq,t:'MESSAGE_CREATE',d:{id:String(++id),guild_id:'1',channel_id:'10',content:'1',author:{id:'A'}}};
 await assert.rejects(()=>send({kind:'message',packet:crashPacket}));let after=await send({kind:'snapshot'});assert.deepEqual(after.users,snap.users);assert.equal(after.state.current,'0');assert.equal(after.checkpoint,snap.checkpoint);await restart();await send({kind:'message',packet:crashPacket});assert.equal((await send({kind:'snapshot'})).state.current,'0');await message('1');
 // A claim is persisted before HTTP; restarting cannot reset the attempt counter.
 await send({kind:'fault',at:'after-claim'});let rows=await send({kind:'drain'});let claimed=rows.find((v:any)=>v.status==='inflight');assert.ok(claimed);assert.equal(claimed.attempts,1);await restart();await send({kind:'retry-now'});status=429;rows=await send({kind:'drain'});assert.equal(rows.find((v:any)=>v.id===claimed.id).attempts,2);await send({kind:'retry-now'});status=503;await send({kind:'drain'});await restart();for(let k=0;k<3;k++){await send({kind:'retry-now'});await send({kind:'drain'});}rows=await send({kind:'drain'});assert.equal(rows.find((v:any)=>v.id===claimed.id).status,'failed');assert.equal(rows.find((v:any)=>v.id===claimed.id).attempts,5);
 status=403;await send({kind:'retry-now'});rows=await send({kind:'drain'});assert.ok(rows.some((v:any)=>v.status==='failed'&&v.attempts===1));status=404;await message('2','B');await send({kind:'retry-now'});await send({kind:'drain'});assert.equal((await send({kind:'snapshot'})).state.current,'2');status=204;await send({kind:'retry-now'});await send({kind:'drain'});
 await send({kind:'recover'});snap=await send({kind:'snapshot'});assert.equal(snap.state.recovery,true);await command('reset');assert.equal((await send({kind:'snapshot'})).state.enabled,false);await message('1');assert.equal((await send({kind:'snapshot'})).state.current,'0');await command('set');await message('1');
 // Trimmed IDs remain excluded through a persisted floor, even across restart.
 const old=await message('99','B');await send({kind:'prune'});await restart();await message('1','B');await send({kind:'message',packet:old.packet});assert.equal((await send({kind:'snapshot'})).state.current,'1');assert.ok(calls>0);
 }finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
