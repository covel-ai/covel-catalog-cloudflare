import { mkdir,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGitHubClient,diskCache,MetadataError,GitHubError } from '@covel/catalog-kit/github';
import { createPackager,validateWorldPackage } from '@covel/catalog-kit/packager';
import { validatePluginPackage } from '@covel/catalog-kit/adapters/plugins';
import { collectCatalog } from '@covel/catalog-kit/collector';
import { apiClient,remoteCheckpoint } from './api.mjs';
import { publish } from './publish.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function coordinatedFetch(client,jobPath,fetchImpl=fetch) {
  return async(url,init)=>{
    let lease;
    for(let attempt=0;attempt<5;attempt++){
      try {lease=await client.json(`${jobPath}/github/reserve`,{data:{}});break;}
      catch(e){if(e.status!==429||attempt===4)throw e;await wait(1500*(attempt+1));}
    }
    let response,finished=false;
    const finish=async()=>{
      if(finished)return;finished=true;
      await client.json(`${jobPath}/github/release`,{data:{token:lease.token,status:response?.status??503,
        remaining:response?.headers.has('x-ratelimit-remaining')?Number(response.headers.get('x-ratelimit-remaining')):null,
        reset:response?.headers.has('x-ratelimit-reset')?Number(response.headers.get('x-ratelimit-reset')):null,
        retryAfter:response?.headers.has('retry-after')?Number(response.headers.get('retry-after')):null}});
    };
    try {response=await fetchImpl(url,init);}catch(e){await finish();throw e;}
    if(!response.body){await finish();return response;}
    const reader=response.body.getReader();
    return new Response(new ReadableStream({async pull(controller){try{const {done,value}=await reader.read();if(done){await finish();controller.close();}else controller.enqueue(value);}catch(e){await finish().catch(()=>{});controller.error(e);}},async cancel(){await reader.cancel();await finish();}}),{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
export async function executeJob({url,claim,githubToken,fetchImpl=fetch,cacheDir='.cache/runner'}) {
  const {job,leaseToken}=claim,client=apiClient({url,token:leaseToken,fetchImpl}),base=`/internal/jobs/${job.id}`;
  let lost=false;
  const timer=setInterval(()=>client.json(`${base}/heartbeat`,{data:{}}).catch(()=>{lost=true;}),30000);timer.unref();
  const checkedFetch=async(...args)=>{if(lost)throw new Error('Task lease was lost');return coordinatedFetch(client,base,fetchImpl)(...args);};
  const get=createGitHubClient({token:githubToken,fetchImpl:checkedFetch,cache:diskCache(path.join(cacheDir,'github')),maxRequests:850,maxWaitMs:10000});
  try {
    if(job.type==='artifact'){
      const packager=createPackager({get,cacheDir:path.join(cacheDir,'artifacts'),maxConcurrent:1,validatePackage:async(kind,files,entry)=>kind==='plugins'?validatePluginPackage(files,entry):validateWorldPackage(files,entry)});
      const artifact=await packager.prepare(job.payload.entry);
      const bytes=await readFile(path.join(cacheDir,'artifacts',artifact.storageKey));
      await client.json(`${base}/artifact/${artifact.artifactSha256}`,{method:'PUT',bytes,headers:{'Content-Type':'application/zip'}});
      await client.json(`${base}/complete-artifact`,{data:artifact});
    }else if(job.type==='collect'){
      const {config,overrides=[]}=JSON.parse(await readFile(new URL(`../catalog/${job.kind}.json`,import.meta.url),'utf8'));let receipt;
      await collectCatalog({kind:job.kind,config,overrides,get,checkpoint:remoteCheckpoint(client,`${base}/checkpoint/round`),releaseCheckpoint:remoteCheckpoint(client,`${base}/checkpoint/releases`),onComplete:async(catalog,releases)=>{
        receipt=await publish(client,`${base}/publish`,catalog,releases);
      }});
      await client.json(`${base}/complete-collection`,{data:{snapshotId:receipt.snapshotId}});
    }else throw new Error('Unknown task type');
    return {jobId:job.id,state:'done'};
  }catch(e){
    const retryable=e.status===429||e.status>=500||e.name==='GitHubError';
    await client.json(`${base}/fail`,{data:{retryable,code:job.type==='collect'?'collection_failed':'preparation_failed'}}).catch(()=>{});
    // Do not emit transport bodies, headers, archive data, or credential-bearing errors.
    console.error(JSON.stringify({jobId:job.id,state:'failed',retryable,diagnostic:e instanceof MetadataError||e instanceof GitHubError?e.message.slice(0,300):e.code??'transport_or_storage_error'}));throw new Error('Trusted task failed; checkpoint and previous snapshot retained');
  }finally{clearInterval(timer);}
}
export async function run({url=process.env.CATALOG_API_URL,token=process.env.CATALOG_RUNNER_TOKEN,githubToken=process.env.GITHUB_TOKEN,collect=false,maxJobs=10}={}) {
  if(!url||!token)throw new Error('Configure API origin and runner credential');
  const client=apiClient({url,token});
  if(collect)for(const kind of ['plugins','worlds'])await client.json('/internal/enqueue-collection',{data:{kind,round:String(Math.floor(Date.now()/(6*3600000)))}});
  let failures=0;
  for(let i=0;i<maxJobs;i++){
    const claim=await client.json('/internal/claim',{data:{}});if(!claim)break;
    try{console.log(JSON.stringify(await executeJob({url,claim,githubToken})));}catch{failures++;}
  }
  if(failures)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run({collect:process.argv.includes('--collect')});
