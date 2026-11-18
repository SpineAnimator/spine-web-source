import { imageMask, availableRegions, exportJson, exportLocalEditorMask, maskVertices } from "./core.js?v=73a39f59";

const $ = id => document.getElementById(id);
const filesInput = $("files"), targetInput = $("target"), canvas = $("preview");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const state = { images: [], json: null, binary: null, source: null, sourceFile: null, result: null, base: "mask", fillImage: null, bridge: null };
function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = error ? "yes" : "no";
}
function clearResult() {
  state.result = null;
  $("download-json").disabled = true;
  $("download-png").hidden = true;
  $("native-preview").disabled = true;
  $("download-spine-zip").disabled = true;
  $("native-result").hidden = true;
  $("native-status").textContent = "";
  if (state.nativeAbort) state.nativeAbort.abort();
  if (state.nativeURL) URL.revokeObjectURL(state.nativeURL);
  state.nativeURL = null;

  $("summary").textContent = "No mask generated.";
}
function basename(x) { return String(x || "").replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "").toLowerCase(); }
function setTargets() {
  const choices = state.json ? availableRegions(state.json) : [];
  const imagePicker = $("image-source");
  imagePicker.replaceChildren();
  imagePicker.add(new Option("Choose an image...", ""));
  for (let i = 0; i < state.images.length; i++) imagePicker.add(new Option(state.images[i].file.name, String(i)));
  $("image-row").hidden = state.images.length === 0;
  targetInput.replaceChildren();
  if (state.bridge && choices.length > 1)
    targetInput.add(new Option("Select exact Spine region...", ""));
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i], opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = c.slot + " / " + c.attachment + " (" + c.skin + ")";
    targetInput.append(opt);
  }
  state.choices = choices;
  $("target-row").hidden = choices.length === 0;
  if (state.json && choices.length === 0)
    status("Skeleton loaded, but no region attachments found. Provide a region attachment in Spine.", true);
}
async function decode(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error("Unable to decode image.")); };
    img.src = url;
  });
}

// Import ordinary project files or a ZIP without sending source bytes anywhere.
// ZIP entries are validated from the central directory before decompression.
async function unpackSpineZip(file) {
  const maxArchive=128*1024*1024, maxFiles=240, maxEntry=32*1024*1024;
  if(file.size>maxArchive) throw Error("ZIP exceeds 128 MB. Open its folder instead.");
  const buf=new Uint8Array(await file.arrayBuffer()), dv=new DataView(buf.buffer);
  const get16=p=>dv.getUint16(p,true),get32=p=>dv.getUint32(p,true);
  let end=-1;
  for(let p=buf.length-22;p>=Math.max(0,buf.length-65557);p--){
    if(get32(p)===0x06054b50 && p+22+get16(p+20)<=buf.length){end=p;break;}
  }
  if(end<0)throw Error("ZIP central directory not found.");
  const count=get16(end+10), directorySize=get32(end+12);
  let cursor=get32(end+16);
  if(count>maxFiles||cursor+directorySize>buf.length||get16(end+8)!==count)
    throw Error("ZIP is too large or uses an unsupported directory format.");
  const files=[];let uncompressedTotal=0;
  const supported=/\.(json|spine|skel|atlas|png|webp|jpe?g)$/i;
  for(let i=0;i<count;i++){
    if(cursor+46>buf.length||get32(cursor)!==0x02014b50)throw Error("Invalid ZIP entry header.");
    const flags=get16(cursor+8),method=get16(cursor+10),crc=get32(cursor+16);
    const compressed=get32(cursor+20),size=get32(cursor+24);
    const nameLength=get16(cursor+28),extra=get16(cursor+30),comment=get16(cursor+32);
    const local=get32(cursor+42),nameEnd=cursor+46+nameLength;
    if(nameEnd+extra+comment>buf.length)throw Error("Truncated ZIP directory.");
    const entryName=new TextDecoder().decode(buf.subarray(cursor+46,nameEnd)).replace(/\\/g,"/");
    cursor=nameEnd+extra+comment;
    if(entryName.endsWith("/")||entryName.startsWith("__MACOSX/")||!supported.test(entryName))continue;
    if(entryName.startsWith("/")||entryName.split("/").some(part=>part===".."||part==="."))throw Error("Unsafe ZIP entry path.");
    if(flags&1||![0,8].includes(method))throw Error("Encrypted or unsupported ZIP compression.");
    if(size>maxEntry||compressed>maxEntry||size+uncompressedTotal>maxArchive)
      throw Error("ZIP contains a file larger than the local import limit.");
    if(local+30>buf.length||get32(local)!==0x04034b50)throw Error("Invalid ZIP local header.");
    const start=local+30+get16(local+26)+get16(local+28);
    if(start+compressed>buf.length)throw Error("Truncated ZIP member.");
    const body=buf.slice(start,start+compressed);
    let decoded;
    if(method===0)decoded=body;
    else{
      if(typeof DecompressionStream!=="function")
        throw Error("This browser cannot unpack ZIP. Choose an extracted folder.");
      try{
        const stream=new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        decoded=new Uint8Array(await new Response(stream).arrayBuffer());
      }catch(e){throw Error("Unable to expand ZIP member "+entryName+": "+e.message);}
    }
    if(decoded.length!==size||crc32(decoded)!==crc)
      throw Error("ZIP verification failed for "+entryName);
    uncompressedTotal+=size;
    const name=entryName.split("/").at(-1);
    const mime=/\.png$/i.test(name)?"image/png":/\.webp$/i.test(name)?"image/webp":/\.jpe?g$/i.test(name)?"image/jpeg":"application/octet-stream";
    files.push(new File([decoded],name,{type:mime,lastModified:file.lastModified}));
  }
  if(!files.length)throw Error("ZIP has no Spine skeleton or region images.");
  return files;
}
async function importProjectFiles(fileList, replace=false) {
  const selected=Array.from(fileList||[]);
  if(!selected.length)return;
  try{
    const imported=[];
    for(const file of selected){
      if(/\.zip$/i.test(file.name))imported.push(...await unpackSpineZip(file));
      else imported.push(file);
    }
    if(replace)$("reset").click();
    await addFiles(imported);
    if(state.binary&&!state.json)$("bridge-setup").open=true;
  }catch(error){status("Project import: "+error.message,true);}
}

