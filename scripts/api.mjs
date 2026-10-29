import { sha256 } from '@covel/catalog-kit/hash';
export function apiClient({url,token,fetchImpl=fetch}) {
  const base=new URL(url);
  if(base.pathname!=='/'||base.username||base.password||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname)))throw new Error('Expected HTTPS API origin');
  const request=async(path,{method='POST',data,bytes,headers={}}={})=>{
    const body=bytes??(data===undefined?undefined:JSON.stringify(data));
    const response=await fetchImpl(`${base.origin}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:`Bearer ${token}`,...(data===undefined?{}:{'Content-Type':'application/json'}),...(body===undefined?{}:{'Content-Length':String(Buffer.byteLength(body))}),...headers},body});
    if(!response.ok){const error=new Error(`Catalog API ${response.status}`);error.status=response.status;error.code=(await response.json().catch(()=>null))?.code;throw error;}
    return response;
  };
  const json=async(path,options)=>(await request(path,options)).json();
  return {request,json};
}
export function remoteCheckpoint(client,path) {
  return {
    async load(){const response=await client.request(path,{method:'GET'}),text=await response.text();const expected=response.headers.get('x-content-sha256');if(expected&&sha256(text)!==expected)throw new Error('Checkpoint digest mismatch');return JSON.parse(text)??undefined;},
    async save(value){const bytes=Buffer.from(JSON.stringify(value));await client.json(path,{method:'PUT',bytes,headers:{'Content-Type':'application/json','x-content-sha256':sha256(bytes)}});}
  };
}
