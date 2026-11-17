import { imageMask, availableRegions, exportJson } from "./core.js";

const $ = id => document.getElementById(id);
const filesInput = $("files"), targetInput = $("target"), canvas = $("preview");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const state = { images: [], json: null, binary: null, source: null, sourceFile: null, result: null, base: "mask" };
function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = error ? "yes" : "no";
}
function clearResult() {
  state.result = null;
  $("download-json").disabled = true;
  $("download-png").hidden = true;
  $("summary").textContent = "No mask generated.";
}
function basename(x) { return String(x || "").replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "").toLowerCase(); }
function setTargets() {
  const choices = state.json ? availableRegions(state.json) : [];
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
    if (state.binary) status("Binary .spine received. Mask will export as a separate JSON skeleton; binary data is never silently altered.");
    else if (state.json) status("Spine JSON loaded. Select a region and generate its clipping mask.");
    else if (state.images.length) status("Image loaded. A new Spine 4.3 skeleton with one clipping attachment will be created.");
    else status("Drop an image PNG, or a Spine JSON with the region image.");
  } catch (e) { status(e.message, true); }
}
function selectSource() {
  const selected = state.choices?.[Number(targetInput.value)] || null;
  let imageRecord;
  if (selected) {
    const path = basename(selected.path);
    imageRecord = state.images.find(f => basename(f.file.name) === path) ||
      state.images.find(f => basename(f.file.name) === basename(selected.attachment));
  }
  imageRecord ||= state.images[0];
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
function showPreview(mask) {
  if (!state.source) return;
  const w = state.source.width, h = state.source.height;
  const factor = Math.min(1, 1100 / Math.max(w,h));
  canvas.width = Math.max(1, Math.round(w * factor));
  canvas.height = Math.max(1, Math.round(h * factor));
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(state.source, 0,0,canvas.width,canvas.height);
  if (!mask) return;
  const sx = canvas.width / mask.analysisWidth, sy = canvas.height / mask.analysisHeight;
  ctx.beginPath();
  mask.points.forEach(([x,y], i) => { if (!i) ctx.moveTo(x * sx, y * sy); else ctx.lineTo(x * sx, y * sy); });
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 122, 14, 0.12)";
  ctx.fill("evenodd");
  ctx.strokeStyle = "#ff9b28";
  ctx.lineWidth = Math.max(1.25, canvas.width / 700);
  ctx.lineJoin = "round";
  ctx.stroke();
  if ($("show-points").checked && mask.points.length < 1200) {
    ctx.fillStyle = "#75e4ff";
    for (const [x,y] of mask.points) {
      ctx.fillRect(x*sx-1.25, y*sy-1.25, 2.5,2.5);
    }
  }
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
  if (!state.source) { status("Upload the selected image file first.", true); return; }
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
targetInput.addEventListener("change", selectSource);
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
  $("source-name").textContent = "No image supplied";
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
status("Drop a Spine JSON and its images, or just one PNG.");
