import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const source=readFileSync(new URL('../linux-api.js',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const checksum=async arr=>Buffer.from(await crypto.subtle.digest('SHA-256',arr)).toString('hex');

test('Spine website client submits SHA-checked ZIP and verifies returned native ZIP',async()=>{
  const original=globalThis.fetch;
  const uploaded=[];
  const input=new Uint8Array(60);input.set([80,75,3,4]);input.fill(15,4);
  const native=new Uint8Array(90);native.set([80,75,3,4]);native.fill(31,4);
  const id='89b67ac5-3d5b-4887-99ae-838ecc7c7e77';
  const jobs=[];
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(url).pathname;
    const headers=init.headers||{};
    const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    jobs.push([init.method||'GET',path]);
    if(path==='/v2/sessions'&&init.method==='POST'){
      assert.equal(JSON.parse(init.body).mode,'mask');
      return new Response(JSON.stringify({id,uploadToken:'upload-only-token',resultToken:'read-only-token',
        partBytes:4194304,maxParts:16,maxBytes:67108864}),{status:201,headers:{'Content-Type':'application/json'}});
    }
    if(path.endsWith('/input/0')){
      assert.equal(headers.Authorization,'Bearer upload-only-token');
      const b=new Uint8Array(init.body);
      assert.equal(headers['X-Chunk-SHA256'],await checksum(b));
      uploaded.push(b);
      return new Response(JSON.stringify({part:0,bytes:b.length}),{status:202,headers:{'Content-Type':'application/json'}});
    }
    if(path.endsWith('/commit')){
      const meta=JSON.parse(init.body);
      assert.equal(meta.sha256,await checksum(input));
      assert.equal(meta.parts,1);
      return new Response(JSON.stringify({status:'queued'}),{status:202,headers:{'Content-Type':'application/json'}});
    }
    if(path.endsWith('/status')){
      assert.equal(headers.Authorization,'Bearer read-only-token');
      const inputSha256=await checksum(input),outputSha256=await checksum(native);
      return json({status:'ready',size:native.length,parts:1,sha256:outputSha256,inputSha256,
        receipt:{mode:'mask',spineVersion:'4.3.26',sourceSha256:inputSha256,inputSha256,resultSha256:outputSha256,
          nativeImportVerified:true,nativeExportVerified:true,animationsPreserved:true,
          clippingAttachments:1,originalAssetsRetained:3,vertices:12}});
    }
    if(path.endsWith('/result/0')){
      assert.equal(headers.Authorization,'Bearer read-only-token');
      return new Response(native,{status:200,headers:{'Content-Type':'application/octet-stream'}});
    }
    if(path.endsWith('/'+id)&&init.method==='DELETE')return json({status:'deleted'});
    throw Error('Unexpected API request '+path);
  };
  try{
    const job=await api.submitSpineProject(input,'my-project.zip');
    assert.equal(job.inputSha256,await checksum(input));
    const result=await api.pollSpineResult(job);
    assert.deepEqual(result.bytes,native);
    assert.equal(result.inputSha256,job.inputSha256);
    assert.equal(result.outputSha256,await checksum(native));
    assert.equal(result.receipt.nativeImportVerified,true);
    assert.deepEqual(uploaded[0],input);
    assert.ok(jobs.some(([,p])=>p.endsWith('/commit')));
    assert.ok(jobs.some(([method])=>method==='DELETE'));
    console.log('MASK_WEBSITE_TO_UBUNTU_V2_BROWSER_CLIENT_PASS');
  }finally{globalThis.fetch=original;}
});
test('reject oversized project before any network action',async()=>{
  await assert.rejects(api.submitSpineProject(new Uint8Array(67108865)),/64 MiB/);
});
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.match(app,/verifyLinuxCI:\(\)=>verifyLinuxZip\(\)/);
assert.match(app,/void verifyLinuxZip\(zip\)/);
assert.match(app,/inputSha256:native.inputSha256/);
assert.match(app,/outputSha256:native.outputSha256/);
assert.match(app,/receipt:native.receipt/);
assert.ok(app.includes('linux:{status:"ready",id:native.jobId'));
assert.match(app,/id:native.jobId/);
assert.match(html,/id="quick-install-bridge"/);
assert.match(html,/id="quick-from-spine"/);
console.log('MASK_SIMPLE_AND_AGENT_MODE_PRESERVATION_PASS');

test('reject a ready ZIP without an exact hash-bound Spine Editor receipt',async()=>{
  const original=globalThis.fetch;
  const input=new Uint8Array(32);input.set([80,75,3,4]);
  const id='89b67ac5-3d5b-4887-99ae-838ecc7c7e78';
  const native=new Uint8Array(32);native.set([80,75,3,4]);
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(url).pathname;
    const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    if(path==='/v2/sessions'&&init.method==='POST')return new Response(JSON.stringify({id,uploadToken:'u',resultToken:'r',partBytes:4194304,maxParts:16,maxBytes:67108864}),{status:201});
    if(path.endsWith('/input/0'))return json({status:'stored'});
    if(path.endsWith('/commit'))return json({status:'queued'});
    if(path.endsWith('/status'))return json({status:'ready',size:native.length,parts:1,
      sha256:await checksum(native),inputSha256:await checksum(input)});
    if(path.endsWith('/result/0'))return new Response(native,{status:200});
    if(path.endsWith('/'+id)&&init.method==='DELETE')return json({status:'deleted'});
    throw Error('Unexpected API request '+path);
  };
  try{
    const job=await api.submitSpineProject(input,'missing-receipt.zip');
    await assert.rejects(api.pollSpineResult(job),/Missing or invalid licensed Spine Editor 4.3.26 receipt/);
  }finally{globalThis.fetch=original;}
});
