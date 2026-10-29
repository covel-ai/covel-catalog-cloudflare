import { readFile } from 'node:fs/promises';
import { validatePolicy } from '@covel/catalog-kit/core';
import { apiClient } from './api.mjs';
const input=validatePolicy(JSON.parse(await readFile(process.argv[2]??'catalog/policy.json','utf8')));
const client=apiClient({url:process.env.CATALOG_API_URL,token:process.env.CATALOG_POLICY_TOKEN});
const result=await client.json('/admin/policy',{data:input});console.log(`Published policy sequence ${result.sequence}`);
