// Spine Mask Tool geometry and Spine JSON adapter. Client-side only, no external services.
export function imageMask(image, options = {}) {
  const w = image.width, h = image.height, total = w * h;
  if (!w || !h || total > 2400000) throw Error("Image too large (max 2.4 million analysis pixels).");
  const alpha = Math.min(254, Math.max(0, Number(options.alpha ?? 24)));
  const tolerance = Math.max(1, Number(options.tolerance ?? 48));
  const minArea = Math.max(1, Math.round(Number(options.minArea ?? 3)));
  const bridgeWidth = Math.max(1, Math.min(5, Number(options.bridgeWidth ?? 1)));
  const d = image.data, mask = new Uint8Array(total);
  let transparent = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { transparent = true; break; }
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (total - 1) * 4];
  const bg = [0, 1, 2].map(c => Math.round(corners.reduce((s, p) => s + d[p + c], 0) / 4));
  const sq = tolerance * tolerance * 3;
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    mask[i] = transparent ? (d[p + 3] >= alpha ? 1 : 0) :
      (((d[p] - bg[0]) ** 2 + (d[p + 1] - bg[1]) ** 2 + (d[p + 2] - bg[2]) ** 2) > sq ? 1 : 0);
  }
  // AI-agent mode: infer bright face material from the image itself.
  // No slider threshold is required; 3-class histogram segmentation separates
  // the dark extrusion, mid-tones and highlights from actual image pixels.
  const highlightRequested = options.highlightFaces === true;
  let highlight = { applied: false, reason: "disabled", weights: null, cutoff: 0 };
  if (highlightRequested) highlight = findLightFaces(d, mask, total);
  if (highlight.applied) mask.set(highlight.binary);
  let comps = regions(mask, w, h, 1);
  let removed = 0;
  for (const comp of comps) if (comp.pixels.length < minArea) {
    for (const p of comp.pixels) mask[p] = 0;
    removed++;
  }
  comps = regions(mask, w, h, 1);
  // Visible silhouette is captured BEFORE any connector or inner-hole slit.
  // This is the only coverage map used for rendering second images. It prevents
  // even one pixel of the invisible single-clip routing geometry from appearing.
  const visibleMask = new Uint8Array(mask);
  const visibleAlpha = new Uint8ClampedArray(total);
  for (let i = 0; i < total; i++) {
    if (!visibleMask[i]) continue;
    const baseAlpha = transparent ? d[i * 4 + 3] : 255;
    visibleAlpha[i] = highlight.applied ? Math.round(baseAlpha * highlight.weights[i] / 255) : baseAlpha;
  }
  if (!comps.length) throw Error("No opaque artwork found. Adjust alpha/background threshold.");
  if (comps.length > 150) throw Error("Too many disconnected shapes (over 150). Increase minimum area.");
  let bridges = 0;
  // Build a minimum-cost connected tree across the foreground islands.
  if (comps.length > 1) {
    const connected = new Set([0]);
    while (connected.size !== comps.length) {
      let best = null;
      for (let a = 0; a < comps.length; a++) if (connected.has(a)) {
        for (let b = 0; b < comps.length; b++) if (!connected.has(b)) {
          const as = samples(comps[a].border, 250), bs = samples(comps[b].border, 250);
          for (const u of as) for (const v of bs) {
            const dx = u % w - v % w, dy = Math.floor(u / w) - Math.floor(v / w);
            const dist = dx * dx + dy * dy;
            if (!best || dist < best.dist) best = { a, b, u, v, dist };
          }
        }
      }
      if (!best) throw Error("Unable to connect shapes.");
      paintLine(mask, w, h, best.u % w, Math.floor(best.u / w),
        best.v % w, Math.floor(best.v / w), 1, bridgeWidth);
      connected.add(best.b);
      bridges++;
    }
  }
  // Turn every enclosed background hole into a narrow slit to the exterior.
  // A clipping attachment supports ONE simple polygon, not explicit holes.
  // Ignore only tiny enclosed antialiasing pinholes. These can also form
  // where two islands meet after the connector tree is constructed.
  // Larger openings (eg letter counters) are always preserved.
  let filledPinholes = 0;
  for (const component of regions(mask, w, h, 0)) {
    if (component.touches || component.pixels.length > 2) continue;
    for (const p of component.pixels) mask[p] = 1;
    filledPinholes++;
  }
  let slits = 0, holeSeeds = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const back = regions(mask, w, h, 0);
    const outer = new Uint8Array(total);
    const exterior = back.filter(c => c.touches);
    for (const c of exterior) for (const p of c.pixels) outer[p] = 1;
    const holes = back.filter(c => !c.touches);
    if (!holes.length) break;
    if (holes.length > 200) throw Error("Over 200 internal holes; increase threshold.");
    let progress = 0;
    for (const hole of holes) {
      if (attempt === 0) holeSeeds.push(hole.pixels[Math.floor(hole.pixels.length / 2)]);
      const cut = safeSlit(hole, mask, outer, w, h);
      if (!cut) continue;
      paintLine(mask, w, h, cut.x1, cut.y1, cut.x2, cut.y2, 0, 1);
      slits++; progress++;
    }
    if (!progress) throw Error("Cannot safely join inner letter contours. Adjust settings.");
  }
  const remaining = regions(mask, w, h, 0).filter(c => !c.touches);
  if (remaining.length) throw Error("Internal holes remain unconnected: " + remaining.length);
  if (regions(mask, w, h, 1).length !== 1) throw Error("The shape is disconnected after bridging; increase bridge width.");
  const loops = traceBoundary(mask, w, h);
  if (loops.length !== 1) throw Error("Expected one continuous outline, received " + loops.length + ".");
  const raw = compressCollinear(loops[0]);
  let polygon = null;
  const desiredEpsilon = Math.max(0, Math.min(3, Number(options.simplify ?? 0.55)));
  // Never sacrifice hole exclusions or polygon simplicity for aggressive reduction.
  for (const eps of [desiredEpsilon, desiredEpsilon / 2, desiredEpsilon / 4, 0]) {
    const candidate = eps ? simplifyRing(raw, eps) : raw;
    if (candidate.length < 3) continue;
    if (candidate.length > 5000 || intersects(candidate)) continue;
    if (holeSeeds.some(p => pointInPolygon((p % w) + 0.5, Math.floor(p / w) + 0.5, candidate))) continue;
    polygon = candidate;
    break;
  }
  if (!polygon) throw Error("No simple, valid single-contour polygon could be formed.");
  // 30 live mobile skeletons x 240 vertices = 7,200 total clipping
  // vertices. This is a configurable agent-side concurrency assumption,
  // never a manual slider and never a guaranteed device-independent FPS.
  const simultaneous = Math.max(1, Math.min(120, Math.round(Number(options.concurrentSkeletons ?? 30) || 30)));
  const vertexBudget = Math.min(320, Math.max(80, Math.floor(7200 / simultaneous)));
  const optimized = reduceContourVertices(polygon, visibleAlpha, holeSeeds, d, w, h, vertexBudget, highlight.applied);
  if (!optimized.qualityPassed) {
    throw Error("Mobile clipping budget (" + vertexBudget +
      " vertices at " + simultaneous + " skeletons) cannot preserve light faces and holes safely.");
  }
  polygon = optimized.points;
  return {
    points: polygon, analysisWidth: w, analysisHeight: h, binary: mask,
    visibleMask, visibleAlpha,
    stats: { vertices: polygon.length, mobileVertexBudget: vertexBudget,
      concurrentSkeletons: simultaneous, totalSceneClippingVertices: polygon.length * simultaneous,
      verticesBeforeOptimization: optimized.before,
      vertexReductionPercent: Math.round(100 * (1 - polygon.length / optimized.before)),
      contourDriftPixels: optimized.drift, optimizationAccepted: optimized.accepted,
      darkLeakPixels: optimized.dark, darkLeakPercent: optimized.darkPercent,
      missingLightPixels: optimized.missing, missingLightPercent: optimized.missingPercent,
      innerHolesPreserved: optimized.holesPreserved, mobileQualityPassed: optimized.qualityPassed,
      shapes: comps.length, bridges, slits, filledPinholes, ignored: removed, transparent,
      highlightRequested, highlightApplied: highlight.applied, highlightReason: highlight.reason, highlightCutoff: highlight.cutoff }
  };
}
// Mobile performance profile. 30 simultaneously visible skeletons share a
// 7,200 clipping-vertex budget. Geometry is optimized once at authoring time;
// no manual sliders or repeated per-frame optimization are added.
function contourPixels(points,w,h){
  const out=new Uint8Array(w*h);
  for(let y=0;y<h;y++){
    const yy=y+.5,xs=[];
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const a=points[i],b=points[j];
      if((a[1]>yy)===(b[1]>yy))continue;
      xs.push(a[0]+(yy-a[1])*(b[0]-a[0])/(b[1]-a[1]));
    }
    xs.sort((a,b)=>a-b);
    for(let j=0;j+1<xs.length;j+=2){
      const left=Math.max(0,Math.ceil(xs[j]-.5));
      const right=Math.min(w-1,Math.floor(xs[j+1]-.5));
      if(right>=left)out.fill(1,y*w+left,y*w+right+1);
    }
  }
  return out;
}
function optimizeMobilePolygon(base,visibleAlpha,holeSeeds,rgba,w,h,limit,darkWeight,protectHighlights){
  const n=base.length,prev=new Int32Array(n),next=new Int32Array(n);
  const alive=new Uint8Array(n).fill(1),versions=new Uint32Array(n);
  for(let i=0;i<n;i++){prev[i]=(i+n-1)%n;next[i]=(i+1)%n;}
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const holes=holeSeeds.map(t=>[t%w+.5,Math.floor(t/w)+.5]);
  const coverage=contourPixels(base,w,h);
  const isDark=new Uint8Array(w*h),isOpaque=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){
    const p=i*4;
    if(rgba[p+3]<=20)continue;
    isOpaque[i]=1;
    if(protectHighlights&&.2126*rgba[p]+.7152*rgba[p+1]+.0722*rgba[p+2]<50)isDark[i]=1;
  }
  const score=(i,covered)=>{
    if(covered){
      if(isDark[i])return darkWeight;
      if(visibleAlpha[i]>0)return -6;
      return isOpaque[i]?4:.15;
    }
    return visibleAlpha[i]>0?10:0;
  };
  const intersectsSegment=(a,b,c,d)=>{
    if(Math.max(a[0],b[0])<Math.min(c[0],d[0])||
      Math.max(c[0],d[0])<Math.min(a[0],b[0])||
      Math.max(a[1],b[1])<Math.min(c[1],d[1])||
      Math.max(c[1],d[1])<Math.min(a[1],b[1]))return false;
    const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),t=cross(c,d,b);
    return (x>=0&&y<=0||x<=0&&y>=0)&&(z>=0&&t<=0||z<=0&&t>=0);
  };
  let count=n;
  function validChord(i){
    const l=prev[i],r=next[i],a=base[l],b=base[r],c=base[i];
    if(l===r||Math.abs(cross(a,c,b))<1e-7)return false;
    const det=cross(a,c,b);
    // Protect every real letter counter from being filled over.
    for(const p of holes){
      const u=cross(a,c,p)/det,v=cross(c,b,p)/det,t=cross(b,a,p)/det;
      if(u>=-1e-8&&v>=-1e-8&&t>=-1e-8)return false;
    }
    for(let j=0;j<n;j++){
      if(!alive[j])continue;
      const k=next[j];
      if(j===l||j===i||j===r||k===l||k===i||k===r)continue;
      if(intersectsSegment(a,b,base[j],base[k]))return false;
    }
    return true;
  }
  function trianglePixels(i,fn){
    const a=base[prev[i]],b=base[i],c=base[next[i]];
    const x0=Math.max(0,Math.ceil(Math.min(a[0],b[0],c[0])-.5));
    const x1=Math.min(w-1,Math.floor(Math.max(a[0],b[0],c[0])-.5));
    const y0=Math.max(0,Math.ceil(Math.min(a[1],b[1],c[1])-.5));
    const y1=Math.min(h-1,Math.floor(Math.max(a[1],b[1],c[1])-.5));
    const det=cross(a,b,c);
    if(Math.abs(det)<1e-8)return;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const point=[x+.5,y+.5];
      const u=cross(a,b,point)/det,v=cross(b,c,point)/det,t=cross(c,a,point)/det;
      if(u>1e-8&&v>1e-8&&t>1e-8)fn(y*w+x);
    }
  }
  const heap=[];
  function push(item){
    if(!item)return;
    let k=heap.length;heap.push(item);
    while(k>0){const p=(k-1)>>1;if(heap[p].cost<=item.cost)break;heap[k]=heap[p];k=p;}
    heap[k]=item;
  }
  function pop(){
    if(!heap.length)return null;
    const top=heap[0],last=heap.pop();
    if(!heap.length)return top;
    let k=0;
    while(k*2+1<heap.length){
      let child=k*2+1;
      if(child+1<heap.length&&heap[child+1].cost<heap[child].cost)child++;
      if(heap[child].cost>=last.cost)break;
      heap[k]=heap[child];k=child;
    }
    heap[k]=last;
    return top;
  }
  function candidate(i){
    if(!alive[i]||count<=3||!validChord(i))return null;
    let delta=0,pixels=0;
    trianglePixels(i,t=>{
      delta+=score(t,!coverage[t])-score(t,!!coverage[t]);
      pixels++;
    });
    return {i,cost:delta+Math.abs(cross(base[prev[i]],base[i],base[next[i]]))*.018,
      pixels,version:versions[i]};
  }
  for(let i=0;i<n;i++)push(candidate(i));
  const started=Date.now();
  while(count>limit&&heap.length&&Date.now()-started<2500){
    const item=pop();
    if(!item||!alive[item.i]||versions[item.i]!==item.version)continue;
    const fresh=candidate(item.i);
    if(!fresh)continue;
    if(fresh.pixels!==item.pixels||Math.abs(fresh.cost-item.cost)>1e-5){
      versions[item.i]++;push(candidate(item.i));continue;
    }
    const i=item.i,l=prev[i],r=next[i];
    trianglePixels(i,t=>{coverage[t]^=1;});
    alive[i]=0;next[l]=r;prev[r]=l;count--;
    for(const j of [l,r,prev[l],next[r]]){
      if(alive[j]){versions[j]++;push(candidate(j));}
    }
  }
  const polygon=[];
  if(count>=3){
    let start=alive.indexOf(1),pos=start;
    do{
      polygon.push(base[pos]);
      pos=next[pos];
    }while(pos!==start&&polygon.length<=n);
  }
  return polygon;
}
function evaluateMobileMask(polygon,baseline,visibleAlpha,holeSeeds,rgba,w,h,budget,protectHighlights){
  if(polygon.length>budget||polygon.length<3||intersects(polygon)||
     holeSeeds.some(t=>pointInPolygon(t%w+.5,Math.floor(t/w)+.5,polygon)))return null;
  const pixels=contourPixels(polygon,w,h);
  let darkTotal=0,dark=0,missing=0,extra=0,drift=0,lightTotal=0;
  for(let i=0;i<w*h;i++){
    const p=i*4,opaque=rgba[p+3]>20,highlight=visibleAlpha[i]>0;
    const low=protectHighlights&&opaque&&(.2126*rgba[p]+.7152*rgba[p+1]+.0722*rgba[p+2]<50);
    if(low)darkTotal++;
    if(highlight){lightTotal++;if(!pixels[i])missing++;}
    if(pixels[i]&&low)dark++;
    if(pixels[i]&&!highlight&&opaque&&!low)extra++;
    if(pixels[i]!==baseline[i])drift++;
  }
  const darkPct=darkTotal?dark/darkTotal*100:0;
  const missingPct=lightTotal?missing/lightTotal*100:0;
  if(darkPct>3||missingPct>7||extra>Math.ceil(lightTotal*.045)||
     drift>Math.ceil(w*h*.056))return null;
  return {points:polygon,dark,missing,drift,darkPercent:+darkPct.toFixed(2),
    missingPercent:+missingPct.toFixed(2),holesPreserved:true};
}
function reduceContourVertices(base,alpha,holeSeeds,rgba,w,h,budget,protectHighlights){
  const before=base.length;
  const initial=contourPixels(base,w,h);
  if(before<=budget){
    const accepted=evaluateMobileMask(base,initial,alpha,holeSeeds,rgba,w,h,budget,protectHighlights);
    return {points:base,before,drift:0,dark:accepted?.dark??0,
      darkPercent:accepted?.darkPercent??0,missing:accepted?.missing??0,
      missingPercent:accepted?.missingPercent??0,holesPreserved:!!accepted,
      qualityPassed:!!accepted,accepted:false};
  }
  // Cost: very high for including shadow pixels, high for removing a bright
  // face, moderate for including other opaque pixels, negligible outside alpha.
  // Try progressively stricter shadow penalties only when a candidate fails
  // the automatic visual-quality gate.
  for(const darkWeight of (protectHighlights?[80,120,200]:[0])){
    const candidate=optimizeMobilePolygon(base,alpha,holeSeeds,rgba,w,h,budget,darkWeight,protectHighlights);
    const evaluation=evaluateMobileMask(candidate,initial,alpha,holeSeeds,rgba,w,h,budget,protectHighlights);
    if(evaluation)return {...evaluation,before,accepted:true,qualityPassed:true};
  }
  return {points:base,before,drift:0,dark:0,darkPercent:0,missing:0,
    missingPercent:0,holesPreserved:false,accepted:false,qualityPassed:false};
}
// Histogram-driven segmentation; all image processing takes place in browser
// memory. This function does not upload or retain source pixels.
function findLightFaces(rgba, foreground, count) {
  const hist = new Uint32Array(256);
  const strength = new Uint8Array(count);
  let used = 0;
  for (let i = 0; i < count; i++) {
    if (!foreground[i]) continue;
    const p = i*4, r=rgba[p], g=rgba[p+1], b=rgba[p+2];
    const luminance=0.2126*r + 0.7152*g + 0.0722*b;
    // Green-channel contribution distinguishes illuminated gold faces from
    // red-brown extrusion while remaining compatible with grayscale lettering.
    const value = Math.min(255, Math.max(0, Math.round(0.62*luminance+0.38*g)));
    strength[i] = value; hist[value]++; used++;
  }
  if (used < 32) return {applied:false, reason:"insufficient_foreground"};
  let low=0, high=255;
  while (low<255&&!hist[low])low++;
  while (high>0&&!hist[high])high--;
  if (high-low<28) return {applied:false, reason:"uniform_light"};
  const weight=new Float64Array(256), sum=new Float64Array(256);
  let w=0, s=0;
  for(let i=0;i<256;i++){w+=hist[i];s+=hist[i]*i;weight[i]=w;sum[i]=s;}
  // Optimal three-class thresholds, a parameter-free multi-Otsu partition.
  let best=-Infinity, tDark=low, tLight=high;
  for(let a=low+3;a<high-7;a++){
    const wa=weight[a];if(wa<used*.015)continue;
    const sa=sum[a];
    for(let b=a+5;b<high-2;b++){
      const wb=weight[b]-wa,wc=used-weight[b];
      if(wb<used*.025 || wc<used*.025)continue;
      const sb=sum[b]-sa,sc=s-sum[b];
      const score=(sa*sa/wa)+(sb*sb/wb)+(sc*sc/wc);
      if(score>best){best=score;tDark=a;tLight=b;}
    }
  }
  if(!Number.isFinite(best))return {applied:false,reason:"low_contrast"};
  const cutoff=Math.max(0,Math.min(254,Math.round(tDark+(tLight-tDark)*.10)));
  const binary=new Uint8Array(count),weights=new Uint8Array(count);
  let selected=0;
  for(let i=0;i<count;i++){
    if(!foreground[i])continue;
    const v=strength[i];
    if(v<=cutoff)continue;
    binary[i]=1;selected++;
    // 4-unit soft boundary reduces jagged edge flicker without admitting
    // dark-shadow regions or allowing any alpha on routing bridges.
    weights[i]=Math.min(255,Math.round(255*(v-cutoff)/5));
  }
  if(selected<Math.max(24,used*.12))return {applied:false,reason:"low_highlight_coverage"};
  if(selected>used*.985)return {applied:false,reason:"already_bright"};
  return {applied:true,reason:"auto_three_class",binary,weights,cutoff};
}
function samples(a, max) {
  if (a.length <= max) return a;
  const out = []; for (let i = 0; i < max; i++) out.push(a[Math.floor(i * a.length / max)]);
  return out;
}
function regions(pixels, w, h, wanted) {
  const seen = new Uint8Array(w * h), found = [], n = pixels.length;
  for (let start = 0; start < n; start++) {
    if (seen[start] || pixels[start] !== wanted) continue;
    const q = [start]; seen[start] = 1;
    let touches = false;
    const border = [];
    for (let k = 0; k < q.length; k++) {
      const p = q[k], x = p % w, y = (p / w) | 0;
      if (!x || !y || x === w - 1 || y === h - 1) touches = true;
      const neighbors = [];
      if (x) neighbors.push(p - 1);
      if (x < w - 1) neighbors.push(p + 1);
      if (y) neighbors.push(p - w);
      if (y < h - 1) neighbors.push(p + w);
      if (neighbors.length < 4 || neighbors.some(t => pixels[t] !== wanted)) border.push(p);
      for (const t of neighbors) if (!seen[t] && pixels[t] === wanted) { seen[t] = 1; q.push(t); }
    }
    found.push({ pixels: q, border, touches });
  }
  return found;
}
function paintLine(mask, w, h, x1, y1, x2, y2, value, width) {
  let x = x1, y = y1, dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  const radius = width / 2;
  while (true) {
    for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(h - 1, Math.ceil(y + radius)); yy++)
      for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(w - 1, Math.ceil(x + radius)); xx++)
        if ((xx - x) ** 2 + (yy - y) ** 2 <= Math.max(0.26, radius * radius + 0.25)) mask[yy * w + xx] = value;
    if (x === x2 && y === y2) break;
    const e2 = err * 2;
    let horizontal = false;
    if (e2 > -dy) { err -= dy; x += sx; horizontal = true; }
    if (e2 < dx) {
      // One-pixel bridges must remain 4-connected even on diagonal routes.
      if (horizontal && x >= 0 && x < w && y >= 0 && y < h) mask[y * w + x] = value;
      err += dx; y += sy;
    }
  }
}
function safeSlit(hole, mask, outside, w, h) {
  const candidates = [], seen = new Set();
  // Straight shortest cuts can sever narrow bridges. Check each candidate
  // on a temporary mask and accept only cuts preserving a connected foreground.
  for (const p of samples(hole.border, 650)) {
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let xx = x + dx, yy = y + dy, solid = 0;
      while (xx >= 0 && xx < w && yy >= 0 && yy < h && solid < 350) {
        const index = yy * w + xx;
        if (!mask[index]) {
          if (outside[index] && solid) {
            const key = [x, y, xx, yy].join(":");
            if (!seen.has(key)) {
              seen.add(key);
              candidates.push({ x1: x, y1: y, x2: xx, y2: yy, solid });
            }
          }
          break;
        }
        solid++; xx += dx; yy += dy;
      }
    }
  }
  candidates.sort((a, b) => a.solid - b.solid);
  for (const cut of candidates) {
    const trial = new Uint8Array(mask);
    paintLine(trial, w, h, cut.x1, cut.y1, cut.x2, cut.y2, 0, 1);
    if (regions(trial, w, h, 1).length === 1) return cut;
  }
  return null;
}
function traceBoundary(mask, w, h) {
  const edges = [], starts = new Map();
  function add(x, y, xx, yy, dir) {
    const e = { x, y, xx, yy, dir }, idx = edges.push(e) - 1;
    const key = y * (w + 1) + x;
    if (!starts.has(key)) starts.set(key, []);
    starts.get(key).push(idx);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!mask[p]) continue;
    if (!y || !mask[p - w]) add(x, y, x + 1, y, 0);
    if (x === w - 1 || !mask[p + 1]) add(x + 1, y, x + 1, y + 1, 1);
    if (y === h - 1 || !mask[p + w]) add(x + 1, y + 1, x, y + 1, 2);
    if (!x || !mask[p - 1]) add(x, y + 1, x, y, 3);
  }
  const used = new Uint8Array(edges.length), loops = [];
  for (let k = 0; k < edges.length; k++) {
    if (used[k]) continue;
    let at = k, loop = [], steps = 0;
    while (true) {
      const e = edges[at]; used[at] = 1; loop.push([e.x, e.y]);
      if (e.xx === edges[k].x && e.yy === edges[k].y) break;
      const opts = (starts.get(e.yy * (w + 1) + e.xx) || []).filter(t => !used[t]);
      opts.sort((a, b) => ((edges[a].dir - e.dir + 4) % 4) - ((edges[b].dir - e.dir + 4) % 4));
      if (!opts.length) throw Error("Found an open boundary; modify bridge width.");
      at = opts[0];
      if (++steps > edges.length) throw Error("Boundary traversal overflow.");
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}
function compressCollinear(a) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const p = a[(i + a.length - 1) % a.length], q = a[i], r = a[(i + 1) % a.length];
    if ((q[0] - p[0]) * (r[1] - q[1]) !== (q[1] - p[1]) * (r[0] - q[0])) out.push(q);
  }
  return out;
}
function simplifyRing(points, eps) {
  if (points.length < 6) return points;
  const half = Math.floor(points.length / 2);
  const left = rdp(points.slice(0, half + 1), eps);
  const right = rdp(points.slice(half).concat([points[0]]), eps);
  return left.slice(0, -1).concat(right.slice(0, -1));
}
function rdp(points, eps) {
  if (points.length <= 2) return points;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
  let largest = -1, idx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2)) : 0;
    const distance = Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
    if (distance > largest) { largest = distance; idx = i; }
  }
  if (largest <= eps) return [points[0], points[points.length - 1]];
  return rdp(points.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(points.slice(idx), eps));
}
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++)
    if (((points[i][1] > y) !== (points[j][1] > y)) &&
        x < (points[j][0] - points[i][0]) * (y - points[i][1]) / (points[j][1] - points[i][1]) + points[i][0])
      inside = !inside;
  return inside;
}
function intersects(points) {
  const n = points.length;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = points[j], d = points[(j + 1) % n];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
          Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
          Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
          Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
      const c1 = cross(a,b,c), c2 = cross(a,b,d), c3 = cross(c,d,a), c4 = cross(c,d,b);
      if ((c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0) ||
          ((c1 >= 0 && c2 <= 0 || c1 <= 0 && c2 >= 0) &&
           (c3 >= 0 && c4 <= 0 || c3 <= 0 && c4 >= 0))) return true;
    }
  }
  return false;
}
export function availableRegions(json) {
  const result = [];
  if (!json || !Array.isArray(json.slots)) return result;
  const skins = Array.isArray(json.skins) ? json.skins :
    Object.entries(json.skins || {}).map(([name, attachments]) => ({ name, attachments }));
  for (const skin of skins) for (const [slot, names] of Object.entries(skin.attachments || {}))
    for (const [attachment, data] of Object.entries(names || {}))
      if (!data.type || data.type === "region") result.push({
        skin: skin.name || "default", slot, attachment, path: data.path || attachment, data
      });
  return result;
}
export function maskVertices(points, sourceW, sourceH, region = {}) {
  const width = Number(region.width) || sourceW, height = Number(region.height) || sourceH;
  const x = Number(region.x) || 0, y = Number(region.y) || 0;
  const sx = Number(region.scaleX ?? 1), sy = Number(region.scaleY ?? 1);
  const r = (Number(region.rotation) || 0) * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r), out = [];
  for (const [px, py] of points) {
    const lx = (px / sourceW - 0.5) * width * sx;
    const ly = (0.5 - py / sourceH) * height * sy;
    out.push(round(x + c * lx - s * ly), round(y + s * lx + c * ly));
  }
  return out;
}
const round = n => Math.round(n * 10000) / 10000;

