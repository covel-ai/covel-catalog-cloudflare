import { z } from 'zod';
import { entrySchema, issueSchema } from '@covel/catalog-kit/schema';
import { fail, identity, revisionIdentity, revisionRecord, revisionConflict, observedEntry, validateRelease, searchFields } from '@covel/catalog-kit/core';
import { first, all, statement as s, guard, batch, parse, sha256 } from './util.mjs';

export const ZERO = '0'.repeat(64);
const manifestSchema = z.object({
  kind: z.enum(['plugins','worlds']), generatedAt: z.iso.datetime(), mode: z.literal('github'), schemaVersion: z.literal(1),
  topics: z.array(z.string().regex(/^[a-z0-9-]{1,50}$/)).min(1).max(10),
  stats: z.object(Object.fromEntries(['repositories','entries','packages','indexed','pending','archived','issues'].map((k) => [k,z.number().int().min(0).max(100000)]))).strict(),
  releases: z.number().int().min(0).max(100000), chain: z.string().regex(/^[a-f0-9]{64}$/),
  allowEmpty: z.boolean().default(false)
}).strict();
export function searchGrams(text) {
  const chars = [...text.toLocaleLowerCase()], grams = new Set();
  for (let i=0; i<chars.length; i++) for (let n=1; n<=3 && i+n<=chars.length; n++) grams.add('g'+chars.slice(i,i+n).map((c) => c.codePointAt(0).toString(16)).join('x'));
  return [...grams].join(' ');
}
const leaseGuard = (db, pub, now) => guard(db, 'EXISTS(SELECT 1 FROM ingest_locks WHERE kind=? AND holder=? AND until_ms>?)', pub.kind,pub.id,now);
export async function beginPublication(db, input, kind, now=Date.now()) {
  const meta = manifestSchema.parse(input);
  if (meta.kind!==kind) fail(400,'kind_mismatch','Snapshot kind differs from its scope');
  const id = sha256(JSON.stringify({...meta,generatedAt:null}));
  const existing = await first(db,'SELECT * FROM snapshots WHERE id=?',id);
  if (existing?.state==='published') return {snapshotId:id,next:existing.next_seq,published:true,stats:parse(existing).stats};
  const current = await first(db,'SELECT s.* FROM snapshots s JOIN current_snapshots c ON c.snapshot_id=s.id WHERE c.kind=?',kind);
  if (current && meta.generatedAt<=current.generated) fail(409,'stale_snapshot','A newer complete snapshot already exists');
  if (current?.entries && !meta.stats.entries && !meta.allowEmpty) fail(409,'empty_snapshot','Empty replacement needs explicit acknowledgement');
  now=Math.max(now,(current?.created??0)+1);
  const data = JSON.stringify({...meta,metricsSnapshot:new Date(now).toISOString(),snapshotId:id});
  await batch(db,[
    s(db,`INSERT INTO ingest_locks VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET holder=excluded.holder,until_ms=excluded.until_ms WHERE ingest_locks.until_ms<=? OR ingest_locks.holder=excluded.holder`,kind,id,now+120000,now),
    guard(db,'EXISTS(SELECT 1 FROM ingest_locks WHERE kind=? AND holder=?)',kind,id),
    s(db,`INSERT OR IGNORE INTO snapshots(id,kind,state,base_id,created,generated,data,expected_count,expected_chain,chain) VALUES(?,?,'staging',?,?,?,?,?,?,?)`,id,kind,current?.id??null,now,meta.generatedAt,data,meta.stats.entries+meta.stats.issues+meta.releases,meta.chain,ZERO)
  ]);
  return {snapshotId:id,next:existing?.next_seq??0,published:false};
}
export async function appendRecord(db,id,seq,input,kind,now=Date.now(),extra=[]) {
  const pub = await first(db,'SELECT * FROM snapshots WHERE id=? AND kind=?',id,kind);
  if (!pub || pub.state!=='staging') fail(409,'publication_closed','No writable staged snapshot');
  if (!Number.isSafeInteger(seq) || seq!==pub.next_seq) fail(409,'record_sequence','Resume from the stored next record');
  const meta=parse(pub), statements=[...extra,leaseGuard(db,pub,now),guard(db,'EXISTS(SELECT 1 FROM snapshots WHERE id=? AND next_seq=?)',id,seq)];
  const serialized=JSON.stringify(input), chain=sha256(`${pub.chain}\n${serialized}`);
  let field;
  if (seq<meta.stats.entries+meta.releases) {
    const release=seq>=meta.stats.entries;
    if (input.type!==(release?'release':'entry')) fail(400,'record_order','Entries must precede releases and issues');
    let entry=entrySchema.parse(input.value),old,oldActive=false;
    if(entry.kind!==kind || entry.repositoryId===null || entry.discovery==='local') fail(400,'invalid_entry','Production entry identity is required');
    if(release) validateRelease(entry,parse(await first(db,`SELECT e.data FROM snapshot_entries e JOIN snapshots p ON p.id=e.snapshot_id WHERE e.key=? AND EXISTS(SELECT 1 FROM staged_membership WHERE snapshot_id=? AND key=e.key) AND (e.snapshot_id=? OR (p.state='published' AND e.end_generation=9007199254740991)) ORDER BY e.generation DESC LIMIT 1`,entry.key,id,id)),kind);
    else {
      const oldRow=await first(db,`SELECT e.data,e.end_generation FROM snapshot_entries e JOIN snapshots p ON p.id=e.snapshot_id WHERE e.key=? AND p.state='published' ORDER BY e.generation DESC LIMIT 1`,entry.key);
      old=parse(oldRow);oldActive=oldRow?.end_generation===9007199254740991;
      const counter=await first(db,'SELECT requests FROM counters WHERE entry_key=?',entry.key);
      entry=observedEntry(entry,old,counter?.requests??0,parse(pub).metricsSnapshot);
    }
    const ident=revisionIdentity(entry); let conflict=false;
    if(ident) {
      if(ident.channel==='release') {
        const other=await first(db,`SELECT id FROM revisions WHERE entry_key=? AND version=? AND channel='release' AND source_hash<>?
          UNION ALL SELECT id FROM revision_candidates WHERE snapshot_id=? AND entry_key=? AND version=? AND channel='release' AND source_hash<>? LIMIT 1`,entry.key,entry.version,identity(entry),id,entry.key,entry.version,identity(entry));
        const bound=await first(db,`SELECT commit_sha FROM tag_bindings WHERE entry_key=? AND tag=? UNION ALL SELECT commit_sha FROM binding_candidates WHERE snapshot_id=? AND entry_key=? AND tag=? LIMIT 1`,entry.key,entry.sourceRef.name,id,entry.key,entry.sourceRef.name);
        conflict=revisionConflict(entry,other,bound?.commit_sha);
        statements.push(s(db,'INSERT OR IGNORE INTO binding_candidates VALUES(?,?,?,?)',id,entry.key,entry.sourceRef.name,entry.commitSha));
      }
      const revision=revisionRecord(entry,conflict,pub.created);
      statements.push(s(db,`INSERT OR IGNORE INTO revision_candidates VALUES(?,?,?,?,?,?,?,?,?)`,id,ident.id,entry.key,entry.version,ident.channel,identity(entry),Number(conflict),pub.created,JSON.stringify(revision)));
      const observation={entryKey:entry.key,sourceRef:entry.sourceRef,commitSha:entry.commitSha,observedAt:entry.fetchedAt,conflict};
      statements.push(s(db,'INSERT OR IGNORE INTO observation_candidates VALUES(?,?,?,?)',id,sha256(JSON.stringify([entry.key,entry.sourceRef,entry.commitSha])),ident.id,JSON.stringify(observation)));
    }
    if(!release) {
      entry={...entry,revisionId:ident?.id??null,...(conflict?{status:'pending',problems:[...entry.problems,'version-conflict']}: {})};
      statements.push(s(db,'INSERT INTO staged_membership VALUES(?,?,?,?,?)',id,entry.key,entry.repositoryId,Number(entry.path!==null),entry.status));
      // Reuse an unchanged indexed row across snapshots. Observation timestamps
      // remain in the append-only ledger; fetchedAt on this row is its last change.
      const comparable=({fetchedAt,...value})=>JSON.stringify(value);
      if(!oldActive||!old||comparable(old)!==comparable(entry)) {
      const {names,all:searchable}=searchFields(entry);
      const summary={...entry,description:entry.description.slice(0,500)};
      // Never put detail translations/diagnostics into a 24-item list payload.
      summary.translations=Object.fromEntries(Object.entries(entry.translations).map(([l,v])=>[l,{name:v.name,description:v.description?.slice(0,500)}]));
      statements.push(s(db,`INSERT INTO snapshot_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,entry.key,pub.created,9007199254740991,entry.revisionId,JSON.stringify(entry),JSON.stringify(summary),kind,entry.repositoryId,entry.ownerId,entry.path,entry.commitSha,entry.contentHash,entry.name.toLocaleLowerCase(),entry.id.toLocaleLowerCase(),names,searchable,entry.status,Number(entry.official),entry.category,JSON.stringify(entry.locales),entry.releasePublishedAt??entry.contentChangedAt??entry.firstSeenAt??'',entry.stars??-1,entry.downloadRequests??-1));
      statements.push(s(db,'INSERT INTO search_index(rowid,grams) SELECT rowid,? FROM snapshot_entries WHERE snapshot_id=? AND key=?',`k${kind} ${searchGrams(searchable)}`,id,entry.key));
      }
    }
    field=release?'releases':'entries';
  } else {
    if(input.type!=='issue' || seq>=pub.expected_count) fail(400,'record_order','Unexpected snapshot record');
    const issue=issueSchema.parse(input.value);
    statements.push(s(db,'INSERT INTO issues VALUES(?,?,?)',id,seq,JSON.stringify(issue))); field='issues';
  }
  statements.push(s(db,`UPDATE snapshots SET next_seq=next_seq+1,chain=?,${field}=${field}+1 WHERE id=?`,chain,id));
  statements.push(s(db,'UPDATE ingest_locks SET until_ms=? WHERE kind=? AND holder=?',now+120000,kind,id));
  await batch(db,statements);
  return {snapshotId:id,next:seq+1};
}
export async function finishPublication(db,id,kind,now=Date.now(),extra=[]) {
  const pub=await first(db,'SELECT * FROM snapshots WHERE id=? AND kind=?',id,kind);
  if(!pub) fail(404,'snapshot_missing','Unknown snapshot');
  const meta=parse(pub);
  if(pub.state==='published') return {snapshotId:id,stats:meta.stats};
  const stats=await first(db,`SELECT count(DISTINCT repository_id) repositories,count(*) entries,sum(package) packages,sum(status='indexed') AS "indexed",sum(status='pending') pending,sum(status='archived') archived FROM staged_membership WHERE snapshot_id=?`,id);
  // Input metadata stats were validated at collection. Conflicts can turn indexed into pending.
  if(stats.entries!==meta.stats.entries || stats.repositories!==meta.stats.repositories || (stats.packages??0)!==meta.stats.packages) fail(400,'stats_mismatch','Staged snapshot statistics differ from the manifest');
  const outputStats={...stats,packages:stats.packages??0,indexed:stats.indexed??0,pending:stats.pending??0,archived:stats.archived??0,issues:pub.issues};
  await batch(db,[...extra,leaseGuard(db,pub,now),
    guard(db,`EXISTS(SELECT 1 FROM snapshots WHERE id=? AND next_seq=expected_count AND chain=expected_chain AND entries=? AND releases=? AND issues=?)`,id,meta.stats.entries,meta.releases,meta.stats.issues),
    guard(db,`(SELECT snapshot_id FROM current_snapshots WHERE kind=?) IS ?`,kind,pub.base_id),
    s(db,`INSERT OR IGNORE INTO revisions SELECT id,entry_key,version,channel,source_hash,conflict,created,data FROM revision_candidates WHERE snapshot_id=?`,id),
    s(db,`INSERT OR IGNORE INTO observations SELECT id,revision_id,data FROM observation_candidates WHERE snapshot_id=?`,id),
    s(db,`INSERT OR IGNORE INTO tag_bindings SELECT entry_key,tag,commit_sha FROM binding_candidates WHERE snapshot_id=?`,id),
    s(db,`UPDATE snapshot_entries SET end_generation=? WHERE kind=? AND end_generation=9007199254740991 AND snapshot_id<>? AND snapshot_id IN (SELECT id FROM snapshots WHERE state='published') AND (key NOT IN (SELECT key FROM staged_membership WHERE snapshot_id=?) OR key IN (SELECT key FROM snapshot_entries WHERE snapshot_id=?))`,pub.created,kind,id,id,id),
    s(db,`UPDATE snapshots SET state='published',data=? WHERE id=?`,JSON.stringify({...meta,stats:outputStats}),id),
    s(db,`INSERT INTO current_snapshots VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET snapshot_id=excluded.snapshot_id`,kind,id),
    s(db,'DELETE FROM ingest_locks WHERE kind=? AND holder=?',kind,id),
    ...['staged_membership','revision_candidates','observation_candidates','binding_candidates'].map((table)=>s(db,`DELETE FROM ${table} WHERE snapshot_id=?`,id))
  ]);
  return {snapshotId:id,stats:outputStats};
}
