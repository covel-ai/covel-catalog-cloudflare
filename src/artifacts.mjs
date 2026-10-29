import { z } from 'zod';
import { fail } from '@covel/catalog-kit/core';
import { PACKAGER_VERSION } from '@covel/catalog-kit/hash';
import { first, run, statement as s, guard, batch, sizedStream } from './util.mjs';
import { leaseGuard,cacheIdentity } from './tasks.mjs';
export const artifactSchema=z.object({artifactSha256:z.string().regex(/^[a-f0-9]{64}$/),contentHash:z.string().regex(/^[a-f0-9]{64}$/),hashScheme:z.literal('covel-package-v1'),packagerVersion:z.literal(PACKAGER_VERSION),size:z.number().int().positive().max(20*1024*1024),filename:z.string().regex(/^[A-Za-z0-9._-]{1,180}\.zip$/),storageKey:z.string().optional()}).strict();
export function validateObject(object,artifact) {
  if(!object||object.size!==artifact.size||object.customMetadata?.sha256!==artifact.artifactSha256||!object.checksums?.sha256||Buffer.from(object.checksums.sha256).toString('hex')!==artifact.artifactSha256)fail(503,'artifact_corrupt','Private artifact integrity check failed');
}
export async function uploadArtifact(env,job,request,hash) {
  if(job.type!=='artifact'||!/^[a-f0-9]{64}$/.test(hash))fail(400,'invalid_upload','Invalid artifact task or digest');
  const size=Number(request.headers.get('content-length'));
  if(!Number.isSafeInteger(size)||size<1||size>20*1024*1024)fail(413,'artifact_limit','A bounded Content-Length is required');
  const key=`artifacts/${hash}.zip`,old=await env.BUCKET.head(key);
  if(old){validateObject(old,{size,artifactSha256:hash});return {storageKey:key,size};}
  await batch(env.DB,[leaseGuard(env.DB,job),
    guard(env.DB,'COALESCE((SELECT sum(bytes) FROM object_reservations),0)+?<=?',size,Number(env.MAX_ARTIFACT_BYTES??8*1024**3)),
    s(env.DB,'INSERT OR IGNORE INTO object_reservations VALUES(?,?,?)',key,size,Date.now())]);
  // R2 validates SHA-256 in the storage service while the Worker only streams.
  const object=await env.BUCKET.put(key,sizedStream(request,size),{sha256:hash,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/zip'},customMetadata:{sha256:hash}});
  validateObject(object??await env.BUCKET.head(key),{size,artifactSha256:hash});
  return {storageKey:key,size};
}
export async function attachArtifact(db,revision,artifact,policy,store,extra=[]) {
  if(revision.contentHash&&revision.contentHash!==artifact.contentHash)fail(409,'content_conflict','Artifact content differs from its revision');
  const old=await store.artifact(revision.revisionId,artifact.packagerVersion);
  if(old&&old.artifactSha256!==artifact.artifactSha256)fail(409,'artifact_conflict','Immutable artifact mapping already exists');
  await batch(db,[...extra,store.policyGuard(policy),
    guard(db,'NOT EXISTS(SELECT 1 FROM artifacts WHERE revision_id=? AND packager_version=? AND sha256<>?)',revision.revisionId,artifact.packagerVersion,artifact.artifactSha256),
    s(db,"UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='artifact_epoch'"),
    s(db,'INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?)',revision.revisionId,artifact.packagerVersion,artifact.artifactSha256,JSON.stringify(artifact),Date.now())]);
}
export async function completeArtifact(env,store,job,input) {
  if(job.type!=='artifact')fail(400,'wrong_task','This task cannot publish artifacts');
  const value=artifactSchema.parse(input),revision=await store.revision(JSON.parse(job.payload).entry.key,job.revision_id);
  if(revision.contentHash&&revision.contentHash!==value.contentHash)fail(409,'content_conflict','Content digest differs from the revision');
  const artifact={...value,storageKey:`artifacts/${value.artifactSha256}.zip`};
  validateObject(await env.BUCKET.head(artifact.storageKey),artifact);
  const policy=await store.allowed(revision.entry,artifact);
  await attachArtifact(env.DB,revision,artifact,policy,store,[leaseGuard(env.DB,job),
    guard(env.DB,'NOT EXISTS(SELECT 1 FROM prepared_artifacts WHERE cache_key=? AND data<>?)',job.id,JSON.stringify(artifact)),
    s(env.DB,'INSERT OR IGNORE INTO prepared_artifacts VALUES(?,?,?)',job.id,JSON.stringify(artifact),cacheIdentity(revision.entry)),
    s(env.DB,"UPDATE jobs SET state='done',finished=?,lease_hash=NULL,lease_until=0 WHERE id=?",Date.now(),job.id)]);
  return {state:'done'};
}
