#!/usr/bin/env node
/**
 * Offline Spine Runtime 4.3 clipping complexity and desktop CPU probe.
 *
 * Install in an isolated working copy:
 *   npm install --no-save @esotericsoftware/spine-core@4.3.13
 *   node Spine-Mask-Tool/tools/mobile-spine-runtime-audit.mjs \
 *     --before /PRIVATE/baseline-points.json --after /PRIVATE/mask.json \
 *     --skeletons 30 --frames 8
 *
 * Never uploads input files or prints their paths, vertex positions or
 * asset names. The result is not a mobile GPU/CPU performance certification.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {performance} from "node:perf_hooks";
import {SkeletonClipping} from "@esotericsoftware/spine-core";

function option(name, fallback = null) {
  const position = process.argv.indexOf("--" + name);
  return position < 0 ? fallback : process.argv[position + 1] ?? fallback;
}
const beforePath = option("before");
const afterPath = option("after");
if (!beforePath || !afterPath) {
  throw Error("Usage: --before <baseline points JSON> --after <Spine/points JSON> [--skeletons 30] [--frames 8]");
}
const skeletons = Number(option("skeletons", "30"));
const frames = Number(option("frames", "8"));
if (!Number.isSafeInteger(skeletons) || skeletons < 1 || skeletons > 120 ||
    !Number.isSafeInteger(frames) || frames < 2 || frames > 200)
  throw Error("Invalid skeleton or frame count");

function polygonFromDocument(document) {
  if (Array.isArray(document.points)) {
    if (!document.points.every(p => Array.isArray(p) && p.length === 2))
      throw Error("Invalid input polygon points");
    // imageMask() emits points with a downward-positive Y axis.
    return document.points.map(([x, y]) => [Number(x), -Number(y)]);
  }
  const skins = Array.isArray(document.skins)
    ? document.skins : Object.entries(document.skins || {})
      .map(([name, attachments]) => ({name, attachments}));
  const clips = skins.flatMap(skin =>
    Object.values(skin.attachments || {}).flatMap(attachments =>
      Object.values(attachments).filter(a => a?.type === "clipping")));
  if (clips.length !== 1) throw Error("Expected exactly one native clipping attachment");
  const attachment = clips[0];
  if (!Array.isArray(attachment.vertices) ||
      attachment.vertices.length !== attachment.vertexCount * 2)
    throw Error("Invalid native Spine clipping vertex count");
  return Array.from({length: attachment.vertexCount}, (_, i) => [
    attachment.vertices[i * 2], attachment.vertices[i * 2 + 1]
  ]);
}
function loadGeometry(location) {
  const document = JSON.parse(fs.readFileSync(location, "utf8"));
  const points = polygonFromDocument(document);
  if (points.length < 3 || points.length > 10000 ||
      !points.every(p => p.every(Number.isFinite)))
    throw Error("Invalid finite clipping polygon");
  return points;
}
function clippingOnce(points) {
  const coords = points.flat();
  const box = points.reduce((b, [x,y]) => [
    Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)
  ], [Infinity,Infinity,-Infinity,-Infinity]);
  if (!(box[0] < box[2] && box[1] < box[3])) throw Error("Degenerate mask bounds");
  const attachment = {
    worldVerticesLength: coords.length, convex: false, inverse: false,
    computeWorldVertices(_skeleton, _slot, start, length, out, offset, stride) {
      for (let i = 0; i < length; i += 2) {
        out[offset + (i / 2) * stride] = coords[i];
        out[offset + (i / 2) * stride + 1] = coords[i + 1];
      }
    }
  };
  const clip = new SkeletonClipping();
  const t0 = performance.now();
  clip.clipStart(null, null, attachment);
  const t1 = performance.now();
  const polygons = clip.clippingPolygons.length;
  // One representative Spine region (2 triangles) spanning this mask.
  // For real-world performance also count the actual visible clipped meshes.
  const quad = [box[0],box[1],box[2],box[1],box[2],box[3],box[0],box[3]];
  const success = clip.clipTriangles(quad, [0,1,2,2,3,0], 6);
  const t2 = performance.now();
  const clippedTriangles = clip.clippedTriangles.length / 3;
  clip.clipEnd();
  if (!success || polygons < 1) throw Error("Official Spine Runtime clipping failed");
  return {polygons, clippedTriangles, cpuMs: t2 - t0,
    decomposeMs: t1 - t0, clipRegionMs: t2 - t1};
}
function percentile(sorted, n) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * n) - 1)];
}
function measure(points) {
  const once = clippingOnce(points);
  for (let i = 0; i < Math.min(skeletons, 10); i++) clippingOnce(points);
  const perFrame = [];
  for (let frame = 0; frame < frames; frame++) {
    const start = performance.now();
    for (let j = 0; j < skeletons; j++) clippingOnce(points);
    perFrame.push(performance.now() - start);
  }
  perFrame.sort((a,b)=>a-b);
  return {vertices:points.length,convexPolygonsPerSkeleton:once.polygons,
    clippedTrianglesPerSyntheticRegion:once.clippedTriangles,
    convexPolygonsForScene:once.polygons*skeletons,
    sampledFrames:frames,sceneSkeletons:skeletons,
    sceneCpuProbeMsP50:+percentile(perFrame,0.5).toFixed(3),
    sceneCpuProbeMsP95:+percentile(perFrame,0.95).toFixed(3)};
}
function hashAssets(root,base = root,files = new Map()) {
  if(!fs.existsSync(root))throw Error("Asset directory missing");
  const stat=fs.lstatSync(root);
  if(stat.isSymbolicLink())throw Error("Symlink in asset tree");
  if(stat.isDirectory()){
    for(const name of fs.readdirSync(root))
      hashAssets(path.join(root,name),base,files);
  }else if(stat.isFile()){
    const relative=path.relative(base,root);
    files.set(relative,crypto.createHash("sha256").update(fs.readFileSync(root)).digest("hex"));
  }
  return files;
}
const before = measure(loadGeometry(beforePath));
const after = measure(loadGeometry(afterPath));
const report = {
  spineRuntimeVersion: "4.3.13", runtimeImplementation: "official spine-core JavaScript",
  scene: {simulatedSkeletons:skeletons,frames},
  before,after,
  comparison: {
    verticesReductionPercent:+((1-after.vertices/before.vertices)*100).toFixed(2),
    convexPolygonsReductionPercent:+((1-after.convexPolygonsPerSkeleton/before.convexPolygonsPerSkeleton)*100).toFixed(2)
  },
  scope:"Desktop JavaScript CPU probe of clipping setup and one region per skeleton; NOT full animation, GPU, or a mobile-device FPS measurement."
};
const originalAssets=option("source-assets"),resultAssets=option("result-assets");
if(originalAssets || resultAssets) {
 if(!originalAssets || !resultAssets)throw Error("Pass both --source-assets and --result-assets");
 const a=hashAssets(originalAssets),b=hashAssets(resultAssets);
 let missing=0,mismatch=0;
 for(const [name,hash] of a){
   if(!b.has(name))missing++;
   else if(b.get(name)!==hash)mismatch++;
 }
 report.assetPreservation={sourceCount:a.size,missing,mismatch,passed:!missing&&!mismatch};
 if(!report.assetPreservation.passed)process.exitCode=2;
}
console.log(JSON.stringify(report,null,2));
