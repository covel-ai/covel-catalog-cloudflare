import { kitCli } from '../vendor/catalog-kit/tools/sync.mjs';
await kitCli(process.argv.slice(2), process.cwd());