async function addFiles(fileList, fromBridge = false) {
  if (!fromBridge) state.bridge = null;
  clearResult();
  const files = Array.from(fileList || []);
  try {
    for (const file of files) {
      if (/\.json$/i.test(file.name)) {
        const obj = JSON.parse(await file.text());
        if (!Array.isArray(obj.slots) || !obj.skins) continue; // ignore archive metadata JSON, not a skeleton
        state.json = obj; state.binary = null;
        state.base = basename(file.name);
      } else if (/\.(spine|skel)$/i.test(file.name)) {
        if (!state.json) {
          state.binary = file;
          state.base = basename(file.name);
        }
      } else if (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name)) {
        const image = await decode(file);
        state.images = state.images.filter(x => x.file.name !== file.name);
        state.images.push({ image, file });
        if (!state.json && !state.binary) state.base = basename(file.name);
      } else if (/\.(atlas|txt)$/i.test(file.name)) {
        status("Atlas metadata was supplied. Select an individual region PNG, not the packed atlas page.");
      }
    }
    let convertError=null;
    if(state.binary && !state.json && /\.spine$/i.test(state.binary.name)){
      try {
        status("Converting selected .spine using the locally installed Spine Editor…");
        const data=await convertLocalSpineBinary(state.binary);
        if(!Array.isArray(data.slots)||!data.skins)throw Error("Spine CLI exported invalid skeleton data.");
        state.json=data;
        state.base=basename(state.binary.name);
        state.binary=null;
      }catch(error){
        convertError=String(error?.message||error);
        $("bridge-setup").open=true;
      }
    }
    setTargets();
    selectSource();
    if (state.binary && !state.json && convertError)
      status("Native Spine conversion: "+convertError+" · Install Bridge or choose a JSON export with images.",true);
    else if (state.binary && !state.json) status("Binary .spine / .skel needs conversion. Import from Spine Editor using the Bridge, or supply its exported JSON with region PNGs.", true);
    else if (state.json) status("Spine JSON loaded. Select a region and generate its clipping mask.");
    else if (state.images.length) status("Image loaded. A new Spine 4.3 skeleton with one clipping attachment will be created.");
    else status("No Spine JSON or region image found. Select a project ZIP, folder or exported Spine JSON with images.", true);
    if(state.source && !state.binary && (!state.json||selectedRegion())) await generate();
  } catch (e) { status(e.message, true); }
}
function selectSource(fromPicker = false) {
  const selected = targetInput.value === "" ? null : (state.choices?.[Number(targetInput.value)] || null);
  const picker = $("image-source");
  if (!fromPicker) {
    let matched = -1;
    if (selected) {
      matched = state.images.findIndex(f => basename(f.file.name) === basename(selected.path));
      if (matched < 0) matched = state.images.findIndex(f => basename(f.file.name) === basename(selected.attachment));
    } else if (!state.json && state.images.length === 1) matched = 0;
    picker.value = matched < 0 ? "" : String(matched);
  }
  const index = picker.value === "" ? -1 : Number(picker.value);
  const imageRecord = index >= 0 ? state.images[index] : null;
  state.source = imageRecord?.image || null;
  state.sourceFile = imageRecord?.file || null;
  if (state.source) {
    $("source-name").textContent = state.sourceFile.name + " · " + state.source.width + " × " + state.source.height;
    showPreview();
  } else {
    $("source-name").textContent = "No image supplied";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  clearResult();
}
// The Spine clipping attachment needs a connected polygon, but the visible
// image must use the ORIGINAL artwork silhouette, never the bridge/slit map.
// Applying this alpha to the second image makes the routing geometry invisible.
function visibleAlphaCanvas(mask) {
  if (!mask?.visibleAlpha || mask.visibleAlpha.length !== mask.analysisWidth*mask.analysisHeight)
    throw Error("Visible silhouette alpha is unavailable.");
  const a=document.createElement("canvas");
  a.width=mask.analysisWidth; a.height=mask.analysisHeight;
  const context=a.getContext("2d",{willReadFrequently:true});
  const pixels=context.createImageData(a.width,a.height);
  for(let i=0;i<mask.visibleAlpha.length;i++){
    const j=i*4;
    pixels.data[j]=pixels.data[j+1]=pixels.data[j+2]=255;
    pixels.data[j+3]=mask.visibleAlpha[i];
  }
  context.putImageData(pixels,0,0);
  return a;
}
function createMaskedTexture(mask,w,h,secondImage=null){
  const texture=document.createElement("canvas");
  texture.width=w;texture.height=h;
  const paint=texture.getContext("2d",{willReadFrequently:true});
  if(secondImage) paint.drawImage(secondImage,0,0,w,h);
  else {
    const gradient=paint.createLinearGradient(0,0,w,h);
    gradient.addColorStop(0,"#2192e4");gradient.addColorStop(.5,"#12bdad");
    gradient.addColorStop(1,"#f39922");
    paint.fillStyle=gradient;paint.fillRect(0,0,w,h);
  }
  const alpha=visibleAlphaCanvas(mask);
  paint.globalCompositeOperation="destination-in";
  // Nearest-neighbour keeps transparent background pixels fully transparent
  // even if a one-pixel gap is located between two letter strokes.
  paint.imageSmoothingEnabled=false;
  paint.drawImage(alpha,0,0,w,h);
  paint.globalCompositeOperation="source-over";
  return texture;
}
function showPreview(mask) {
  if(!state.source)return;
  const w=state.source.width,h=state.source.height;
  const scale=Math.min(1,1100/Math.max(w,h));
  canvas.width=Math.max(1,Math.round(w*scale));
  canvas.height=Math.max(1,Math.round(h*scale));
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!mask){ctx.drawImage(state.source,0,0,canvas.width,canvas.height);return;}
  const texture=createMaskedTexture(mask,canvas.width,canvas.height,state.fillImage||null);
  ctx.drawImage(texture,0,0);
  if(!$("show-points").checked)return; // no routing outlines in normal preview
  const sx=canvas.width/mask.analysisWidth,sy=canvas.height/mask.analysisHeight;
  ctx.beginPath();
  mask.points.forEach(([x,y],i)=>i?ctx.lineTo(x*sx,y*sy):ctx.moveTo(x*sx,y*sy));
  ctx.closePath();
  ctx.strokeStyle="#ff9b28";ctx.lineWidth=1;ctx.stroke();
  ctx.fillStyle="#75e4ff";
  if(mask.points.length<1200)for(const [x,y] of mask.points)
    ctx.fillRect(x*sx-1,y*sy-1,2,2);
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function selectedRegion() {
  return targetInput.value === "" ? null : (state.choices?.[Number(targetInput.value)] || null);
}
async function generate() {
  if (state.binary && !state.json) {
    status("Binary .spine needs conversion by a licensed Spine Editor. It cannot be merged into this browser-only JSON exporter.", true);
    return;
  }
  if (!state.source) { status("Select the exact PNG region to trace (not a packed atlas page).", true); return; }
  if (state.json && !selectedRegion()) { status("Select a region attachment from the skeleton.", true); return; }
  $("generate").disabled = true;
  status("Tracing all visible parts and connecting the internal contours…");
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    const originalW = state.source.width, originalH = state.source.height;
    const max = Math.max(originalW, originalH);
    const scale = Math.min(1, 850 / max);
    const aw = Math.max(1, Math.round(originalW * scale));
    const ah = Math.max(1, Math.round(originalH * scale));
    const work = document.createElement("canvas"); work.width = aw; work.height = ah;
    const wc = work.getContext("2d", { willReadFrequently: true });
    wc.clearRect(0, 0, aw, ah);
    wc.drawImage(state.source, 0, 0, aw, ah);
    const settings = { highlightFaces: $("highlight-edges").checked };
    const mask = imageMask(wc.getImageData(0,0,aw,ah), settings);
    if (mask.points.length < 3) throw Error("Clipping polygon must have at least 3 vertices.");
    const selected = selectedRegion();
    const points = mask.points.map(([x,y]) => [x / aw * originalW, y / ah * originalH]);
    const output = exportJson(state.json, selected, points, originalW, originalH);
    state.result = { mask, json: output.json, slot: output.slot, imageOnly: !state.json };
    if(state.bridge && state.json && selectedRegion()) queueBridgeWrite();
    showPreview(mask);
    $("download-json").disabled = false;
    $("native-preview").disabled = false;
    $("download-spine-zip").disabled = false;
    $("download-png").hidden = !!state.json;
    const s = mask.stats;
    $("summary").textContent = "ONE CLIPPING MASK · " + s.vertices + "/" + s.mobileVertexBudget +
      " vertices · " + s.concurrentSkeletons + " mobile skeletons: " +
      s.totalSceneClippingVertices + " total · " +
      (s.highlightApplied ? "Light faces only" : "Full silhouette") + " · Invisible connectors";
    const profile = s.highlightRequested
      ? (s.highlightApplied ? "Automatic light-face edges; dark shadows excluded."
         : "Light-edge mode used standard silhouette fallback (" + s.highlightReason + ").")
      : "Full silhouette edge mode.";
    status(profile + " Mobile geometry: " + s.vertices +
      " vertices; dark coverage " + s.darkLeakPercent + "%; lost light " +
      s.missingLightPercent + "%. JSON and ZIP are ready.");
  } catch (e) {
    state.result = null;
    $("download-json").disabled = true;
    status("Mask failed validation: " + e.message, true);
  } finally { $("generate").disabled = false; }
}
filesInput.addEventListener("change", e => {
  const selected=Array.from(e.target.files||[]);
  void importProjectFiles(selected,selected.some(file=>/\.(zip|spine|skel|json)$/i.test(file.name)));
});
$("open-project").addEventListener("click",()=> $("project-files").click());
$("open-folder").addEventListener("click",()=> $("project-folder").click());
$("open-editor").addEventListener("click",()=> void connectEditor(false));
$("project-files").addEventListener("change",e=>{void importProjectFiles(e.target.files,true);});
$("project-folder").addEventListener("change",e=>{void importProjectFiles(e.target.files,true);});
targetInput.addEventListener("change", () => {selectSource();if(state.source)generate();});
$("image-source").addEventListener("change", () => {selectSource(true);if(state.source)generate();});
$("generate").addEventListener("click", generate);
$("highlight-edges").addEventListener("change", () => {
  if(state.source&&(!state.json||selectedRegion()))generate();
});
// Stable agent interface. No image data is exposed here or transmitted.
Object.defineProperty(window,"SpineMaskAgentControl",{
  value:Object.freeze({
    getHighlightEdges:()=>$("highlight-edges").checked,
    setHighlightEdges:enabled=>{
      const checkbox=$("highlight-edges");
      checkbox.checked=!!enabled;
      checkbox.dispatchEvent(new Event("change",{bubbles:true}));
      return checkbox.checked;
    },
    generate:()=>generate(),
    getStatus:()=>({ready:!!state.result,mode:$("highlight-edges").checked?"light-faces":"silhouette",
      result:state.result?{vertices:state.result.mask.stats.vertices,
        highlightApplied:state.result.mask.stats.highlightApplied,
        mobileQualityPassed:state.result.mask.stats.mobileQualityPassed,
        mobileVertexBudget:state.result.mask.stats.mobileVertexBudget,
        concurrentSkeletons:state.result.mask.stats.concurrentSkeletons,
        totalSceneClippingVertices:state.result.mask.stats.totalSceneClippingVertices,
        darkLeakPercent:state.result.mask.stats.darkLeakPercent,
        missingLightPercent:state.result.mask.stats.missingLightPercent}:null})
  }),
  writable:false,configurable:false
});
$("show-points").addEventListener("change", () => showPreview(state.result?.mask));
$("download-json").addEventListener("click", () => {
  if (!state.result) return;
  downloadBlob(new Blob([JSON.stringify(state.result.json, null, 2)], { type: "application/json" }),
    (state.base || "spine") + "-mask.json");
});
$("download-png").addEventListener("click", async () => {
  if (!state.source) return;
  const c = document.createElement("canvas");
  c.width = state.source.width; c.height = state.source.height;
  c.getContext("2d").drawImage(state.source,0,0);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  if (blob) downloadBlob(blob, "image.png");
});
$("reset").addEventListener("click", () => {
  state.images = []; state.json = null; state.binary = null; state.source = null;
  state.bridge = null;
  state.sourceFile = null; state.choices = []; filesInput.value = "";
  $("project-files").value=""; $("project-folder").value="";
  targetInput.replaceChildren(); $("target-row").hidden = true;
  $("image-source").replaceChildren(); $("image-row").hidden = true;
  $("source-name").textContent = "No image supplied";
  state.fillImage?.close?.(); state.fillImage=null;
  $("native-fill").value="";
  ctx.clearRect(0, 0, canvas.width, canvas.height); clearResult();
  
status("Open a Spine project ZIP, folder or JSON + images. For a live .spine project use Import from Spine Editor.");
});
for (const evt of ["dragenter","dragover"]) document.addEventListener(evt, e => {
  e.preventDefault(); document.body.classList.add("dragging");
});
document.addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
document.addEventListener("drop", e => {
  e.preventDefault(); document.body.classList.remove("dragging");
  if (e.dataTransfer?.files.length) void importProjectFiles(e.dataTransfer.files,
    Array.from(e.dataTransfer.files).some(file=>/\.(zip|spine|skel|json)$/i.test(file.name)));
});
// Upload only selected clipping vertices and the user-authorized replacement
// texture, never the source artwork itself. The gateway erases data after a
// successful result retrieval, or when its short retention expires.
const NATIVE_GATEWAY="https://spine-mask-native-gateway.vladyslavchaplygin.workers.dev";
const bytes=x=>new TextEncoder().encode(x);
function crc32(data){
  let v=0xffffffff;
  for (const n of data){v^=n;for(let i=0;i<8;i++)v=(v>>>1)^((v&1)?0xedb88320:0)}
  return (v^0xffffffff)>>>0;
}
function zipMemory(files){
  const locals=[],centrals=[];let offset=0;
  const join=items=>{const n=items.reduce((v,x)=>v+x.length,0),out=new Uint8Array(n);let p=0;for(const x of items){out.set(x,p);p+=x.length}return out};
  for(const [name,data] of files){
    const n=bytes(name),size=data.length,c=crc32(data);
    const a=new Uint8Array(30),v=new DataView(a.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);
    v.setUint16(6,0x800,true); // UTF-8 paths (including localized Spine images)
    v.setUint32(14,c,true);v.setUint32(18,size,true);v.setUint32(22,size,true);v.setUint16(26,n.length,true);
    locals.push(a,n,data);
    const b=new Uint8Array(46),w=new DataView(b.buffer);
    w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);
    w.setUint16(8,0x800,true);
    w.setUint32(16,c,true);w.setUint32(20,size,true);w.setUint32(24,size,true);w.setUint16(28,n.length,true);
    w.setUint32(42,offset,true);
    centrals.push(b,n);
    offset+=a.length+n.length+size;
  }
  const cd=join(centrals),eocd=new Uint8Array(22),dv=new DataView(eocd.buffer);
  dv.setUint32(0,0x06054b50,true);dv.setUint16(8,files.length,true);dv.setUint16(10,files.length,true);
  dv.setUint32(12,cd.length,true);dv.setUint32(16,offset,true);
  return join([...locals,cd,eocd]);
}
function nativeStatus(text,error=false){
  $("native-status").textContent=text;
  $("native-status").dataset.error=error?"yes":"no";
}
// The ZIP is self-contained: one Spine clip and a fill texture with alpha
// equal to the ORIGINAL silhouette. Rendering the included fill never shows
// connector pixels, even when the clip must remain one contiguous polygon.

