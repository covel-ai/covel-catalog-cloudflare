import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const configuration=JSON.parse(await readFile('wrangler.jsonc','utf8'));
if(!process.env.CLOUDFLARE_ACCOUNT_ID||configuration.d1_databases[0].database_id==='00000000-0000-0000-0000-000000000000')throw new Error('Set the reviewed account and existing D1 database ID first; this command does not create or subscribe to resources');
const r=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy'],{stdio:'inherit'});process.exitCode=r.status??1;
