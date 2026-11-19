// Explicit full-project Spine v2 API, secure short-lived read/write tokens.
const URL_BASE="https://spine-mask-native-gateway.vladyslavchaplygin.workers.dev";
const CHUNK=4*1024*1024,MAX=CHUNK*16;
const pause=t=>new Promise(r=>setTimeout(r,t));
async function digest(bytes){
  const h=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(h),x=>x.toString(16).padStart(2,"0")).join("");
}
async function parse(res){
  if(!res.ok)throw Error("Linux API HTTP "+res.status);
  return res.json();
}
const bearer=(token,extra={})=>({Authorization:"Bearer "+token,...extra});
export async function submitSpineProject(zip,filename="project.zip"){
  const data=zip instanceof Uint8Array?zip:new Uint8Array(zip);
  if(data.length<24||data.length>MAX||data[0]!==80||data[1]!==75)
    throw Error("The complete Spine ZIP must be no larger than 64 MiB.");
  filename=String(filename).replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,85);
  if(!filename.endsWith(".zip"))filename+=".zip";
  const session=await parse(await fetch(URL_BASE+"/v2/sessions",{
    method:"POST",headers:{"Content-Type":"application/json"},body:"{}"
  }));
  const parts=Math.ceil(data.length/CHUNK);
  for(let i=0;i<parts;i++){
    const chunk=data.subarray(i*CHUNK,Math.min(data.length,(i+1)*CHUNK));
    await parse(await fetch(URL_BASE+"/v2/sessions/"+session.id+"/input/"+i,{
      method:"PUT",headers:bearer(session.uploadToken,{"Content-Type":"application/octet-stream",
        "X-Chunk-SHA256":await digest(chunk)}),body:chunk
    }));
  }
  await parse(await fetch(URL_BASE+"/v2/sessions/"+session.id+"/commit",{
    method:"POST",headers:bearer(session.uploadToken,{"Content-Type":"application/json"}),
    body:JSON.stringify({parts,size:data.length,sha256:await digest(data),filename})
  }));
  return {id:session.id,readToken:session.resultToken};
}
export async function pollSpineResult(job,{onStatus=()=>{},timeoutMs=35*60*1000,signal}={}){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    if(signal?.aborted)throw Error("Linux verification cancelled");
    const report=await parse(await fetch(URL_BASE+"/v2/sessions/"+job.id+"/status",{
      headers:bearer(job.readToken),signal
    }));
    onStatus(report);
    if(report.status==="failed")throw Error("Linux Spine Editor failed: "+report.reason);
    if(report.status==="ready"){
      if(!Number.isInteger(report.parts)||report.parts<1||report.parts>16
        ||report.size<24||report.size>MAX)throw Error("Invalid native result metadata");
      const chunks=[];let total=0;
      for(let i=0;i<report.parts;i++){
        const response=await fetch(URL_BASE+"/v2/sessions/"+job.id+"/result/"+i,{
          headers:bearer(job.readToken),signal
        });
        if(!response.ok)throw Error("Missing native output chunk "+i);
        const chunk=new Uint8Array(await response.arrayBuffer());
        total+=chunk.length;if(total>MAX)throw Error("Oversized native output");
        chunks.push(chunk);
      }
      if(total!==report.size)throw Error("Native output size mismatch");
      const final=new Uint8Array(total);let offset=0;
      for(const c of chunks){final.set(c,offset);offset+=c.length;}
      if(final[0]!==80||final[1]!==75||await digest(final)!==report.sha256)
        throw Error("Native project SHA-256 mismatch");
      await fetch(URL_BASE+"/v2/sessions/"+job.id,{
        method:"DELETE",headers:bearer(job.readToken),signal
      }).catch(()=>{});
      return final;
    }
    await pause(7000);
  }
  throw Error("Ubuntu job timed out; local Spine ZIP remains available");
}
