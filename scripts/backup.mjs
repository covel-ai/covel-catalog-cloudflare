import { spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@covel/catalog-kit/hash';

export const TABLES=['settings','snapshots','current_snapshots','ingest_locks','snapshot_entries','issues','revision_candidates','observation_candidates','binding_candidates','revisions','observations','tag_bindings','artifacts','policies','policy_rules','counters','tickets','download_requests','jobs','github_gate','dispatch_gate','object_reservations','checkpoints','prepared_artifacts','staged_membership','query_totals'];
function wrangler(args,{capture=false}={}) {
  const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:'inherit',maxBuffer:64*1024**2,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  if(result.status!==0)throw new Error('Wrangler operation failed; inspect the scoped CLI diagnostic');
  return result.stdout;
}
export async function verifyBackup(directory) {
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.files))throw new Error('Invalid backup manifest');
  for(const file of manifest.files){
    if(!/^(database\.sql|objects\/[a-f0-9]{64})$/.test(file.file))throw new Error('Unsafe backup path');
    const data=await readFile(path.join(directory,file.file));
    if(data.length!==file.size||sha256(data)!==file.sha256)throw new Error(`Backup integrity failure: ${file.file}`);
  }
  return manifest;
}
export async function createBackup(directory,{remote=false}={}) {
  await mkdir(directory);await mkdir(path.join(directory,'objects'));
  const location=remote?'--remote':'--local';
  const query=(command)=>JSON.parse(wrangler(['d1','execute','catalog',location,'--command',command,'--json'],{capture:true})).flatMap(r=>r.results??[]);
  if(query("SELECT value FROM settings WHERE key='maintenance'")[0]?.value!=='1')throw new Error('Set maintenance=1 before a coordinated database/object backup');
  if(query(`SELECT count(*) n FROM jobs WHERE state='running' AND lease_until>${Date.now()}`)[0]?.n)throw new Error('Wait for current runner leases to expire before backup');
  wrangler(['d1','export','catalog',location,'--no-schema','--output',path.join(directory,'database.sql'),'--table',...TABLES]);
  const objects=query("SELECT json_extract(data,'$.storageKey') key,sha256 digest FROM artifacts UNION SELECT object_key key,sha256 digest FROM checkpoints");
  const files=[];
  for(const object of objects){
    if(!/^(artifacts\/[a-f0-9]{64}\.zip|checkpoints\/(plugins|worlds)\/(round|releases)\/[a-f0-9]{64})$/.test(object.key))throw new Error('Invalid stored object path');
    const file=`objects/${sha256(object.key)}`;
    wrangler(['r2','object','get',`covel-catalog-private/${object.key}`,location,'--file',path.join(directory,file)]);
    const bytes=await readFile(path.join(directory,file));
    if(sha256(bytes)!==object.digest)throw new Error('Stored object checksum does not match its ledger');
    files.push({file,key:object.key,size:bytes.length,sha256:object.digest});
  }
  const database=await readFile(path.join(directory,'database.sql'));
  files.unshift({file:'database.sql',size:database.length,sha256:sha256(database)});
  const manifest={schemaVersion:1,createdAt:new Date().toISOString(),kit:JSON.parse(await readFile('catalog-kit.lock.json','utf8')).commit,files};
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');await verifyBackup(directory);return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [action,directory,flag]=process.argv.slice(2);
  if(!directory||!['create','verify'].includes(action)||flag&&flag!=='--remote')throw new Error('Usage: backup.mjs create|verify NEW_DIRECTORY [--remote]');
  const result=action==='verify'?await verifyBackup(directory):await createBackup(directory,{remote:flag==='--remote'});
  console.log(`Verified ${result.files.length} backup files`);
}