// Re-running a mask on an already processed Spine project must update its
// existing clipping attachment rather than adding another slot. The native
// host accepts exactly one non-overlay clipping mask per project.
function updateExistingMask(data, targetName, vertices, vertexCount) {
  const slots = data.slots || [];
  const generated = slots.filter(slot => slot.name?.startsWith("auto_mask_"));
  if (!generated.length) return null;
  if (generated.length !== 1)
    throw Error("Multiple generated masks already exist; choose an original project.");
  const slot = generated[0];
  const targetIndex = slots.findIndex(entry => entry.name === targetName);
  if (targetIndex < 1 || slots[targetIndex - 1]?.name !== slot.name || slot.attachment !== "clip")
    throw Error("Existing mask belongs to another target or has an unsafe draw order.");
  const skins = Array.isArray(data.skins) ? data.skins :
    Object.entries(data.skins || {}).map(([name,attachments])=>({name,attachments}));
  let count = 0;
  for (const skin of skins) {
    const clip = skin.attachments?.[slot.name]?.clip;
    if (!clip) continue;
    if (clip.type !== "clipping" || clip.end !== targetName)
      throw Error("Existing clipping mask ends at the wrong Spine slot.");
    clip.vertices = vertices.slice();
    clip.vertexCount = vertexCount;
    count++;
  }
  if (!count) throw Error("Existing clipping attachment is missing from skins.");
  return slot.name;
}
export function exportJson(original, target, points, sourceW, sourceH) {
  const data = original ? JSON.parse(JSON.stringify(original)) : {
    skeleton: { spine: "4.3.26", x: -sourceW / 2, y: -sourceH / 2, width: sourceW, height: sourceH, images: "./images/" },
    bones: [{ name: "root" }],
    slots: [{ name: "image", bone: "root", attachment: "image" }],
    skins: [{ name: "default", attachments: {
      image: { image: { type: "region", path: "image", width: sourceW, height: sourceH } }
    }}]
  };
  if (!Array.isArray(data.slots) || !data.slots.length) throw Error("Skeleton has no slots.");
  const selected = target || { slot: "image", attachment: "image", skin: "default", data: { width: sourceW, height: sourceH } };
  const ix = data.slots.findIndex(s => s.name === selected.slot);
  if (ix < 0) throw Error("Selected slot does not exist.");
  const slot = data.slots[ix];
  const base = "auto_mask_" + selected.slot.replace(/[^a-zA-Z0-9_]/g, "_");
  let name = base, suffix = 1;
  while (data.slots.some(s => s.name === name)) name = base + "_" + (suffix++);
  const values = maskVertices(points, sourceW, sourceH, selected.data);
  const existing = updateExistingMask(data, selected.slot, values, points.length);
  if (existing) return { json:data, slot:existing };
  data.slots.splice(ix, 0, { name, bone: slot.bone, attachment: "clip" });
  const clip = { type: "clipping", end: selected.slot, vertexCount: points.length,
    vertices: values, color: "ff9911ff" };
  if (Array.isArray(data.skins)) {
    let skin = data.skins.find(s => s.name === selected.skin);
    if (!skin) { skin = { name: selected.skin || "default", attachments: {} }; data.skins.push(skin); }
    skin.attachments ||= {}; skin.attachments[name] = { clip };
    if (skin.name !== "default") {
      let def = data.skins.find(s => s.name === "default");
      if (def) { def.attachments ||= {}; def.attachments[name] = { clip }; }
    }
  } else {
    data.skins ||= {}; data.skins[selected.skin || "default"] ||= {};
    data.skins[selected.skin || "default"][name] = { clip };
  }
  return { json: data, slot: name };
}


