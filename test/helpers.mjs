import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp,readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apiClient } from '../scripts/api.mjs';
import { publish,publicationManifest } from '../scripts/publish.mjs';
export { entry,catalog } from '../node_modules/@covel/catalog-kit/test/fixtures.mjs';
export const secrets={POLICY_TOKEN:'p'.repeat(40),PLUGINS_INGEST_TOKEN:'i'.repeat(40),WORLDS_INGEST_TOKEN:'w'.repeat(40),RUNNER_TOKEN:'r'.repeat(40),OPS_TOKEN:'o'.repeat(40),CURSOR_SECRET:'s'.repeat(40)};
export const policy=(rules=[],sequence=1)=>({schemaVersion:1,sequence,version:`test-${sequence}`,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),rules});
export async function setup(t,{directory,initialize=true}={}) {
  directory??=await mkdtemp(path.join(os.tmpdir(),'covel-workerd-'));
  let repository={id:42,private:false,disabled:false,archived:false,owner:{id:7},full_name:'author/plugins'};
  const worker={modules:true,scriptPath:path.resolve('dist/worker.js'),compatibilityDate:'2026-07-01',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'00000000-0000-0000-0000-000000000000'},r2Buckets:{BUCKET:'covel-catalog-private'},
    bindings:{...secrets,LOCAL_DIAGNOSTICS:'1',PUBLIC_URL:'https://api.covel.cc',ALLOWED_ORIGINS:'https://plugins.covel.cc,https://worlds.covel.cc',GITHUB_HOURLY_BUDGET:'900',MAX_PENDING_JOBS:'50',MAX_ARTIFACT_BYTES:String(8*1024**3)},
    serviceBindings:{GITHUB:async()=>Response.json(repository)}};
  const mf=new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{name:'primary',...worker},{name:'peer',...worker}]}));
  let disposed=false; const close=async()=>{if(!disposed){disposed=true;await mf.dispose();}};t.after(close);const db=await mf.getD1Database('DB','primary'),bucket=await mf.getR2Bucket('BUCKET','primary');
  if(initialize)await db.exec((await readFile('migrations/0001_catalog.sql','utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
  const fetchImpl=(url,init)=>mf.dispatchFetch(url,init);
  const peer=await mf.getWorker('peer');
  const client=(token,onPeer=false)=>apiClient({url:'https://api.covel.cc',token,fetchImpl:onPeer?(url,init)=>peer.fetch(url,init):fetchImpl});
  const raw=async(route,method='GET',data,token)=>{const response=await mf.dispatchFetch(`https://api.covel.cc${route}`,{method,headers:{...(data?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,data:await response.json()};};
  return {mf,close,db,bucket,directory,client,raw,fetchImpl,setRepository:(r)=>{repository=r;},
    publish:(c,releases=[])=>publish(client(c.kind==='plugins'?secrets.PLUGINS_INGEST_TOKEN:secrets.WORLDS_INGEST_TOKEN),`/admin/snapshots/${c.kind}`,c,releases),
    policy:(p=policy())=>client(secrets.POLICY_TOKEN).json('/admin/policy',{data:p}),
    unblockGitHub:()=>db.prepare('UPDATE github_gate SET cooldown=0,lease_until=0').run()};
}
