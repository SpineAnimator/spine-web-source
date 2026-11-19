// Live public-site regression for the manual hierarchy selection and combined clipping mask.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
const require=createRequire(import.meta.url);
const {chromium}=require(path.join(process.env.RUNNER_TEMP,"mask-ui/node_modules/playwright"));
const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
const page=await browser.newPage({acceptDownloads:true});
const errors=[];page.on("pageerror",e=>errors.push(e.message));
await page.addInitScript(()=>{
  const original=window.fetch.bind(window);
  window.fetch=(input,...args)=>{
    const url=String(input);
    if(url.includes("workers.dev")||url.includes("/v2/"))return Promise.reject(new Error("UI-only CI blocks external project upload"));
    return original(input,...args);
  };
});
try{
  const url=process.env.SPINE_MASK_TEST_URL||"https://spineanimator.github.io/Spine-Mask-Tool/";
  const response=await page.goto(url,{waitUntil:"load",timeout:60000});
  assert.equal(response.status(),200);
  await page.waitForFunction(()=>!!window.SpineMaskAgentControl,{timeout:45000});
  assert.equal(await page.locator("#do-all").isVisible(),true);
  assert.equal(await page.locator("#quick-from-spine").isVisible(),true);
  assert.equal(await page.locator("#agent-toggle").isVisible(),true);
  const simpleSurface=await page.evaluate(()=>{
    const hidden=[".chips",".fields",".control-panel",".file-zone",".preview-head",
      ".preview-meta",".actions",".status-line",".quick-bridge-status",".quick-hint",".version"];
    return {agentMode:document.body.classList.contains("agent-mode"),
      hidden:hidden.every(selector=>{
        const e=document.querySelector(selector);
        return !e||getComputedStyle(e).display==="none"||getComputedStyle(e).visibility==="hidden";
      }),text:document.body.innerText};
  });
  assert.equal(simpleSurface.agentMode,false,"Simple must be the default mode");
  assert.equal(simpleSurface.hidden,true,"Simple mode must hide explanatory and advanced text");
  assert.match(simpleSurface.text,/Spine Mask Tool/);
  assert.match(simpleSurface.text,/Agents/);
  assert.match(simpleSurface.text,/Сделать маску/);
  assert.match(simpleSurface.text,/Install Bridge/);
  assert.doesNotMatch(simpleSurface.text,/Drop files|No image supplied|One clipping mask|Spine Editor Bridge/);
  console.log("PUBLIC_SITE_BOOT",{
    selectionTree:await page.locator("#selection-tree").count(),
    projectFiles:await page.locator("#project-files").count(),
    makeButton:await page.locator("#do-all").textContent()
  });
  const png64=await page.evaluate(()=>{
    const c=document.createElement("canvas");c.width=64;c.height=64;
    const g=c.getContext("2d");g.fillStyle="#ffb320";g.fillRect(5,5,54,54);
    g.clearRect(20,17,24,12);g.clearRect(20,37,24,12);
    return c.toDataURL("image/png").split(",")[1];
  });
  const texture=Buffer.from(png64,"base64");
  const scene={skeleton:{spine:"4.3.26",width:124,height:64,images:"./images/"},
    bones:[{name:"root"},{name:"left",parent:"root",x:-30},{name:"right",parent:"root",x:30},{name:"spacer",parent:"root",y:120}],
    slots:[
      {name:"image_a",bone:"left",attachment:"partA"},
      {name:"spacer",bone:"spacer",attachment:"partSpacer"},
      {name:"image_b",bone:"right",attachment:"partB"},
      {name:"hotspot",bone:"root",attachment:"hotspot"}
    ],
    skins:[{name:"default",attachments:{
      image_a:{partA:{type:"region",path:"part-a",width:48,height:48}},
      spacer:{partSpacer:{type:"region",path:"spacer",width:8,height:8}},
      image_b:{partB:{type:"region",path:"part-b",width:48,height:48}},
      hotspot:{hotspot:{type:"region",path:"hotspot",width:8,height:8}}
    }}],animations:{idle:{bones:{left:{rotate:[{time:0,angle:0},{time:1,angle:25}]},right:{rotate:[{time:0,angle:0},{time:1,angle:-25}]}}}}};
  const picker=page.waitForEvent("filechooser",{timeout:15000});
  await page.locator("#do-all").click();
  const dialog=await picker;
  await dialog.setFiles([
    {name:"scene.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(scene))},
    {name:"part-a.png",mimeType:"image/png",buffer:texture},
    {name:"part-b.png",mimeType:"image/png",buffer:texture},
    {name:"spacer.png",mimeType:"image/png",buffer:texture},
    {name:"hotspot.png",mimeType:"image/png",buffer:texture}
  ]);
  await page.waitForTimeout(1200);
  console.log("PUBLIC_SITE_IMPORT",{
    selectionTree:await page.locator("#selection-tree").count(),
    rows:await page.locator("#selection-tree .tree-row").count(),
    status:await page.locator("#status").textContent(),
    makeButton:await page.locator("#do-all").textContent()
  });
  await page.waitForSelector("#selection-tree .tree-row",{timeout:20000});
  const leftBone=page.locator('#selection-tree input[data-tree-type="bone"][data-tree-id="left"]');
  const rightSlot=page.locator('#selection-tree input[data-tree-type="slot"][data-tree-id="image_b"]');
  await leftBone.check();await rightSlot.check();
  const a=page.locator("#selection-tree label.tree-row").filter({hasText:"partA"}).locator("input");
  const b=page.locator("#selection-tree label.tree-row").filter({hasText:"partB"}).locator("input");
  assert.equal(await a.isChecked(),true,"Selecting a bone must select its attached image");
  assert.equal(await b.isChecked(),true,"Selecting a slot must select its attached image");
  const spacer=page.locator("#selection-tree label.tree-row").filter({hasText:"partSpacer"}).locator("input");
  assert.equal(await spacer.isChecked(),false,"An unselected image between selected slots stays unselected");
  assert.match(await page.locator("#do-all").textContent(),/Сделать маску · 2/);
  assert.match(await page.locator("#do-all").getAttribute("title"),/промежуточные слоты/);
  const wait=page.waitForEvent("download",{timeout:60000});
  await page.locator("#do-all").click();
  const download=await wait;
  assert.match(download.suggestedFilename(),/-complete-spine-mask\.zip$/);
  const zipPath=path.join(process.env.RUNNER_TEMP,"manual-multi-mask-ui.zip");
  await download.saveAs(zipPath);
  const py=[
    "import sys,zipfile,json",
    "z=zipfile.ZipFile(sys.argv[1]); n=z.namelist()",
    "assert all(x in n for x in ['images/part-a.png','images/part-b.png','images/spacer.png','images/hotspot.png'])",
    "p=next(x for x in n if x.endswith('-mask.json')); j=json.loads(z.read(p))",
    "clips=[a for s in j['skins'] for slot in s['attachments'].values() for a in slot.values() if a.get('type')=='clipping']",
    "assert len(clips)==1 and clips[0]['end']=='image_b'",
    "assert j['slots'][0]['name']=='auto_mask_multi' and j['slots'][0]['bone']=='root'",
    "v=clips[0]['vertices']; count=clips[0]['vertexCount']",
    "assert len(v)==count*5, 'multi-bone clipping must use weighted vertex tuples'",
    "assert all(v[i*5]==1 and v[i*5+4]==1 for i in range(count))",
    "assert {v[i*5+1] for i in range(count)}=={1,2}, 'both animated source bones must own clipping vertices'",
    "assert j['animations']['idle']['bones']['left']['rotate'][-1]['angle']==25",
    "assert j['animations']['idle']['bones']['right']['rotate'][-1]['angle']==-25",
    "assert 3<=clips[0]['vertexCount']<=2500",
    "assert [s['name'] for s in j['slots']][:4]==['auto_mask_multi','image_a','spacer','image_b']",
    "assert j['skins'][0]['attachments']['spacer']['partSpacer']['path']=='spacer'",
    "assert j['skins'][0]['attachments']['hotspot']['hotspot']['path']=='hotspot'",
    "assert max(abs(v[i*5+3]) for i in range(count)) < 50, 'mask geometry must be built only around selected images, not the unselected spacer at y=120'",
    "print('PUBLIC_SITE_MANUAL_NON_ADJACENT_MULTI_OBJECT_ONE_CLIP_PASS',clips[0]['vertexCount'])"
  ].join("; ");
  execFileSync("python3",["-c",py,zipPath],{stdio:"inherit"});
  assert.deepEqual(errors,[]);
  console.log("SPINE_MASK_PUBLIC_LIVE_MULTI_OBJECT_E2E_PASS",fs.statSync(zipPath).size);
}catch(error){
  console.error("SPINE_MASK_PUBLIC_LIVE_MULTI_OBJECT_E2E_FAILED",String(error?.message||error),errors);
  throw error;
}finally{await browser.close();}
