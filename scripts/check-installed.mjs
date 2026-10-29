import { readFile,readdir,lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const lock=JSON.parse(await readFile('catalog-kit.lock.json','utf8')),root='node_modules/@covel/catalog-kit',seen=[];
async function walk(dir){for(const item of await readdir(path.join(root,dir),{withFileTypes:true})){const name=path.posix.join(dir,item.name);if(item.isSymbolicLink())throw new Error(`Linked installed kit file: ${name}`);if(item.isDirectory())await walk(name);else seen.push(name);}}
await walk('');
if(seen.length!==Object.keys(lock.files).length)throw new Error('Installed kit file set differs from its complete manifest');
for(const file of seen){if(createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')!==lock.files[file])throw new Error(`Installed kit drift: ${file}`);}
console.log(`Verified ${seen.length} installed kit files at ${lock.commit}`);