// User download must retain the ACTUAL skeleton and every supplied asset.
// The tiny scene.json + fill.png package below is only for private native PNG
// rendering, not a replacement for the artist's Spine project.
async function buildPreservedSpineProjectZip(){
  if(!state.result?.json)throw Error("Generate a mask first.");
  const base=(state.base||"spine").replace(/[^a-z0-9_-]/gi,"_").slice(0,80)||"spine";
  const output=[[base+"-mask.json",bytes(JSON.stringify(state.result.json,null,2))]];
  const seen=new Set([output[0][0].toLowerCase()]);
  let total=output[0][1].length;
  function safeImagePath(file){
    const relative=String(file.webkitRelativePath||"").replace(/\\/g,"/");
    const parts=relative.split("/");
    const folder=parts.findIndex(x=>x.toLowerCase()==="images");
    const suffix=folder>=0?parts.slice(folder+1):[file.name];
    if(!suffix.length||suffix.some(x=>!x||x==="."||x===".."||x.includes("/")||x.includes("\\")||/[\x00-\x1f]/.test(x)))
      throw Error("Unsafe source image path.");
    return "images/"+suffix.join("/");
  }
  for(const item of state.images){
    const path=safeImagePath(item.file);
    const key=path.toLowerCase();
    if(seen.has(key))throw Error("Duplicate image path in Spine project: "+path);
    const buffer=new Uint8Array(await item.file.arrayBuffer());
    total+=buffer.length;
    if(total>128*1024*1024)throw Error("Project ZIP exceeds 128 MB.");
    output.push([path,buffer]);seen.add(key);
  }
  if(state.result.imageOnly){
    const canvas=document.createElement("canvas");
    canvas.width=state.source.width;canvas.height=state.source.height;
    canvas.getContext("2d").drawImage(state.source,0,0);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(x=>
      x?resolve(x):reject(Error("Could not encode image-only Spine texture.")),"image/png"));
    const path="images/image.png";
    if(!seen.has(path)){
      const data=new Uint8Array(await blob.arrayBuffer());
      total+=data.length;
      if(total>128*1024*1024)throw Error("Project ZIP exceeds 128 MB.");
      output.push([path,data]);seen.add(path);
    }
  }
  if(output.length<2)throw Error("Spine source images are missing.");
  if(output.length>240)throw Error("Too many project assets for this ZIP.");
  return zipMemory(output);
}

