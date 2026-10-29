import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,entry,catalog } from './helpers.mjs';

test('100/1000/10000-entry indexed fixture retains a 24-summary payload and caches aggregate queries',async t=>{
  const h=await setup(t);await h.policy();const receipt=await h.publish(catalog());
  const columns=(await h.db.prepare('PRAGMA table_info(snapshot_entries)').all()).results.map(r=>r.name);
  const base=await h.db.prepare('SELECT * FROM snapshot_entries LIMIT 1').first();let previous=1;
  for(const size of [100,1000,10000]){
    for(let offset=previous;offset<size;offset+=100){
      const ids=Array.from({length:Math.min(100,size-offset)},(_,i)=>offset+i);
      const select=columns.map(c=>c==='key'?"'github:42:plugins:package:p'||j.value":c==='data'||c==='summary'?`json_set(e.${c},'$.key','github:42:plugins:package:p'||j.value,'$.id','p'||j.value,'$.name','Package '||j.value)`:c==='name'?"'Package '||j.value":c==='stars'?'j.value':`e.${c}`).join(',');
      await h.db.prepare(`INSERT INTO snapshot_entries(${columns.join(',')}) SELECT ${select} FROM snapshot_entries e,json_each(?) j WHERE e.rowid=1`).bind(JSON.stringify(ids)).run();
    }
    await h.db.prepare('DELETE FROM query_totals').run();
    let started=performance.now();const first=await h.mf.dispatchFetch('https://api.covel.cc/v1/catalog?sort=stars');const text=await first.text();const elapsed=performance.now()-started;
    const value=JSON.parse(text);assert.equal(first.status,200);assert.equal(value.total,size);assert.equal(value.items.length,24);assert.ok(Buffer.byteLength(text)<65000);
    started=performance.now();const second=await h.mf.dispatchFetch('https://api.covel.cc/v1/catalog?sort=stars');await second.arrayBuffer();
    t.diagnostic(JSON.stringify({entries:size,pageBytes:Buffer.byteLength(text),coldWallMs:Math.round(elapsed),warmWallMs:Math.round(performance.now()-started)}));
    assert.equal((await h.db.prepare('SELECT count(*) n FROM query_totals').first()).n,1);
    previous=size;
  }
});
