import { spawnSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyBackup } from './backup.mjs';
import { apiClient } from './api.mjs';
import { searchGrams } from '../src/publication.mjs';

const [directory,flag]=process.argv.slice(2);
if(!directory||flag&&flag!=='--remote')throw new Error('Usage: restore.mjs BACKUP_DIRECTORY [--remote]');
const location=flag==='--remote'?'--remote':'--local';
const manifest=await verifyBackup(directory);
const cli=(args,capture=false)=>{
  const r=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:'inherit',maxBuffer:64*1024**2});
  if(r.status!==0)throw new Error('Recovery failed; keep maintenance enabled');return r.stdout;
};
const query=sql=>JSON.parse(cli(['d1','execute','catalog',location,'--command',sql,'--json'],true)).flatMap(r=>r.results??[]);
// Restoration only targets a freshly migrated, otherwise empty database.
if(query('SELECT count(*) n FROM snapshots')[0]?.n||query('SELECT count(*) n FROM tickets')[0]?.n)throw new Error('Restore requires an empty, freshly migrated target');
query("UPDATE settings SET value='1' WHERE key='maintenance'");
const recovery=apiClient({url:process.env.CATALOG_API_URL,token:process.env.CATALOG_OPS_TOKEN});
for(const file of manifest.files.filter(f=>f.key)){
  await recovery.json(`/admin/restore-object?key=${encodeURIComponent(file.key)}`,{method:'PUT',bytes:await readFile(path.join(directory,file.file)),headers:{'x-content-sha256':file.sha256}});
}
// Import immutable rows without re-running issuance triggers. Initial singleton
// rows are removed first because the verified export contains their real values.
query('DROP TRIGGER ticket_count; DELETE FROM settings; DELETE FROM github_gate; DELETE FROM dispatch_gate;');
cli(['d1','execute','catalog',location,'--file',path.join(directory,'database.sql'),'--yes']);
query("UPDATE settings SET value='1' WHERE key='maintenance'; UPDATE jobs SET lease_until=0,lease_hash=NULL WHERE state='running'; UPDATE github_gate SET lease_until=0,lease_hash=NULL; CREATE TRIGGER ticket_count AFTER INSERT ON tickets BEGIN INSERT INTO counters VALUES(new.entry_key,1) ON CONFLICT(entry_key) DO UPDATE SET requests=requests+1; END;");
// FTS is disposable; rebuild it from bounded pages, never from untrusted SQL.
let after=0;
for(;;){
  const rows=query(`SELECT rowid,kind,searchable FROM snapshot_entries WHERE rowid>${after} ORDER BY rowid LIMIT 100`);if(!rows.length)break;
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const sql=rows.map(r=>`INSERT INTO search_index(rowid,grams) VALUES(${r.rowid},${quote(`k${r.kind} ${searchGrams(r.searchable)}`)});`).join('\n');
  const file=path.join(directory,'reindex.sql');await writeFile(file,sql);cli(['d1','execute','catalog',location,'--file',file,'--yes']);after=rows.at(-1).rowid;
}
console.log('Restored D1 ledger and R2 bytes; maintenance remains enabled. Verify policy, counters and private object integrity before reopening.');