async function buildInvisibleBridgePackage(){
  if(!state.result||!state.source)throw Error("Generate a mask first.");
  const mask=state.result.mask;
  if(mask.points.length>2500)throw Error("Native Spine limit: 2500 clip vertices.");
  const sw=state.source.width,sh=state.source.height;
  const ratio=Math.min(1,512/Math.max(sw,sh));
  const w=Math.max(1,Math.round(sw*ratio)),h=Math.max(1,Math.round(sh*ratio));
  const scaled=mask.points.map(([x,y])=>[x*w/mask.analysisWidth,y*h/mask.analysisHeight]);
  const vertices=maskVertices(scaled,w,h,{width:w,height:h});
  const scene={
    skeleton:{spine:"4.3.26",x:-w/2,y:-h/2,width:w,height:h,images:"./images/"},
    bones:[{name:"root"}],
    slots:[{name:"mask",bone:"root",attachment:"clip"},{name:"fill",bone:"root",attachment:"fill"}],
    skins:[{name:"default",attachments:{
      mask:{clip:{type:"clipping",end:"fill",vertexCount:scaled.length,vertices}},
      fill:{fill:{type:"region",path:"fill",width:w,height:h}}
    }}],
    animations:{"mask-preview":{bones:{root:{translate:[{time:0,x:0,y:0},{time:.1,x:0,y:0}]}}}}
  };
  const secondary=$("native-fill").files?.[0];
  let sourceFill=state.fillImage;
  if(secondary&&!sourceFill)sourceFill=await decode(secondary);
  const c=createMaskedTexture(mask,w,h,sourceFill);
  if(sourceFill!==state.fillImage)sourceFill?.close?.();
  const png=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error("Could not encode replacement image.")),"image/png"));
  const zip=zipMemory([
    ["scene.json",bytes(JSON.stringify(scene))],
    ["images/fill.png",new Uint8Array(await png.arrayBuffer())]
  ]);
  if(zip.length>1048576)throw Error("Native request exceeds the 1 MB private upload limit.");
  return zip;
}

