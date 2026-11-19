import assert from "node:assert/strict";
import {SkeletonJson,Skeleton,ClippingAttachment} from "@esotericsoftware/spine-core";
import * as core from "../core.js";

const original={
  skeleton:{spine:"4.3.13"},
  bones:[{name:"root"},{name:"left",parent:"root",x:-30},{name:"right",parent:"root",x:30}],
  slots:[
    {name:"image_a",bone:"left"},
    {name:"image_b",bone:"right"}
  ],
  skins:[{name:"default",attachments:{}}],
  animations:{}
};
const points=[[-24,-24],[24,-24],[24,24],[-24,24]];
const weighted=[
  {influences:[{boneIndex:1,x:1,y:2,weight:1}]},
  {influences:[{boneIndex:1,x:3,y:4,weight:1}]},
  {influences:[{boneIndex:2,x:5,y:6,weight:1}]},
  {influences:[{boneIndex:2,x:7,y:8,weight:1}]}
];
const exported=core.exportLocalEditorMultiMask(
  original,["image_a","image_b"],points,"root","image_a","image_b",weighted
);
const loader={
  newRegionAttachment:()=>null,
  newMeshAttachment:()=>null,
  newBoundingBoxAttachment:()=>null,
  newPathAttachment:()=>null,
  newPointAttachment:()=>null,
  newClippingAttachment:(_skin,_placeholder,name)=>new ClippingAttachment(name)
};
const data=new SkeletonJson(loader).readSkeletonData(exported.json);
const skeleton=new Skeleton(data);
skeleton.setupPose();
skeleton.updateWorldTransform(0);
const maskSlot=skeleton.findSlot("auto_mask_multi");
assert.ok(maskSlot,"common-ancestor clipping slot must parse");
const clip=maskSlot.appliedPose.attachment;
assert.ok(clip instanceof ClippingAttachment,"Spine runtime must parse a clipping attachment");
assert.deepEqual(clip.bones,[1,1,1,1,1,2,1,2],"each contour vertex must retain its source bone index");
assert.equal(clip.vertices.length,12,"four weighted vertices must decode to x/y/weight triplets");
const world=()=>{
  const out=new Float32Array(clip.worldVerticesLength);
  clip.computeWorldVertices(skeleton,maskSlot,0,clip.worldVerticesLength,out,0,2);
  return Array.from(out);
};
const before=world();
skeleton.findBone("left").pose.rotation=35;
skeleton.updateWorldTransform(0);
const afterLeft=world();
assert.notDeepEqual(afterLeft.slice(0,4),before.slice(0,4),
  "left-bone contour vertices must follow the left bone");
assert.deepEqual(afterLeft.slice(4,8),before.slice(4,8),
  "right-bone contour vertices must remain independent when only left rotates");
skeleton.findBone("right").pose.rotation=-35;
skeleton.updateWorldTransform(0);
const afterBoth=world();
assert.deepEqual(afterBoth.slice(0,4),afterLeft.slice(0,4),
  "right rotation must not move vertices weighted to left");
assert.notDeepEqual(afterBoth.slice(4,8),afterLeft.slice(4,8),
  "right-bone contour vertices must follow the right bone");
console.log("SPINE43_WEIGHTED_CLIPPING_FOLLOWS_INDEPENDENT_BONES_PASS",{
  vertices:clip.worldVerticesLength/2,bones:clip.bones
});