// Merge a new clipping+overlay pair into an EXISTING Spine skeleton.
// The original target region, animation, mesh data and draw order are retained.
// The mask clips only the NEW overlay, not the original artwork.
// A native Spine clipping attachment directly clips the ORIGINAL target slot.
// No overlay slot or replacement image is created. Slot order is changed only
// by inserting one nonrendering clipping slot immediately before its target.
export function exportLocalEditorMask(original,target,points,sourceW,sourceH) {
  if(!original||!target||!Array.isArray(points)||points.length<3)
    throw Error("Existing Spine JSON, target image and valid mask required.");
  if(points.length>2500)throw Error("Clipping mask exceeds 2500 vertices.");
  const json=JSON.parse(JSON.stringify(original));
  const index=json.slots?.findIndex(s=>s.name===target.slot);
  if(index===undefined||index<0)throw Error("Target Spine slot not found.");
  const originalSlot=json.slots[index];
  const vertices=maskVertices(points,sourceW,sourceH,target.data);
  const existing=updateExistingMask(json,target.slot,vertices,points.length);
  if(existing) return {json,clippingSlot:existing,targetSlot:target.slot};
  const base="auto_mask_"+target.slot.replace(/[^a-zA-Z0-9_]/g,"_");
  let clippingSlot=base,n=2;
  while(json.slots.some(s=>s.name===clippingSlot))clippingSlot=base+"_"+n++;
  const clip={type:"clipping",end:target.slot,vertexCount:points.length,
    vertices};
  json.slots.splice(index,0,{name:clippingSlot,bone:originalSlot.bone,attachment:"clip"});
  const skins=Array.isArray(json.skins)?json.skins:
    Object.entries(json.skins||{}).map(([name,attachments])=>({name,attachments}));
  const matching=skins.filter(s=>s.attachments?.[target.slot]?.[target.attachment]);
  if(!matching.length)throw Error("Selected Spine image missing from skins.");
  for(const skin of matching){
    skin.attachments[clippingSlot]={clip:JSON.parse(JSON.stringify(clip))};
  }
  if(!Array.isArray(json.skins)){
    for(const skin of skins)json.skins[skin.name]=skin.attachments;
  }
  // Existing draw-order animation offsets refer to skeleton slot indices.
  // Adjust only their numeric offsets when the inserted clipping slot is
  // crossed; preserve every original slot, keyframe and attachment.
  for(const animation of Object.values(json.animations||{})){
    for(const frame of animation.drawOrder||animation.draworder||[]){
      for(const offset of frame.offsets||[]){
        const originalIndex=original.slots.findIndex(s=>s.name===offset.slot);
        if(originalIndex<0)continue;
        const dest=originalIndex+offset.offset;
        const mappedFrom=originalIndex>=index?originalIndex+1:originalIndex;
        const mappedTo=dest>=index?dest+1:dest;
        offset.offset=mappedTo-mappedFrom;
      }
    }
  }
  return {json,clippingSlot,targetSlot:target.slot};
}