async function nativeRender(){
  if(!state.result||!state.source)return;
  const mask=state.result.mask;
  if(mask.points.length>2500){nativeStatus("Native Editor limit: simplify mask below 2500 vertices.",true);return;}
  $("native-preview").disabled=true;
  $("native-result").hidden=true;
  state.nativeAbort?.abort();
  if(state.nativeURL)URL.revokeObjectURL(state.nativeURL);
  state.nativeURL=null;
  const controller=new AbortController();
  state.nativeAbort=controller;
  const signal=controller.signal;
  try{
    const zip=await buildInvisibleBridgePackage();
    nativeStatus("Uploading encrypted-in-transit mask geometry to private gateway…");
    const sessionResponse=await fetch(NATIVE_GATEWAY+"/v1/sessions",{method:"POST",signal});
    if(!sessionResponse.ok)throw Error("Private gateway could not open a session (HTTP "+sessionResponse.status+").");
    const {id,uploadToken,resultToken}=await sessionResponse.json();
    if(!id||!uploadToken||!resultToken)throw Error("Invalid gateway session.");
    const upload=await fetch(NATIVE_GATEWAY+"/v1/sessions/"+id+"/input",{
      method:"PUT",headers:{Authorization:"Bearer "+uploadToken,"Content-Type":"application/zip"},
      body:zip,signal
    });
    if(upload.status!==202)throw Error("Private upload failed (HTTP "+upload.status+").");
    nativeStatus("Queued for licensed Spine Editor 4.3.26. Waiting for native PNG…");
    for(let attempt=0;attempt<170;attempt++){
      await new Promise((resolve,reject)=>{
        const t=setTimeout(resolve,5000);
        signal.addEventListener("abort",()=>{clearTimeout(t);reject(Error("Cancelled."))},{once:true});
      });
      const r=await fetch(NATIVE_GATEWAY+"/v1/sessions/"+id+"/result",{
        headers:{Authorization:"Bearer "+resultToken},signal,cache:"no-store"
      });
      if(r.status===202)continue;
      if(!r.ok)throw Error("Native result unavailable (HTTP "+r.status+").");
      const blob=await r.blob();
      if(blob.type!=="image/png"||blob.size<50)throw Error("Invalid native PNG.");
      state.nativeURL=URL.createObjectURL(blob);
      $("native-image").src=state.nativeURL;
      $("native-result").hidden=false;
      nativeStatus("Rendered by licensed Spine Editor 4.3.26.");
      return;
    }
    throw Error("Private session expired before the native Editor returned the image.");
  }catch(e){
    if(!signal.aborted)nativeStatus("Native render: "+e.message,true);
  }finally{
    if(state.nativeAbort===controller)state.nativeAbort=null;
    $("native-preview").disabled=!state.result;
  }
}
$("native-fill").addEventListener("change",async()=>{
  try {
    state.fillImage?.close?.();state.fillImage=null;
    const file=$("native-fill").files?.[0];
    if(file)state.fillImage=await decode(file);
    if(state.result)showPreview(state.result.mask);
  }catch(e){nativeStatus("Unable to read second image: "+e.message,true);}
});
$("download-spine-zip").addEventListener("click",async()=>{
  if(!state.result)return;
  const button=$("download-spine-zip");
  button.disabled=true;
  try{
    const zip=await buildPreservedSpineProjectZip();
    downloadBlob(new Blob([zip],{type:"application/zip"}),(state.base||"mask")+"-complete-spine-mask.zip");
  }catch(e){nativeStatus("Spine ZIP: "+e.message,true);}
  finally{button.disabled=!state.result;}
});
$("native-preview").addEventListener("click",nativeRender);
$("native-download").addEventListener("click",()=>{
  if(!state.nativeURL)return;
  const a=document.createElement("a");
  a.href=state.nativeURL;a.download=(state.base||"mask")+"-spine-native.png";
  document.body.append(a);a.click();a.remove();
});



