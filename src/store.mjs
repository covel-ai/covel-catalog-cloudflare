import { fail, ruleFor, validatePolicy, queryOptions, selectUpdate } from '@covel/catalog-kit/core';
import { PACKAGER_VERSION } from '@covel/catalog-kit/hash';
import { first, all, run, statement as s, guard, batch, parse, sha256, token, sign, unsign } from './util.mjs';

export class Store {
  constructor(db,secret,now=()=>Date.now()) { this.db=db;this.secret=secret;this.now=now; }
  async policy() {
    const row=await first(this.db,'SELECT * FROM policies ORDER BY sequence DESC LIMIT 1');
    if(!row || row.expires<=this.now()) fail(503,'policy_unavailable','Current directory policy is unavailable or expired');
    return parse(row);
  }
  async publishPolicy(input) {
    const p=validatePolicy(input,this.now());
    // Small-user service bound keeps validation within the free CPU budget.
    if(p.rules.length>100) fail(413,'policy_limit','This deployment supports at most 100 active rules per policy');
    const data=JSON.stringify(p),last=await first(this.db,'SELECT * FROM policies ORDER BY sequence DESC LIMIT 1');
    if(last?.sequence===p.sequence && last.data===data) return p;
    await batch(this.db,[guard(this.db,'COALESCE((SELECT max(sequence) FROM policies),0)<?',p.sequence),
      s(this.db,'INSERT INTO policies VALUES(?,?,?)',p.sequence,data,Date.parse(p.expiresAt)),
      s(this.db,`INSERT INTO policy_rules SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.repositoryId'),json_extract(value,'$.ownerId'),json_extract(value,'$.path'),json_extract(value,'$.commitSha'),json_extract(value,'$.contentHash'),json_extract(value,'$.artifactSha256'),json_extract(value,'$.reason') FROM json_each(?,'$.rules')`,p.sequence,data)]);
    return p;
  }
  policyGuard(policy) {return guard(this.db,'EXISTS(SELECT 1 FROM policies WHERE sequence=(SELECT max(sequence) FROM policies) AND sequence=? AND expires>?)',policy.sequence,this.now());}
  async allowed(entry,artifact,policy=undefined) {
    const p=policy??await this.policy(),r=ruleFor(entry,artifact,p);if(r) fail(410,'withdrawn',r.reason);return p;
  }
  async current(key) { return parse(await first(this.db,`SELECT e.data FROM snapshot_entries e JOIN snapshots p ON p.id=e.snapshot_id JOIN current_snapshots c ON c.kind=e.kind JOIN snapshots live ON live.id=c.snapshot_id WHERE e.key=? AND p.state='published' AND e.generation<=live.created AND e.end_generation>live.created`,key)); }
  async artifact(id,version=undefined) {return parse(await first(this.db,`SELECT data FROM artifacts WHERE revision_id=? ${version?'AND packager_version=?':''} ORDER BY created DESC,rowid DESC LIMIT 1`,id,...(version?[version]:[])));}
  async detail(key) {
    const entry=await this.current(key); if(!entry) fail(404,'entry_not_found','This package is no longer listed');
    const p=await this.policy(),a=await this.artifact(entry.revisionId),r=ruleFor(entry,a,p);
    const counter=await first(this.db,'SELECT requests FROM counters WHERE entry_key=?',key);
    return {...entry,blocked:Boolean(r),policyReason:r?.reason??null,downloadRequests:counter?.requests??0};
  }
  async revision(key,id) {
    const currentRow=await first(this.db,`SELECT e.data,c.snapshot_id FROM snapshot_entries e JOIN snapshots p ON p.id=e.snapshot_id JOIN current_snapshots c ON c.kind=e.kind JOIN snapshots live ON live.id=c.snapshot_id WHERE e.key=? AND p.state='published' AND e.generation<=live.created AND e.end_generation>live.created`,key);
    const current=parse(currentRow);if(!current) fail(404,'entry_not_found','This package is no longer listed');
    if(current.status==='archived'||current.path===null) fail(409,'not_distributable','Package is archived or has no package path');
    const revision=parse(await first(this.db,'SELECT data FROM revisions WHERE id=? AND entry_key=?',id??current.revisionId,key));
    if(!revision) fail(404,'revision_not_found','Version is unavailable');
    if(revision.conflict) fail(409,'version_conflict','This revision conflicts with a published version');
    if(revision.entry.status!=='indexed') fail(409,'not_distributable','Revision metadata is incomplete');
    revision.entry={...revision.entry,ownerId:current.ownerId,repository:current.repository,repositoryUrl:current.repositoryUrl};
    await this.allowed(revision.entry);
    return {...revision,_snapshotId:currentRow.snapshot_id};
  }
  async versions(key) {
    const current=await this.detail(key),policy=await this.policy();
    const rows=await all(this.db,`SELECT r.data,
      (SELECT json_group_array(json(data)) FROM (SELECT data FROM artifacts WHERE revision_id=r.id ORDER BY created DESC LIMIT 10)) artifacts,
      (SELECT json_group_array(json(data)) FROM (SELECT data FROM observations WHERE revision_id=r.id ORDER BY rowid DESC LIMIT 200)) observations
      FROM revisions r WHERE entry_key=? ORDER BY created DESC,id LIMIT 200`,key);
    return rows.map((row)=>{
      const r=parse(row),artifacts=JSON.parse(row.artifacts),a=artifacts[0],{covelVersion,license,readmeUrl,status}=r.entry;
      return {...r,entry:undefined,contentHash:a?.contentHash??r.contentHash,hashScheme:a?.hashScheme??r.hashScheme,
        metadata:{covelVersion,license,readmeUrl,status},blocked:Boolean(ruleFor({...r.entry,ownerId:current.ownerId},a,policy)),
        artifacts:artifacts.map(({storageKey,...a})=>a),observations:JSON.parse(row.observations)};
    });
  }
  async list(input) {
    const opts=queryOptions(input),policy=await this.policy(),queryHash=sha256(JSON.stringify({queryVersion:2,...opts}));
    const cursor=input.cursor?unsign(input.cursor,this.secret):null;
    if(cursor?.expires<=this.now()) fail(409,'cursor_expired','This result page expired; restart search');
    if(cursor&&(cursor.queryHash!==queryHash||cursor.policy!==policy.sequence)) fail(409,'cursor_changed','Search or policy changed; restart search');
    const snapshot=cursor?await first(this.db,"SELECT * FROM snapshots WHERE id=? AND state='published' AND kind=?",cursor.snapshot,opts.kind):await first(this.db,'SELECT s.* FROM snapshots s JOIN current_snapshots c ON c.snapshot_id=s.id WHERE c.kind=?',opts.kind);
    if(!snapshot) fail(503,'catalog_unavailable','No complete catalog has been published');
    const meta=parse(snapshot),where=["e.kind=? AND e.generation<=? AND e.end_generation>? AND origin.state='published'"],args=[opts.kind,snapshot.created,snapshot.created];
    const words=[...new Set(opts.q.split(/\s+/).filter(Boolean))];
    if(words.length>20)fail(400,'query_limit','Use at most 20 search terms');
    if(words.length) {
      // Use exact Unicode character grams; the instr predicate verifies complete words.
      const grams=words.map((w)=>'g'+[...w].slice(0,3).map(c=>c.codePointAt(0).toString(16)).join('x'));
      where.push('e.rowid IN (SELECT rowid FROM search_index WHERE search_index MATCH ?)');args.push(`k${opts.kind} AND ${grams.join(' AND ')}`);
      for(const w of words){where.push('instr(e.searchable,?)>0');args.push(w);}
    }
    where.push(opts.status==='all'?"e.status<>'archived'":'e.status=?');if(opts.status!=='all')args.push(opts.status);
    if(opts.source!=='all'){where.push('e.official=?');args.push(Number(opts.source==='official'));}
    if(opts.category!=='all'){where.push('e.category=?');args.push(opts.category);}
    if(opts.locale!=='all'){where.push('EXISTS(SELECT 1 FROM json_each(e.locales) WHERE value=?)');args.push(opts.locale);}
    const gate=`NOT EXISTS(SELECT 1 FROM policy_rules p WHERE p.sequence=? AND (p.kind IS NULL OR p.kind=e.kind) AND (p.repository_id IS NULL OR p.repository_id=e.repository_id) AND (p.owner_id IS NULL OR p.owner_id=e.owner_id) AND (p.path IS NULL OR p.path=e.path) AND (p.commit_sha IS NULL OR p.commit_sha=e.commit_sha) AND (p.content_hash IS NULL OR p.content_hash=COALESCE(json_extract(a.data,'$.contentHash'),e.content_hash)) AND (p.artifact_sha IS NULL OR p.artifact_sha=a.sha256))`;
    where.push(gate);args.push(policy.sequence);
    const queryIndex=words.length?'':` INDEXED BY ${{name:'entries_name',stars:'entries_stars',downloads:'entries_downloads'}[opts.sort]??'entries_updated'}`;
    const joins=`FROM snapshot_entries e${queryIndex} JOIN snapshots origin ON origin.id=e.snapshot_id LEFT JOIN artifacts a ON a.rowid=(SELECT rowid FROM artifacts WHERE revision_id=e.revision_id ORDER BY created DESC,rowid DESC LIMIT 1)`;
    let sort=opts.sort==='name'?'e.name':opts.sort==='stars'?'e.stars':opts.sort==='downloads'?'e.downloads':'e.updated';
    let scoreArgs=[];
    if(opts.sort==='relevance'&&words.length){sort=`(CASE WHEN e.package_id=? THEN 100 ELSE 0 END${words.map(()=>'+CASE WHEN instr(e.names,?)>0 THEN 10 ELSE 1 END').join('')})`;scoreArgs=[opts.q,...words];}
    const ascending=opts.sort==='name',comparison=ascending?'>':'<',direction=ascending?'ASC':'DESC';
    const pageArgs=[...scoreArgs,...args];let after='';
    if(cursor){after=`WHERE (sort_value ${comparison} ? OR (sort_value=? AND key>?))`;pageArgs.push(cursor.last,cursor.last,cursor.key);}
    const page=s(this.db,`WITH matched AS (SELECT e.summary,e.key,${sort} sort_value ${joins} WHERE ${where.join(' AND ')}) SELECT * FROM matched ${after} ORDER BY sort_value ${direction},key LIMIT ?`,...pageArgs,opts.limit+1);
    const epoch=await first(this.db,"SELECT value FROM settings WHERE key='artifact_epoch'");
    const totalsKey=sha256(JSON.stringify([snapshot.id,policy.sequence,epoch.value,{...opts,limit:0,sort:''}]));
    const cached=parse(await first(this.db,'SELECT data FROM query_totals WHERE key=?',totalsKey));
    const queries=[this.policyGuard(policy),page];
    if(!cached)queries.push(
      s(this.db,`SELECT count(*) total ${joins} WHERE ${where.join(' AND ')}`,...args),
      s(this.db,`SELECT DISTINCT e.category ${joins} WHERE e.kind=? AND e.generation<=? AND e.end_generation>? AND origin.state='published' AND ${gate} ORDER BY e.category`,opts.kind,snapshot.created,snapshot.created,policy.sequence),
      s(this.db,`SELECT DISTINCT j.value locale ${joins},json_each(e.locales) j WHERE e.kind=? AND e.generation<=? AND e.end_generation>? AND origin.state='published' AND ${gate} ORDER BY j.value`,opts.kind,snapshot.created,snapshot.created,policy.sequence));
    const [,_page,_count,_cats,_locales]=await batch(this.db,queries);
    const totals=cached??{total:_count.results[0].total,facets:{categories:_cats.results.map(r=>r.category),locales:_locales.results.map(r=>r.locale)}};
    if(!cached)await run(this.db,'INSERT OR IGNORE INTO query_totals VALUES(?,?,?)',totalsKey,JSON.stringify(totals),this.now());
    const rows=_page.results,more=rows.length>opts.limit,items=rows.slice(0,opts.limit),last=items.at(-1);
    return {schemaVersion:1,kind:opts.kind,snapshotId:snapshot.id,metricsSnapshot:meta.metricsSnapshot,generatedAt:meta.generatedAt,mode:meta.mode,topics:meta.topics,
      items:items.map(r=>JSON.parse(r.summary)),total:totals.total,policyVersion:policy.version,
      nextCursor:more?sign({snapshot:snapshot.id,policy:policy.sequence,queryHash,last:last.sort_value,key:last.key,expires:cursor?.expires??this.now()+1800000},this.secret):null,
      facets:totals.facets};
  }
  async bindRequest(key,id,requestKey) {
    await run(this.db,'INSERT OR IGNORE INTO download_requests VALUES(?,?,?,?)',requestKey,key,id,this.now());
    const r=await first(this.db,'SELECT * FROM download_requests WHERE request_key=?',requestKey);
    if(r.entry_key!==key||r.revision_id!==id)fail(409,'idempotency_conflict','Request key was already used for another version');
  }
  async issueTicket(key,id,artifact,requestKey) {
    const revision=await this.revision(key,id),p=await this.allowed(revision.entry,artifact);
    await batch(this.db,[this.policyGuard(p),guard(this.db,'EXISTS(SELECT 1 FROM current_snapshots WHERE snapshot_id=?)',revision._snapshotId),
      s(this.db,'INSERT OR IGNORE INTO tickets VALUES(?,?,?,?,?,?)',token(),requestKey,key,id,artifact.packagerVersion,this.now()+900000)]);
    const ticket=await first(this.db,'SELECT * FROM tickets WHERE request_key=?',requestKey);
    if(ticket.entry_key!==key||ticket.revision_id!==id) fail(409,'idempotency_conflict','Request key was already used for another version');
    if(ticket.expires<=this.now()) fail(409,'request_expired','This request expired; start a new request');
    const original=await this.artifact(id,ticket.packager_version);await this.allowed(revision.entry,original);
    return {ticket,artifact:original};
  }
  async redeem(value) {
    const ticket=await first(this.db,'SELECT * FROM tickets WHERE token=?',value);
    if(!ticket||ticket.expires<=this.now())fail(410,'ticket_expired','Ticket is invalid or expired');
    const revision=await this.revision(ticket.entry_key,ticket.revision_id),artifact=await this.artifact(ticket.revision_id,ticket.packager_version);
    if(!artifact)fail(503,'artifact_missing','Artifact is unavailable');await this.allowed(revision.entry,artifact);
    return {ticket,revision,artifact};
  }
  async checkUpdate(lock,options) {
    const current=await this.detail(lock.entryKey);
    if(current.status!=='indexed')return {state:'blocked',reason:current.status==='archived'?'archived':'pending-metadata'};
    if(options.locallyModified)return {state:'blocked',reason:'local-changes'};
    if(lock.hashScheme!=='covel-package-v1')return {state:'unknown',reason:'hash-scheme-mismatch'};
    const installed=parse(await first(this.db,'SELECT data FROM revisions WHERE id=? AND entry_key=?',lock.revisionId,lock.entryKey));
    const artifact=parse(await first(this.db,'SELECT data FROM artifacts WHERE revision_id=? AND sha256=?',lock.revisionId,lock.artifactSha256));
    if(!installed||!artifact||artifact.contentHash!==lock.contentHash)return {state:'unknown',reason:'unverified-source'};
    const policy=await this.allowed({...installed.entry,ownerId:current.ownerId},artifact);
    if(lock.updatePolicy==='pinned')return {state:'pinned'};
    const rows=await all(this.db,`SELECT r.data,(SELECT data FROM artifacts WHERE revision_id=r.id ORDER BY created DESC,rowid DESC LIMIT 1) artifact FROM revisions r WHERE entry_key=? ORDER BY created DESC LIMIT 201`,lock.entryKey);
    if(rows.length>200)return {state:'unknown',reason:'history-limit'};
    return selectUpdate({lock,current,installed,revisions:rows.map(parse),artifacts:new Map(rows.map(r=>[parse(r).revisionId,r.artifact?JSON.parse(r.artifact):null])),policy,...options});
  }
}
