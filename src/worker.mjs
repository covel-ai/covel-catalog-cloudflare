import { z } from 'zod';
import { ServiceError, fail } from '@covel/catalog-kit/core';
import { downloadSchema, updateSchema, rangeOf } from '@covel/catalog-kit/http-contract';
import { PACKAGER_VERSION } from '@covel/catalog-kit/hash';
import { Store } from './store.mjs';
import { beginPublication,appendRecord,finishPublication } from './publication.mjs';
import { authorize,body,first,all,run,statement as s,guard,batch,sha256,parse,sizedStream } from './util.mjs';
import { enqueue,claim,jobFor,heartbeat,failJob,leaseGuard,cacheKey,cacheIdentity,reserveGitHub,releaseGitHub,liveRepository,dispatch } from './tasks.mjs';
import { uploadArtifact,completeArtifact,attachArtifact,validateObject } from './artifacts.mjs';

const json=(value,status=200)=>Response.json(value,{status});
async function checkpoint(env,job,name,request) {
  if(job.type!=='collect'||! /^(round|releases)$/.test(name))fail(400,'checkpoint_scope','Invalid checkpoint scope');
  const key=`${job.kind}/${name}`,old=await first(env.DB,'SELECT * FROM checkpoints WHERE name=?',key);
  if(request.method==='GET') {
    if(!old)return json(null);
    const object=await env.BUCKET.get(old.object_key);
    if(!object||object.size!==old.size||object.customMetadata?.sha256!==old.sha256)fail(503,'checkpoint_corrupt','Checkpoint needs recovery');
    return new Response(object.body,{headers:{'content-type':'application/json','x-content-sha256':old.sha256}});
  }
  const size=Number(request.headers.get('content-length')),digest=request.headers.get('x-content-sha256');
  if(!Number.isSafeInteger(size)||size<1||size>32*1024**2||!/^[a-f0-9]{64}$/.test(digest??''))fail(413,'checkpoint_limit','Checkpoint requires a bounded size and digest');
  const objectKey=`checkpoints/${key}/${digest}`;
  const object=await env.BUCKET.put(objectKey,sizedStream(request,size),{sha256:digest,customMetadata:{sha256:digest},httpMetadata:{contentType:'application/json'}});
  if(object.size!==size)fail(400,'size_mismatch','Checkpoint size differs');
  await batch(env.DB,[leaseGuard(env.DB,job),s(env.DB,'INSERT INTO checkpoints VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET object_key=excluded.object_key,sha256=excluded.sha256,size=excluded.size,updated=excluded.updated',key,objectKey,digest,size,Date.now())]);
  if(old&&old.object_key!==objectKey)await env.BUCKET.delete(old.object_key);
  return json({saved:true});
}
async function publicationRoute(env,kind,parts,request,extra=[]) {
  if(parts.length===0)return json(await beginPublication(env.DB,await body(request),kind));
  const [id,action,seq]=parts;
  if(!/^[a-f0-9]{64}$/.test(id))fail(400,'snapshot_id','Invalid snapshot identity');
  if(action==='records')return json(await appendRecord(env.DB,id,Number(seq),await body(request),kind,Date.now(),extra));
  if(action==='finish')return json(await finishPublication(env.DB,id,kind,Date.now(),extra));
  fail(404,'not_found','Unknown publication operation');
}
async function handle(request,env,ctx) {
  const url=new URL(request.url),route=url.pathname,method=request.method,store=new Store(env.DB,env.CURSOR_SECRET);
  if(method==='GET'&&route==='/healthz') {
    const db=await first(env.DB,'SELECT value FROM settings WHERE key=?','maintenance');
    return json({status:db?.value==='1'?'maintenance':'ok',schemaVersion:1});
  }
  const maintenance=await first(env.DB,"SELECT value FROM settings WHERE key='maintenance'");
  if(method==='PUT'&&route==='/admin/restore-object') {
    authorize(request,env.OPS_TOKEN);
    if(maintenance?.value!=='1')fail(409,'maintenance_required','Restore writes require maintenance mode');
    const key=url.searchParams.get('key'),digest=request.headers.get('x-content-sha256'),size=Number(request.headers.get('content-length'));
    if(!/^(artifacts\/[a-f0-9]{64}\.zip|checkpoints\/(plugins|worlds)\/(round|releases)\/[a-f0-9]{64})$/.test(key??'')||!/^[a-f0-9]{64}$/.test(digest??'')||!Number.isSafeInteger(size)||size<1||size>32*1024**2)fail(400,'invalid_restore','Invalid recovery object');
    const object=await env.BUCKET.put(key,sizedStream(request,size),{sha256:digest,customMetadata:{sha256:digest},httpMetadata:{contentType:key.endsWith('.zip')?'application/zip':'application/json'}});
    if(object.size!==size)fail(400,'size_mismatch','Restored object size differs');
    return json({key,size,sha256:digest});
  }
  if(method==='POST'&&route==='/admin/policy') {authorize(request,env.POLICY_TOKEN);return json(await store.publishPolicy(await body(request)));}
  if(maintenance?.value==='1')fail(503,'maintenance','Directory is paused for recovery');
  if(method==='GET'&&route==='/v1/policy'){const response=json(await store.policy());response.headers.set('X-Catalog-Ingest','staged-v1');return response;}
  if(method==='GET'&&route==='/v1/catalog')return json(await store.list(Object.fromEntries(url.searchParams)));
  const entryMatch=/^\/v1\/entries\/([^/]+)(\/versions)?$/.exec(route);
  if(method==='GET'&&entryMatch)return json(await store[entryMatch[2]?'versions':'detail'](decodeURIComponent(entryMatch[1])));
  if(method==='POST'&&route==='/v1/check-update'){
    const input=updateSchema.parse(await body(request,16384));
    if(input.lock.registryUrl.replace(/\/$/,'')!==env.PUBLIC_URL)return json({state:'unknown',reason:'registry-mismatch'});
    return json(await store.checkUpdate(input.lock,input));
  }
  if(method==='POST'&&route==='/v1/downloads') {
    const input=downloadSchema.parse(await body(request,4096));
    const revision=await store.revision(input.key,input.revisionId);
    await store.bindRequest(input.key,input.revisionId,input.idempotencyKey);
    let artifact=await store.artifact(input.revisionId,PACKAGER_VERSION);
    const id=cacheKey(revision.entry);
    if(!artifact) {
      const prepared=await first(env.DB,'SELECT * FROM prepared_artifacts WHERE cache_key=?',id);
      if(prepared){
        if(prepared.identity!==cacheIdentity(revision.entry))fail(409,'cache_conflict','Cached package metadata differs');
        artifact=parse(prepared);const policy=await store.allowed(revision.entry,artifact);
        await attachArtifact(env.DB,revision,artifact,policy,store);
      }
    }
    if(!artifact) {
      const job=await enqueue(env.DB,{id,type:'artifact',kind:revision.entry.kind,revisionId:revision.revisionId,payload:{entry:revision.entry}},Number(env.MAX_PENDING_JOBS??50));
      if(job.state==='failed')fail(422,'preparation_failed','ZIP preparation failed; an operator must inspect and retry the task');
      if(job.state==='done')fail(503,'artifact_missing','Prepared artifact must be recovered');
      ctx.waitUntil(dispatch(env));
      return json({state:'pending',jobId:id,retryAfter:15},202);
    }
    await store.allowed(revision.entry,artifact);
    validateObject(await env.BUCKET.head(artifact.storageKey),artifact);
    await liveRepository(env,revision.entry);
    const result=await store.issueTicket(input.key,input.revisionId,artifact,input.idempotencyKey);
    const {storageKey,...publicArtifact}=result.artifact;
    return json({url:`${env.PUBLIC_URL}/v1/files/${result.ticket.token}`,expiresAt:new Date(result.ticket.expires).toISOString(),artifact:publicArtifact});
  }
  const fileMatch=/^\/v1\/files\/([A-Za-z0-9_-]{43})$/.exec(route);
  if(['GET','HEAD'].includes(method)&&fileMatch) {
    let record=await store.redeem(fileMatch[1]);await liveRepository(env,record.revision.entry);
    const artifact=record.artifact;
    validateObject(await env.BUCKET.head(artifact.storageKey),artifact);
    const range=rangeOf(request.headers.get('range'),artifact.size);
    const object=method==='HEAD'?null:await env.BUCKET.get(artifact.storageKey,range?{range:{offset:range.start,length:range.end-range.start+1}}:undefined);
    if(method!=='HEAD'){if(!object)fail(503,'artifact_missing','Artifact must be restored');validateObject(object,artifact);}
    record=await store.redeem(fileMatch[1]); // final current-policy gate, including old tickets
    return new Response(object?.body??null,{status:range?206:200,headers:{'Content-Type':'application/zip','Content-Length':String(range?range.end-range.start+1:artifact.size),'Content-Disposition':`attachment; filename="${artifact.filename}"`,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${artifact.size}`}:{})}});
  }
  const publication=/^\/admin\/snapshots\/(plugins|worlds)(?:\/(.*))?$/.exec(route);
  if(method==='POST'&&publication){authorize(request,env[`${publication[1].toUpperCase()}_INGEST_TOKEN`]);return publicationRoute(env,publication[1],publication[2]?.split('/')??[],request);}
  if(method==='GET'&&route==='/admin/status') {
    authorize(request,env.OPS_TOKEN);
    return json({snapshots:await all(env.DB,'SELECT c.kind,c.snapshot_id,s.generated,s.entries FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshot_id'),
      tasks:await all(env.DB,'SELECT type,state,count(*) count FROM jobs GROUP BY type,state'),budget:await first(env.DB,'SELECT window,used,anonymous_used,cooldown,lease_until FROM github_gate'),
      artifactBytes:(await first(env.DB,'SELECT COALESCE(sum(bytes),0) bytes FROM object_reservations')).bytes,
      policy:await first(env.DB,'SELECT sequence,expires FROM policies ORDER BY sequence DESC LIMIT 1')});
  }
  if(method==='POST'&&route==='/internal/enqueue-collection') {
    authorize(request,env.RUNNER_TOKEN);const input=z.object({kind:z.enum(['plugins','worlds']),round:z.string().regex(/^[A-Za-z0-9-]{1,80}$/)}).strict().parse(await body(request));
    const job=await enqueue(env.DB,{id:sha256(`collect:${input.kind}:${input.round}`),type:'collect',kind:input.kind},Number(env.MAX_PENDING_JOBS??50));return json({jobId:job.id,state:job.state});
  }
  if(method==='POST'&&route==='/internal/claim') {authorize(request,env.RUNNER_TOKEN);return json(await claim(env.DB));}
  if(method==='POST'&&route==='/internal/retry') {
    authorize(request,env.OPS_TOKEN);const input=z.object({jobId:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await body(request));
    return json(await first(env.DB,"UPDATE jobs SET state='queued',attempts=0,error=NULL,available=? WHERE id=? AND state='failed' RETURNING id,state",Date.now(),input.jobId));
  }
  const task=/^\/internal\/jobs\/([a-f0-9]{64})\/(.*)$/.exec(route);
  if(task) {
    const job=await jobFor(env.DB,task[1],request),action=task[2];
    if(method==='POST'&&action==='heartbeat')return json(await heartbeat(env.DB,job));
    if(method==='POST'&&action==='fail')return json(await failJob(env.DB,job,z.object({retryable:z.boolean(),code:z.enum(['preparation_failed','github_budget','collection_failed'])}).strict().parse(await body(request))));
    if(method==='POST'&&action==='github/reserve'){
      const input=z.object({authenticated:z.boolean().default(false)}).strict().parse(await body(request));
      return json(await reserveGitHub(env.DB,Number(env.GITHUB_HOURLY_BUDGET??50),Date.now(),!input.authenticated));
    }
    if(method==='POST'&&action==='github/release'){
      const input=z.object({token:z.string().length(43),status:z.number().int(),remaining:z.number().nullable(),reset:z.number().nullable(),retryAfter:z.number().nullable()}).strict().parse(await body(request));
      await releaseGitHub(env.DB,input.token,input);return json({released:true});
    }
    if(method==='PUT'&&action.startsWith('artifact/'))return json(await uploadArtifact(env,job,request,action.slice(9)));
    if(method==='POST'&&action==='complete-artifact')return json(await completeArtifact(env,store,job,await body(request)));
    if(action.startsWith('checkpoint/')&&['GET','PUT'].includes(method))return checkpoint(env,job,action.slice(11),request);
    if(method==='POST'&&action.startsWith('publish')&&job.type==='collect')return publicationRoute(env,job.kind,action==='publish'?[]:action.slice(8).split('/'),request,[leaseGuard(env.DB,job)]);
    if(method==='POST'&&action==='complete-collection'&&job.type==='collect'){
      const input=z.object({snapshotId:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await body(request));
      await batch(env.DB,[leaseGuard(env.DB,job),guard(env.DB,"EXISTS(SELECT 1 FROM snapshots WHERE id=? AND kind=? AND state='published')",input.snapshotId,job.kind),s(env.DB,"UPDATE jobs SET state='done',finished=?,lease_hash=NULL,lease_until=0 WHERE id=?",Date.now(),job.id)]);
      return json({state:'done'});
    }
  }
  fail(404,'not_found','Unknown directory endpoint');
}
export default {
  async fetch(request,env,ctx) {
    const origin=request.headers.get('origin'),allowed=(env.ALLOWED_ORIGINS??'').split(',');let response;
    try {
      if(origin&&!allowed.includes(origin))fail(403,'origin_denied','This browser origin is not configured');
      response=request.method==='OPTIONS'?new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET,HEAD,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Range','Access-Control-Max-Age':'300'}}):await handle(request,env,ctx);
    } catch(e) {
      const status=e instanceof ServiceError?e.status:e instanceof z.ZodError||e instanceof URIError?400:500;
      if(status===500)console.error(JSON.stringify({event:'request_failed',name:e.name,...(env.LOCAL_DIAGNOSTICS==='1'?{message:e.message}:{})}));
      response=json({code:e instanceof ServiceError?e.code:status===400?'invalid_input':'request_failed',message:e instanceof ServiceError?e.message:status===400?'Request does not match the contract':'The directory could not complete this request'},status);
      if(status===429||status===503)response.headers.set('Retry-After','15');
    }
    response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    if(origin&&allowed.includes(origin)){response.headers.set('Access-Control-Allow-Origin',origin);response.headers.set('Vary','Origin');}
    return response;
  }
};
