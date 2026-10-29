import { fail } from '@covel/catalog-kit/core';
import { PACKAGER_VERSION } from '@covel/catalog-kit/hash';
import { first, all, run, statement as s, guard, batch, token, sha256 } from './util.mjs';

export const cacheKey=(e)=>sha256(JSON.stringify([e.repositoryId,e.kind,e.path,e.commitSha,PACKAGER_VERSION]));
export const cacheIdentity=(e)=>JSON.stringify([e.id,e.version,e.sourceTreeHash]);
export const leaseGuard=(db,j,now=Date.now())=>guard(db,`EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_hash=? AND lease_until>?)`,j.id,j.lease_hash,now);
export async function enqueue(db,{id,type,kind,revisionId=null,payload={}},maxPending=50,now=Date.now()) {
  const old=await first(db,"SELECT * FROM jobs WHERE id=? OR (type='collect' AND ?='collect' AND kind=? AND state IN ('queued','running')) LIMIT 1",id,type,kind);if(old)return old;
  await batch(db,[guard(db,"(SELECT count(*) FROM jobs WHERE state IN ('queued','running'))<?",maxPending),
    s(db,"INSERT OR IGNORE INTO jobs(id,type,kind,revision_id,payload,state,available,created) VALUES(?,?,?,?,?,'queued',?,?)",id,type,kind,revisionId,JSON.stringify(payload),now,now)]);
  return first(db,"SELECT * FROM jobs WHERE id=? OR (type='collect' AND ?='collect' AND kind=? AND state IN ('queued','running')) LIMIT 1",id,type,kind);
}
export async function claim(db,now=Date.now()) {
  const value=token();
  // A crashed final attempt is terminal, never an immortal running job.
  await run(db,"UPDATE jobs SET state='failed',error='lease_exhausted',finished=? WHERE state='running' AND lease_until<=? AND attempts>=5",now,now);
  const job=await first(db,`UPDATE jobs SET state='running',attempts=attempts+1,lease_hash=?,lease_until=?
    WHERE id=(SELECT id FROM jobs WHERE ((state='queued' AND available<=?) OR (state='running' AND lease_until<=?)) AND attempts<5 ORDER BY created,id LIMIT 1)
    RETURNING *`,sha256(value),now+120000,now,now);
  return job?{job:{id:job.id,type:job.type,kind:job.kind,revisionId:job.revision_id,payload:JSON.parse(job.payload),attempts:job.attempts},leaseToken:value,leaseUntil:now+120000}:null;
}
export async function jobFor(db,id,request,now=Date.now()) {
  const value=request.headers.get('authorization')?.replace(/^Bearer /,'');
  const row=await first(db,"SELECT * FROM jobs WHERE id=? AND state='running' AND lease_hash=? AND lease_until>?",id,sha256(value??''),now);
  if(!row)fail(401,'invalid_lease','A current task-scoped lease is required');return row;
}
export async function heartbeat(db,job,now=Date.now()) {
  await batch(db,[leaseGuard(db,job,now),s(db,'UPDATE jobs SET lease_until=? WHERE id=?',now+120000,job.id)]);return {leaseUntil:now+120000};
}
export async function failJob(db,job,{retryable=false,code='preparation_failed'}={},now=Date.now()) {
  if(retryable&&code==='github_budget') {
    const gate=await first(db,'SELECT cooldown FROM github_gate WHERE id=1');
    const available=Math.max((Math.floor(now/3600000)+1)*3600000+1000,gate?.cooldown??0);
    await batch(db,[leaseGuard(db,job,now),s(db,"UPDATE jobs SET state='queued',error=?,available=?,attempts=max(0,attempts-1),lease_hash=NULL,lease_until=0 WHERE id=?",code,available,job.id)]);
    return {state:'queued',available};
  }
  const retry=retryable&&job.attempts<5;
  await batch(db,[leaseGuard(db,job,now),s(db,'UPDATE jobs SET state=?,error=?,available=?,finished=?,lease_hash=NULL,lease_until=0 WHERE id=?',retry?'queued':'failed',code,now+Math.min(3600000,30000*2**job.attempts),retry?null:now,job.id)]);
  return {state:retry?'queued':'failed'};
}
export async function reserveGitHub(db,limit,now=Date.now(),anonymous=false) {
  const value=token(),window=Math.floor(now/3600000);
  const row=await first(db,`UPDATE github_gate SET lease_hash=?,lease_until=?,window=?,used=CASE WHEN window=? THEN used+1 ELSE 1 END,
    anonymous_used=CASE WHEN window=? THEN anonymous_used+? ELSE ? END
    WHERE id=1 AND lease_until<=? AND cooldown<=? AND (window<>? OR used<?)
    AND (?=0 OR window<>? OR anonymous_used<50) RETURNING used`,sha256(value),now+45000,window,window,window,Number(anonymous),Number(anonymous),now,now,window,limit,Number(anonymous),window);
  if(!row)fail(429,'github_budget','Shared GitHub queue or hourly budget is busy; resume later');return {token:value,used:row.used};
}
export async function releaseGitHub(db,value,{status=200,remaining=null,reset=null,retryAfter=null}={},now=Date.now()) {
  let cooldown=now+1000; // <= 1 live request/second across workers and runners.
  if(remaining===0&&reset)cooldown=Math.max(cooldown,reset*1000+1000);
  if(status===429||status===403&&retryAfter!==null)cooldown=Math.max(cooldown,now+Math.max(60000,Number(retryAfter??60)*1000));
  await run(db,'UPDATE github_gate SET lease_until=0,lease_hash=NULL,cooldown=max(cooldown,?) WHERE id=1 AND lease_hash=?',cooldown,sha256(value));
}
export async function liveRepository(env,entry) {
  let lease;
  // Ticket issuance and its immediate GET/HEAD share the same persistent gate.
  // Absorb the short inter-request cooldown without bypassing the lease or quota.
  // A busy collector or exhausted hourly budget still fails closed after 2.2s.
  for(let attempt=0;attempt<3;attempt++) {
    try {lease=await reserveGitHub(env.DB,Number(env.GITHUB_HOURLY_BUDGET??50),Date.now(),!env.GITHUB_TOKEN);break;}
    catch(error){if(error.code!=='github_budget'||attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,1100));}
  }
  let response;
  try {
    response=await (env.GITHUB?env.GITHUB.fetch(`https://api.github.com/repositories/${entry.repositoryId}`):fetch(`https://api.github.com/repositories/${entry.repositoryId}`,{
      redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'covel-catalog',...(env.GITHUB_TOKEN?{Authorization:`Bearer ${env.GITHUB_TOKEN}`}:{})}}));
    if(response.status===404)fail(410,'repository_unavailable','Repository is unavailable');
    if(!response.ok)fail(503,'github_unavailable','Live repository verification failed');
    const {bounded}=await import('./util.mjs');
    const repo=JSON.parse(new TextDecoder().decode(await bounded(response,65536)));
    if(repo.id!==entry.repositoryId||repo.private!==false||repo.disabled||repo.archived||repo.owner?.id!==entry.ownerId)fail(410,'repository_unavailable','Repository is no longer public under its indexed owner');
    return repo;
  } finally {
    await response?.body?.cancel().catch(()=>{});
    await releaseGitHub(env.DB,lease.token,{status:response?.status??503,remaining:response?.headers.has('x-ratelimit-remaining')?Number(response.headers.get('x-ratelimit-remaining')):null,reset:Number(response?.headers.get('x-ratelimit-reset'))||null,retryAfter:response?.headers.has('retry-after')?Number(response.headers.get('retry-after')):null});
  }
}
export async function dispatch(env) {
  if(!env.ACTIONS_DISPATCH_TOKEN)return;
  const now=Date.now(),claimed=await first(env.DB,'UPDATE dispatch_gate SET next_at=? WHERE id=1 AND next_at<=? RETURNING id',now+300000,now);
  if(!claimed)return;
  const response=await fetch(`https://api.github.com/repos/${env.ACTIONS_REPOSITORY}/actions/workflows/runner.yml/dispatches`,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${env.ACTIONS_DISPATCH_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'covel-catalog','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify({ref:env.ACTIONS_REF??'main'})});
  if(!response.ok)console.warn(JSON.stringify({event:'dispatch_failed',status:response.status}));
  await response.body?.cancel();
}
