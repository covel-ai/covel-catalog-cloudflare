import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { fingerprintTree,sha256 } from '@covel/catalog-kit/hash';
import { executeJob } from '../scripts/runner.mjs';
import { setup,entry,catalog,secrets } from './helpers.mjs';

test('Actions runner builds only selected world bytes with the canonical packager and streams verified R2 ZIP',async t=>{
  const h=await setup(t);await h.policy();
  const files={'worlds/demo/world.yaml':Buffer.from('schemaVersion: "1.0"\nid: demo\nversion: 1.0.0\nname: Demo\nsummary: A story\ndefaultLocale: en-US\nsupportedLocales: [en-US]\n'),'worlds/demo/WORLD.md':Buffer.from('# Demo\n'),'other-package/DO-NOT-INCLUDE.txt':Buffer.from('not this package')};
  const tree=Object.entries(files).map(([path,data])=>({path,type:'blob',mode:'100644',size:data.length,sha:createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')}));
  const blobs=new Map(tree.map(item=>[item.sha,files[item.path]]));
  const selected=entry({kind:'worlds',path:'worlds/demo',sourceTreeHash:fingerprintTree(tree,'worlds/demo')});
  await h.publish(catalog([selected],{kind:'worlds',topics:['covel-world']}));
  const detail=(await h.raw(`/v1/entries/${encodeURIComponent(selected.key)}`)).data;
  const request={key:selected.key,revisionId:detail.revisionId,idempotencyKey:'real-package-request-0001'};
  assert.equal((await h.raw('/v1/downloads','POST',request)).status,202);
  const claim=await h.client(secrets.RUNNER_TOKEN).json('/internal/claim',{data:{}});
  const cacheDir=await mkdtemp(path.join(os.tmpdir(),'covel-runner-'));
  const fetchImpl=async(url,init)=>{
    url=new URL(url);
    if(url.hostname==='api.covel.cc'){
      // The production gate enforces a one-second interval; this deterministic
      // transport fixture advances the gate without slowing down offline tests.
      if(url.pathname.endsWith('/github/reserve'))await h.unblockGitHub();
      return h.fetchImpl(url,init);
    }
    assert.equal(url.origin,'https://api.github.com');
    let value;
    if(url.pathname==='/repositories/42')value={id:42,full_name:'author/plugins',private:false,owner:{id:7}};
    else if(url.pathname.includes('/commits/'))value={sha:selected.commitSha,commit:{tree:{sha:'d'.repeat(40)}}};
    else if(url.pathname.includes('/git/trees/'))value={truncated:false,tree};
    else if(url.pathname.includes('/git/blobs/')){const data=blobs.get(url.pathname.split('/').at(-1));value={encoding:'base64',content:data.toString('base64'),size:data.length};}
    else assert.fail(`Unexpected GitHub route ${url.pathname}`);
    return Response.json(value);
  };
  await executeJob({url:'https://api.covel.cc',claim,githubToken:'test-only-not-a-secret',fetchImpl,cacheDir});
  await h.unblockGitHub();const ready=await h.raw('/v1/downloads','POST',request);assert.equal(ready.status,200,JSON.stringify(ready));
  await h.unblockGitHub();const response=await h.mf.dispatchFetch(ready.data.url),zip=Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(zip),ready.data.artifact.artifactSha256);
  const unpacked=unzipSync(zip);assert.deepEqual(Object.keys(unpacked).sort(),['WORLD.md','world.yaml']);
  assert.deepEqual(Buffer.from(unpacked['WORLD.md']),files['worlds/demo/WORLD.md']);
  assert.equal((await h.db.prepare('SELECT requests FROM counters').first()).requests,1);
});

test('collection runner resumes durable checkpoints and a lost shard acknowledgement without exposing a partial snapshot',async t=>{
  const h=await setup(t);await h.policy();const runner=h.client(secrets.RUNNER_TOKEN);
  await runner.json('/internal/enqueue-collection',{data:{kind:'worlds',round:'resume-test'}});
  let lease=await runner.json('/internal/claim',{data:{}}),lostAcknowledgement=false;
  const repo={id:42,full_name:'covel-ai/covel-worlds',name:'covel-worlds',private:false,disabled:false,archived:false,default_branch:'main',owner:{id:7,login:'covel-ai'},topics:['covel-world'],stargazers_count:1,license:{spdx_id:'MIT'}};
  const cacheDir=await mkdtemp(path.join(os.tmpdir(),'covel-collection-'));
  const fetchImpl=async(url,init)=>{
    url=new URL(url);
    if(url.hostname==='api.covel.cc'){
      if(url.pathname.endsWith('/github/reserve'))await h.unblockGitHub();
      const response=await h.fetchImpl(url,init);
      if(url.pathname.endsWith('/records/0')&&!lostAcknowledgement){lostAcknowledgement=true;await response.arrayBuffer();return Response.json({code:'simulated_ack_loss'},{status:503});}
      return response;
    }
    assert.equal(url.origin,'https://api.github.com');
    if(url.pathname==='/search/repositories')return Response.json({incomplete_results:false,total_count:1,items:[repo]});
    if(url.pathname==='/repositories/42'||url.pathname==='/repos/covel-ai/covel-worlds')return Response.json(repo);
    if(url.pathname.includes('/commits/'))return Response.json({sha:'a'.repeat(40),commit:{tree:{sha:'b'.repeat(40)}}});
    if(url.pathname.includes('/git/trees/'))return Response.json({truncated:false,tree:[]});
    assert.fail(`Unexpected GitHub route ${url.pathname}`);
  };
  await assert.rejects(executeJob({url:'https://api.covel.cc',claim:lease,fetchImpl,cacheDir}));
  assert.equal((await h.raw('/v1/catalog?kind=worlds')).status,503);
  assert.equal((await h.db.prepare('SELECT next_seq FROM snapshots').first()).next_seq,1);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM checkpoints').first()).n,2);
  await h.db.prepare("UPDATE jobs SET available=0 WHERE state='queued'").run();
  lease=await runner.json('/internal/claim',{data:{}});
  await executeJob({url:'https://api.covel.cc',claim:lease,fetchImpl,cacheDir});
  const published=await h.raw('/v1/catalog?kind=worlds');assert.equal(published.status,200);assert.equal(published.data.total,1);assert.equal(published.data.items[0].path,null);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM snapshots').first()).n,1);
  assert.equal((await h.db.prepare('SELECT state FROM jobs').first()).state,'done');
});
