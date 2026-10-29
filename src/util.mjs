import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { fail } from '@covel/catalog-kit/core';
export { sha256 } from '@covel/catalog-kit/hash';
export const token = () => randomBytes(32).toString('base64url');
export const parse = (row) => row ? JSON.parse(row.data) : null;
export const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
export const first = (db, sql, ...args) => statement(db, sql, ...args).first();
export const all = async (db, sql, ...args) => (await statement(db, sql, ...args).all()).results;
export const run = (db, sql, ...args) => statement(db, sql, ...args).run();
export const guard = (db, sql, ...args) => statement(db, `INSERT OR REPLACE INTO assertions VALUES(1,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`, ...args);
export async function batch(db, queries) {
  try { return await db.batch(queries); } catch (e) {
    if (String(e).includes('CHECK constraint failed')) fail(409, 'state_changed', 'State or lease changed; retry with the same request identity');
    throw e;
  }
}
export function authorize(request, expected) {
  const actual = request.headers.get('authorization') ?? '';
  if (typeof expected !== 'string' || expected.length < 32) fail(503, 'scope_unconfigured', 'This service scope has not been configured');
  const a = Buffer.from(actual), b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail(401, 'unauthorized', 'Valid scoped credentials are required');
}
export async function body(request, limit = 32768) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) fail(415, 'content_type', 'Expected application/json');
  const bytes = await bounded(request, limit);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'invalid_json', 'Invalid JSON body'); }
}
export async function bounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) fail(413, 'body_limit', 'Payload exceeds the endpoint limit');
  const reader = response.body?.getReader(); const parts = []; let size = 0;
  if (!reader) return new Uint8Array();
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > limit) { await reader.cancel(); fail(413, 'body_limit', 'Payload exceeds the endpoint limit'); } parts.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes;
}
export function sign(value, secret) {
  if (!secret || secret.length < 32) fail(503, 'signing_unconfigured', 'Signing credential is not configured');
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
export function unsign(value, secret) {
  if (typeof value !== 'string' || value.length > 4000) fail(400, 'invalid_cursor', 'Invalid cursor');
  const [data, sig, extra] = value.split('.');
  const expected = sign({}, secret).split('.')[1]; // validates configuration
  const actual = createHmac('sha256', secret).update(data ?? '').digest('base64url');
  if (extra || typeof sig !== 'string' || sig.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(sig))) fail(400, 'invalid_cursor', 'Invalid cursor signature');
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { fail(400, 'invalid_cursor', 'Invalid cursor payload'); }
}

// Native workerd stream enforces exact length without buffering the payload.
export function sizedStream(request,size) {
  const stream=new FixedLengthStream(size);
  request.body.pipeTo(stream.writable).catch(()=>{});
  return stream.readable;
}
