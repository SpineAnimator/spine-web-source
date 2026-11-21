(() => {
'use strict';
const $=id=>document.getElementById(id), messages=$('chat-messages'), prompt=$('prompt'), send=$('generate'), panel=$('attachment-panel');
let assistant=null;
function bubble(role,text){const n=document.createElement('article');n.className='message '+role;const m=document.createElement('div');m.className='message-meta';m.textContent=role==='user'?'You':'SpineAnimator Agent';const b=document.createElement('div');b.textContent=text;n.append(m,b);messages.append(n);n.scrollIntoView({block:'nearest',behavior:'smooth'});return{node:n,body:b};}
function submit(){const file=$('source-file').files[0],url=$('source-url').value.trim();let text=prompt.value.trim();if(!text&&!file&&!url){panel.hidden=false;$('attach-button').setAttribute('aria-expanded','true');return;}if(!text)text='Analyze this source artwork and prepare a Spine animation workflow.';$('welcome').hidden=true;bubble('user',text+(file?'\n\n📎 '+file.name:'')+(url?'\n\n↗ '+url:''));assistant=bubble('agent','Request received. Preparing source artwork and the available animation workflow…');assistant.body.className='message-status';$('source-inspector').hidden=false;$('result-workspace').hidden=false;panel.hidden=true;$('attach-button').setAttribute('aria-expanded','false');prompt.value='';prompt.style.height='auto';}
$('attach-button').addEventListener('click',()=>{panel.hidden=!panel.hidden;$('attach-button').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)$('source-url').focus();});
$('close-attachments').addEventListener('click',()=>{panel.hidden=true;$('attach-button').setAttribute('aria-expanded','false');});
$('new-chat').addEventListener('click',()=>{messages.replaceChildren();$('welcome').hidden=false;$('source-inspector').hidden=true;$('result-workspace').hidden=true;$('status').textContent='';$('source-file').value='';$('source-url').value='';prompt.value='';assistant=null;});
$('tools-toggle').addEventListener('click',()=>{const menu=$('tools-menu');menu.hidden=!menu.hidden;$('tools-toggle').setAttribute('aria-expanded',String(!menu.hidden));});
$('mobile-menu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
document.querySelectorAll('.suggestion').forEach(b=>b.addEventListener('click',()=>{prompt.value=b.dataset.prompt||'';prompt.focus();}));
prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send.click();}});
prompt.addEventListener('input',()=>{prompt.style.height='auto';prompt.style.height=Math.min(prompt.scrollHeight,170)+'px';});
send.addEventListener('click',submit);
$('source-file').addEventListener('change',()=>{const f=$('source-file').files[0];if(f){$('file-name').textContent=f.name+' · '+(f.size/1048576).toFixed(1)+' MB';$('source-inspector').hidden=false;}});
$('source-url').addEventListener('change',()=>{if($('source-url').value.trim())$('source-inspector').hidden=false;});
const status=$('status'),observer=new MutationObserver(()=>{const value=status.textContent.trim();if(!value)return;if(!assistant){assistant=bubble('agent',value);assistant.body.className='message-status';}else assistant.body.textContent=value;if(/^Generation failed:/i.test(value))assistant.node.dataset.state='error';if(/^ZIP ready/i.test(value)){$('artifact-card').hidden=false;$('result-workspace').hidden=false;assistant.body.className='';}});
observer.observe(status,{childList:true,subtree:true,characterData:true});
})();