// Chrome extension Native Messaging bridge. Content-script messages run inside
// the browser's isolated world: postMessage is the only page transport. This
// never sends NDA images to GitHub, Cloudflare, or any other network service.
const BRIDGE_CHANNEL="spine-mask-native-v1";
const bridgePending=new Map();
let bridgeWriteEpoch=0, bridgeWriterBusy=false, bridgeLastRendered=0;
const requestBridge=(method,params={},deadline=25000)=>new Promise((resolve,reject)=>{
  const id="mask_"+crypto.randomUUID().replaceAll("-","");
  const timer=setTimeout(()=>{
    bridgePending.delete(id);reject(new Error("Chrome Native Messaging bridge unavailable"));
  },deadline);
  bridgePending.set(id,{resolve,reject,timer});
  window.postMessage({channel:BRIDGE_CHANNEL,type:"request",id,method,params},location.origin);
});
window.addEventListener("message",event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  const m=event.data;
  if(!m||m.channel!==BRIDGE_CHANNEL||m.type!=="response"||!bridgePending.has(m.id))return;
  const pending=bridgePending.get(m.id);
  clearTimeout(pending.timer);bridgePending.delete(m.id);
  if(m.ok===true)pending.resolve(m.result);
  else pending.reject(new Error(String(m.error||"Native bridge unavailable")));
});
function bridgeStatus(message,error=false){
  const element=$("bridge-status");
  if(!element)return;
  element.textContent=message;element.dataset.error=error?"yes":"no";
}
function decode64(s){
  const raw=atob(s),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
function encode64(part){
  let output="";
  for(let i=0;i<part.length;i+=8192)
    output+=String.fromCharCode(...part.subarray(i,i+8192));
  return btoa(output);
}
function imageFileMime(name){
  if(/\.png$/i.test(name))return "image/png";
  if(/\.jpe?g$/i.test(name))return "image/jpeg";
  if(/\.webp$/i.test(name))return "image/webp";
  return "application/json";
}
async function readBridgeFile(session,item){
  const parts=[],max=32*1024*1024;
  if(!Number.isInteger(item.size)||item.size<0||item.size>max)
    throw Error("Source image or skeleton too large for local bridge.");
  let received=0;
  while(received<item.size){
    const packet=await requestBridge("read_chunk",{session,key:item.key,offset:received},25000);
    if(!packet||packet.offset!==received||packet.total!==item.size)
      throw Error("Local Spine project changed during read.");
    const segment=decode64(packet.base64||"");
    if(segment.length===0||received+segment.length>item.size)
      throw Error("Invalid native project chunk.");
    parts.push(segment);received+=segment.length;
  }
  return new File(parts,item.name,{type:imageFileMime(item.name)});
}

// The browser's user-selected .spine bytes are sent ONLY to the local Chrome
// Native Messaging host. No server, absolute path or filesystem read is used.
async function convertLocalSpineBinary(file){
  if(file.size<=0||file.size>32*1024*1024)
    throw Error("Native conversion supports .spine files up to 32 MB.");
  const response=await requestBridge("ping",{},5500);
  if(response?.protocol!=="spinemask/1")throw Error("Spine Mask Bridge needs an update.");
  const raw=new Uint8Array(await file.arrayBuffer());
  const hashed=new Uint8Array(await crypto.subtle.digest("SHA-256",raw));
  const digest=[...hashed].map(x=>x.toString(16).padStart(2,"0")).join("");
  const start=await requestBridge("begin_import",{
    name:file.name,size:raw.length,sha256:digest
  },15000);
  if(!start?.session)throw Error("Local Spine import session unavailable.");
  const chunkSize=48*1024;
  for(let offset=0;offset<raw.length;offset+=chunkSize){
    const piece=raw.subarray(offset,Math.min(offset+chunkSize,raw.length));
    const res=await requestBridge("import_chunk",{
      session:start.session,offset,base64:encode64(piece)
    },25000);
    if(res?.written!==offset+piece.length)
      throw Error("Spine native import verification failed.");
  }
  const completed=await requestBridge("finish_import",{session:start.session},195000);
  if(!completed||completed.session!==start.session||
     !Number.isInteger(completed.size)||completed.size<20||completed.size>32*1024*1024)
    throw Error("Native Spine export did not return valid JSON metadata.");
  const blocks=[],expected=completed.size;
  let received=0;
  while(received<expected){
    const res=await requestBridge("read_import_chunk",{
      session:start.session,offset:received
    },25000);
    if(!res||res.offset!==received||res.total!==expected)
      throw Error("Native Spine export changed during read.");
    const part=decode64(res.base64||"");
    if(!part.length||received+part.length>expected)
      throw Error("Invalid native JSON data chunk.");
    blocks.push(part);received+=part.length;
  }
  const buffer=new Uint8Array(expected);
  let offset=0;
  for(const block of blocks){buffer.set(block,offset);offset+=block.length;}
  try{return JSON.parse(new TextDecoder().decode(buffer));}
  catch(error){throw Error("Spine native export returned invalid JSON.");}
}

async function connectEditor(auto=false,choose=false){
  if(connectEditor.busy){
    if(!auto){
      connectEditor.manualQueued=true;
      connectEditor.chooseQueued=!!choose || !!connectEditor.chooseQueued;
      bridgeStatus("Completing bridge check; requested import will start automatically…");
    }
    return;
  }
  connectEditor.busy=true;
  bridgeStatus("Connecting to locally installed Spine Editor…");
  try{
    const ping=await requestBridge("ping",{},auto?3200:6000);
    if(ping?.protocol!=="spinemask/1")throw Error("Outdated Chrome native bridge.");
    const opened=await requestBridge(choose?"choose_project":"open_project",{},210000);
    if(!opened?.open){
      bridgeStatus("Chrome bridge connected · no unambiguous open Spine project ("+
        (opened?.reason||"not detected")+")");
      return;
    }
    const selected=opened.files||[];
    if(!Array.isArray(selected)||!selected.length||selected.length>80)
      throw Error("Invalid project file manifest from native Spine bridge.");
    // Always import skeleton first; images follow. No project bytes are sent
    // to a server, and Native Messaging never allows arbitrary disk paths.
    const ordered=[...selected].sort((a,b)=>(a.key==="skeleton.json"?-1:0)-(b.key==="skeleton.json"?-1:0));
    const files=[];
    for(const item of ordered)files.push(await readBridgeFile(opened.session,item));
    $("reset").click();
    state.bridge={session:opened.session,source:opened.source,importedAt:Date.now()};
    bridgeStatus("Linked to "+opened.source+" · loading project and tracing mask…");
    await addFiles(files,true);
    if(!state.source||!state.result)
      bridgeStatus("Project loaded; select an exact image attachment to complete the mask.",true);
  }catch(error){
    if(!auto){bridgeStatus("Bridge unavailable: "+error.message+" · Install Bridge or open exported JSON + images.",true);$("bridge-setup").open=true;}
    else bridgeStatus("Chrome Native Messaging bridge not connected. Upload files normally.");
  }finally{
    connectEditor.busy=false;
    if(connectEditor.manualQueued){
      connectEditor.manualQueued=false;
      const queuedChoice=!!connectEditor.chooseQueued;
      connectEditor.chooseQueued=false;
      void connectEditor(false,queuedChoice);
    }
  }
}
function queueBridgeWrite(){
  const epoch=++bridgeWriteEpoch;
  setTimeout(()=>{
    if(epoch!==bridgeWriteEpoch||bridgeWriterBusy||!state.bridge||!state.result)return;
    void writeToEditor(epoch);
  },350);
}
async function writeBytesToHost(stage,name,bytes){
  const total=bytes.length,chunkSize=48*1024;
  for(let offset=0;offset<total;offset+=chunkSize){
    const block=bytes.subarray(offset,Math.min(offset+chunkSize,total));
    const result=await requestBridge("write_chunk",{stage,name,offset,base64:encode64(block)},25000);
    if(result?.written!==offset+block.length)
      throw Error("Spine Native Messaging write verification failed.");
  }
}
async function writeToEditor(epoch){
  if(bridgeWriterBusy||!state.bridge||!state.result||!state.json)return;
  bridgeWriterBusy=true;
  const {session}=state.bridge;
  try {
    const source=state.source,mask=state.result.mask,selection=selectedRegion();
    if(!selection)throw Error("Select a valid region before native export.");
    const sw=source.width,sh=source.height;
    const points=mask.points.map(([x,y])=>[x*sw/mask.analysisWidth,y*sh/mask.analysisHeight]);
    const merged=exportLocalEditorMask(state.json,selection,points,sw,sh);
    // Send only the modified Spine JSON. The original region and its PNG
    // remain untouched. One clipping attachment clips the selected target.
    const encoded=new TextEncoder().encode(JSON.stringify(merged.json));
    if(epoch!==bridgeWriteEpoch||session!==state.bridge?.session)return;
    bridgeStatus("Saving new Spine project with one native clipping mask…");
    const started=await requestBridge("begin_result",{session,
      files:[{name:"mask.json",size:encoded.length}]},25000);
    if(!started?.stage)throw Error("Native output transaction rejected.");
    await writeBytesToHost(started.stage,"mask.json",encoded);
    const saved=await requestBridge("commit_result",{session,stage:started.stage,openEditor:true},210000);
    if(saved?.imported&&saved?.opened)
      bridgeStatus("Mask applied · "+saved.project+" opened in local Spine Editor.");
    else if(saved?.imported)
      bridgeStatus("New .spine project saved; automatic editor opening was unavailable.",true);
    else if(saved?.saved)
      bridgeStatus("New Spine JSON saved. Native editor import was unavailable.",true);
    else throw Error("Spine editor did not confirm output.");
  }catch(error){bridgeStatus("Local Spine export: "+error.message,true);}
  finally{
    bridgeWriterBusy=false;
    if(epoch!==bridgeWriteEpoch&&state.bridge&&state.result)queueBridgeWrite();
  }
}
$("bridge-refresh").addEventListener("click",()=>connectEditor(false));
$("bridge-choose").addEventListener("click",()=>connectEditor(false,true));
window.addEventListener("message",event=>{
  if(event.source===window&&event.origin===location.origin&&
     event.data?.channel===BRIDGE_CHANNEL&&event.data.type==="ready")
    void connectEditor(true);
});
setTimeout(()=>void connectEditor(true),500);

status("Open a Spine project ZIP, folder or JSON + images. For live .spine use Import from Spine Editor.");
