import { imageMask, availableRegions, exportJson, maskVertices } from "./core.js";

const $ = id => document.getElementById(id);
const filesInput = $("files"), targetInput = $("target"), canvas = $("preview");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const state = { images: [], json: null, binary: null, source: null, sourceFile: null, result: null, base: "mask", fillImage: null };
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
async function addFiles(fileList) {
  clearResult();
  const files = Array.from(fileList || []);
  try {
    for (const file of files) {
      if (/\.json$/i.test(file.name)) {
        const obj = JSON.parse(await file.text());
        if (!Array.isArray(obj.slots) || !obj.skins) throw Error("JSON is not a Spine skeleton: " + file.name);
        state.json = obj; state.binary = null;
        state.base = basename(file.name);
      } else if (/\.spine$/i.test(file.name)) {
        state.binary = file;
        state.json = null; state.base = basename(file.name);
      } else if (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name)) {
        const image = await decode(file);
        state.images = state.images.filter(x => x.file.name !== file.name);
        state.images.push({ image, file });
        if (!state.json && !state.binary) state.base = basename(file.name);
      } else if (/\.(atlas|txt)$/i.test(file.name)) {
        status("Atlas metadata was supplied. Select an individual region PNG, not the packed atlas page.");
      }
    }
    setTargets();
    selectSource();
    if (state.binary && !state.json) status("Binary .spine received. Native conversion is required first; the browser will not invent a replacement skeleton.", true);
    else if (state.json) status("Spine JSON loaded. Select a region and generate its clipping mask.");
    else if (state.images.length) status("Image loaded. A new Spine 4.3 skeleton with one clipping attachment will be created.");
    else status("Drop an image PNG, or a Spine JSON with the region image.");
  } catch (e) { status(e.message, true); }
}
function selectSource(fromPicker = false) {
  const selected = state.choices?.[Number(targetInput.value)] || null;
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
  return state.choices?.[Number(targetInput.value)] || null;
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
    const settings = {
      alpha: Number($("alpha").value), tolerance: Number($("tolerance").value),
      simplify: Number($("smooth").value), bridgeWidth: Number($("bridge").value),
      minArea: Number($("area").value)
    };
    const mask = imageMask(wc.getImageData(0,0,aw,ah), settings);
    if (mask.points.length < 3) throw Error("Clipping polygon must have at least 3 vertices.");
    const selected = selectedRegion();
    const points = mask.points.map(([x,y]) => [x / aw * originalW, y / ah * originalH]);
    const output = exportJson(state.json, selected, points, originalW, originalH);
    state.result = { mask, json: output.json, slot: output.slot, imageOnly: !state.json };
    showPreview(mask);
    $("download-json").disabled = false;
    $("native-preview").disabled = false;
    $("download-spine-zip").disabled = false;
    $("download-png").hidden = !!state.json;
    const s = mask.stats;
    $("summary").textContent = "ONE CLIPPING MASK · " + s.vertices + " vertices · " +
      s.shapes + " parts · " + s.bridges + " bridges · " + s.slits + " inner passages";
    if (s.vertices > 700) status("Mask generated. High vertex count may impact Spine runtime performance.");
    else status("Mask generated. JSON is ready.");
  } catch (e) {
    state.result = null;
    $("download-json").disabled = true;
    status("Mask failed validation: " + e.message, true);
  } finally { $("generate").disabled = false; }
}
filesInput.addEventListener("change", e => addFiles(e.target.files));
targetInput.addEventListener("change", () => selectSource());
$("image-source").addEventListener("change", () => selectSource(true));
$("generate").addEventListener("click", generate);
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
  state.sourceFile = null; state.choices = []; filesInput.value = "";
  targetInput.replaceChildren(); $("target-row").hidden = true;
  $("image-source").replaceChildren(); $("image-row").hidden = true;
  $("source-name").textContent = "No image supplied";
  state.fillImage?.close?.(); state.fillImage=null;
  $("native-fill").value="";
  ctx.clearRect(0, 0, canvas.width, canvas.height); clearResult();
  
status("Drop a Spine JSON and its images, or just one PNG.");
});
for (const evt of ["dragenter","dragover"]) document.addEventListener(evt, e => {
  e.preventDefault(); document.body.classList.add("dragging");
});
document.addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
document.addEventListener("drop", e => {
  e.preventDefault(); document.body.classList.remove("dragging");
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
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
    v.setUint32(14,c,true);v.setUint32(18,size,true);v.setUint32(22,size,true);v.setUint16(26,n.length,true);
    locals.push(a,n,data);
    const b=new Uint8Array(46),w=new DataView(b.buffer);
    w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);
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
    const zip=await buildInvisibleBridgePackage();
    downloadBlob(new Blob([zip],{type:"application/zip"}),(state.base||"mask")+"-bridgeless-spine.zip");
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


status("Drop a Spine JSON and its images, or just one PNG.");
