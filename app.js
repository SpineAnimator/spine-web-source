/* Public, frontend-only interface. Private 2Spine animation and Linux Spine code is NOT included. */
(() => {
  'use strict';
  const $ = id => document.getElementById(({ create: 'generate', file: 'source-file', url: 'source-url', preview: 'source-preview' })[id] || id);
  const STUDIO = 'https://spine-studio.spine-animator-f8692224.workers.dev';
  const EXPORTER = 'https://spine-generator.spine-animator-f8692224.workers.dev';
  let downloadURL = null;
  const LIMIT = 180 * 1024 * 1024;
  function message(text) { $('status').textContent = text; }
  function clearDownload() {
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = null;
    $('download').hidden = true;
  }
  async function fetchLimited(url, init, limit = LIMIT, stage = 'Remote request', timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, credentials: 'omit', mode: 'cors',
        redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        let reason = '';
        if (/json/i.test(response.headers.get('content-type') || '')) {
          try {
            const detail = await response.json();
            reason = detail?.error?.message || (typeof detail?.error === 'string' ? detail.error : '') || detail?.message || '';
          } catch (_) {}
        }
        const error = new Error(stage + ': HTTP ' + response.status +
          (reason ? ' — ' + String(reason).slice(0, 240) : ''));
        error.status = response.status;
        throw error;
      }
      const expected = Number(response.headers.get('content-length'));
      if (expected > limit) throw Error(stage + ': response is too large');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > limit) throw Error(stage + ': response is too large');
      return { response, bytes };
    } catch (error) {
      if (error?.name === 'AbortError') throw Error(stage + ': ' + Math.round(timeoutMs / 1000) + '-second network timeout');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function inspectSpineZip(bytes, plannedClips) {
    // Inspect the actual exported skeleton.json, not merely the ZIP magic bytes.
    const view = new DataView(bytes);
    const minEocd = Math.max(0, bytes.byteLength - 22 - 65535);
    let eocd = -1;
    for (let p = bytes.byteLength - 22; p >= minEocd; p--) {
      if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw Error('ZIP directory is missing; no Spine animation delivered.');
    const entries = view.getUint16(eocd + 10, true);
    let cursor = view.getUint32(eocd + 16, true);
    let skeleton = null;
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50)
        throw Error('ZIP directory is corrupt; no Spine animation delivered.');
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(bytes, cursor + 46, nameLength));
      if (name.toLowerCase() === 'skeleton.json' || (!skeleton && name.toLowerCase().endsWith('.json'))) {
        if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50)
          throw Error('Spine JSON local ZIP entry is corrupt.');
        const localName = view.getUint16(localOffset + 26, true);
        const localExtra = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localName + localExtra;
        if (start + compressedSize > bytes.byteLength) throw Error('Spine JSON ZIP entry is truncated.');
        const packed = bytes.slice(start, start + compressedSize);
        let raw;
        if (method === 0) raw = packed;
        else if (method === 8 && typeof DecompressionStream === 'function') {
          const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          raw = await new Response(stream).arrayBuffer();
        } else throw Error('Unsupported Spine JSON ZIP compression method: ' + method);
        if (raw.byteLength !== uncompressedSize) throw Error('Spine JSON decompressed size mismatch.');
        skeleton = JSON.parse(new TextDecoder().decode(raw));
        break;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (!skeleton || !skeleton.animations || typeof skeleton.animations !== 'object')
      throw Error('Export ZIP has no valid Spine skeleton.json animations object.');
    const animations = Object.entries(skeleton.animations);
    if (!animations.length) throw Error('Exported Spine project contains no animations.');
    const moving = [];
    function scan(value, path, depth) {
      if (!value || typeof value !== 'object' || depth > 16) return;
      if (Array.isArray(value)) {
        // Spine JSON commonly omits time on the first key (implicit t=0).
        const frames = value.map((frame, index) => frame && typeof frame === 'object' &&
          !Array.isArray(frame) && (Number.isFinite(frame.time) || index === 0)
          ? { ...frame, time: Number.isFinite(frame.time) ? frame.time : 0 } : null).filter(Boolean);
        if (frames.length >= 2) {
          const times = new Set(frames.map(frame => frame.time));
          const poses = new Set(frames.map(frame => JSON.stringify(
            Object.fromEntries(Object.entries(frame).filter(([key]) =>
              !['time', 'curve', 'c2', 'c3'].includes(key)))
          )));
          if (times.size >= 2 && poses.size >= 2)
            moving.push({ path, keys: frames.length, distinctTimes: times.size, distinctValues: poses.size });
        }
        for (let i = 0; i < value.length; i++) scan(value[i], path + '[' + i + ']', depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value))
        scan(child, path ? path + '.' + key : key, depth + 1);
    }
    if (!Array.isArray(plannedClips) || !plannedClips.length)
      throw Error('Animation plan contains no declared clips.');
    for (const [name, animation] of animations) {
      const before = moving.length;
      scan(animation, name, 0);
      if (moving.length === before)
        throw Error('Static Spine animation rejected: "' + name + '" has no changing keyed values at distinct times.');
    }
    if (!moving.length)
      throw Error('Static Spine export rejected: no transform/deform timeline has different values at distinct times.');
    return { animationNames: animations.map(([name]) => name), movingTimelines: moving };
  }

  function sourceURL(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) throw Error('No PSD file selected. Attach a .psd file or paste a public HTTPS link.');
    let u;
    try { u = new URL(value); }
    catch (_) { throw Error('The PSD link is not a valid absolute URL. Paste a complete HTTPS link or attach the PSD file.'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
      throw Error('Provide a public HTTPS PSD or supported file-share link');
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      throw Error('Private network URLs are not supported');
    if (['drive.google.com', 'drive.usercontent.google.com'].includes(u.hostname)) {
      const fileLink = u.hostname === 'drive.google.com' &&
        /^\/file\/d\/[A-Za-z0-9_-]{10,128}(?:\/(?:view|preview|edit))?\/?$/.test(u.pathname);
      const directLink = ['/uc', '/open', '/download'].includes(u.pathname) &&
        /^[A-Za-z0-9_-]{10,128}$/.test(u.searchParams.get('id') || '');
      if (!fileLink && !directLink) throw Error('Provide a Google Drive file link, not a folder');
      return u;
    }
    if (u.hostname === 'storage.to') {
      if (!/^\/[A-Za-z0-9]{4,64}$/.test(u.pathname) || u.search)
        throw Error('Provide a public storage.to file-share link');
      return u;
    }
    if (!/\.psd$/i.test(u.pathname)) throw Error('Provide a direct PSD, Google Drive or storage.to link');
    return u;
  }
  const PUBLIC_MIRROR_SHA256 = 'b5f50a5dc500ee2c45d1c817213995ab092a33b754febc903aa5e861b20757d4';
  async function checkMirror(bytes) {
    if (bytes.byteLength !== 40062699) throw Error('Mirror size does not match archived original');
    if (!crypto.subtle?.digest) throw Error('Browser cannot verify mirror SHA-256');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== PUBLIC_MIRROR_SHA256) throw Error('Mirror content is not the verified original');
    return bytes;
  }
  async function getBytes() {
    const file = $('file')?.files?.[0] || null;
    if (file) {
      if (typeof file.arrayBuffer !== 'function') throw Error('The selected PSD file cannot be read by this browser');
      if (!Number.isFinite(file.size) || file.size > LIMIT) throw Error('PSD is larger than 180 MB or has an invalid size');
      if (file.size < 26) throw Error('Selected PSD is empty or truncated');
      const bytes = await file.arrayBuffer();
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size)
        throw Error('The selected PSD could not be read completely');
      return bytes;
    }
    const link = $('url').value.trim();
    if (!link) throw Error('Attach a PSD file or paste a public HTTPS link before creating animation.');
    const u = sourceURL(link);
    const suffix = '/api/psd-source?url=' + encodeURIComponent(u.href);
    const routes = [];
    if (['files.catbox.moe', 'litter.catbox.moe'].includes(u.hostname)) {
      routes.push(['PSD cache', 'https://spine-psd-cache.spine-animator-f8692224.workers.dev' + suffix]);
      routes.push(['PSD generator', EXPORTER + suffix]);
      // A local browser may reach Catbox even when Cloudflare cannot.
      routes.push(['Direct Catbox', u.href]);
      if (u.hostname === 'files.catbox.moe')
        routes.push(['Alternate Catbox', 'https://litter.catbox.moe' + u.pathname]);
    } else if (['drive.google.com', 'drive.usercontent.google.com'].includes(u.hostname)) {
      routes.push(['Google Drive', 'https://spine-drive-source.spine-animator-f8692224.workers.dev' + suffix]);
    } else if (u.hostname === 'storage.to') {
      routes.push(['Public storage.to', STUDIO + '/api/source?url=' + encodeURIComponent(u.href)]);
    } else {
      routes.push(['PSD download', u.href]);
    }
    const failures = [];
    for (const [name, endpoint] of routes) {
      message('Loading PSD via ' + name + '…');
      try {
        const bytes = (await fetchLimited(endpoint, { method: 'GET' }, LIMIT, name)).bytes;
        const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 6));
        if (head.length !== 6 || String.fromCharCode(...head.slice(0, 4)) !== '8BPS' ||
            head[4] !== 0 || head[5] !== 1)
          throw Error(name + ': server returned an empty or invalid PSD');
        return bytes;
      } catch (error) { failures.push(error.message); }
    }
    // These mirrors were previously recorded for Cherry. Never substitute them
    // for nf4g80 unless the ENTIRE 40 MB file matches the archived digest.
    if (u.hostname === 'files.catbox.moe' && u.pathname === '/nf4g80.psd') {
      for (const mirror of ['https://storage.to/CVheHAUuY', 'https://storage.to/GzLxDhgMT']) {
        try {
          message('Checking original Cherry backup…');
          const endpoint = STUDIO + '/api/source?url=' + encodeURIComponent(mirror);
          const bytes = (await fetchLimited(endpoint, { method: 'GET' }, LIMIT, 'Cherry backup')).bytes;
          return await checkMirror(bytes);
        } catch (error) { failures.push(error.message); }
      }
    }
    throw Error('Source unavailable or empty. Choose the original PSD using File, or paste a working public Drive/storage.to link. Routes: ' +
      failures.slice(0, 5).join(' | ').slice(0, 600));
  }
  function canvasOf(img) {
    if (!img) return null;
    if (img instanceof HTMLCanvasElement) return img;
    const width = Number(img.width), height = Number(img.height);
    if (!(width > 0 && height > 0)) return null;
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    if (img.data && img.data.length === width * height * 4)
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), width, height), 0, 0);
    else if (img.canvas instanceof HTMLCanvasElement) c.getContext('2d').drawImage(img.canvas, 0, 0);
    else return null;
    return c;
  }
  function parse(buffer) {
    const signature = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));
    if (signature.length !== 4 || String.fromCharCode(...signature) !== '8BPS')
      throw Error('Invalid PSD header');
    const parser = window.agPsd || window['ag-psd'];
    if (!parser?.readPsd) throw Error('PSD parser failed to load');
    const psd = parser.readPsd(buffer, { useImageData: true, skipThumbnail: true });
    if (!(psd.width > 0 && psd.height > 0) || psd.width * psd.height > 25000000)
      throw Error('Unsupported PSD dimensions');
    const composite = canvasOf(psd.imageData || psd.canvas || psd);
    if (!composite) throw Error('PSD composite is unavailable');
    const layers = [], names = new Set();
    function walk(container, visible = true, opacity = 1) {
      for (const layer of (container.children || []).slice().reverse()) {
        const enabled = visible && layer.hidden !== true;
        if (!enabled) continue;
        if (layer.blendMode && !['normal', 'pass through'].includes(layer.blendMode))
          throw Error('Rasterize unsupported blend mode: ' + layer.blendMode);
        let alpha = layer.opacity === undefined ? 1 : Number(layer.opacity);
        if (alpha > 1) alpha /= 255;
        alpha = Math.max(0, Math.min(1, alpha * opacity));
        if (layer.children && layer.children.length) { walk(layer, enabled, alpha); continue; }
        const original = canvasOf(layer.imageData || layer.canvas || layer);
        if (!original) continue;
        const canvas = document.createElement('canvas');
        canvas.width = original.width; canvas.height = original.height;
        const context = canvas.getContext('2d');
        context.globalAlpha = alpha; context.drawImage(original, 0, 0);
        let id = String(layer.name || 'layer').replace(/[^\w.-]/g, '_').slice(0,70) || 'layer';
        const base = id; let suffix = 1;
        while (names.has(id)) id = base + '_' + suffix++;
        names.add(id);
        layers.push({ id, image: canvas.toDataURL('image/png'),
          bounds: { x: Number(layer.left || 0), y: Number(layer.top || 0),
            width: canvas.width, height: canvas.height } });
      }
    }
    walk(psd);
    if (!layers.length || layers.length > 250) throw Error('PSD needs 1..250 visible raster layers');
    return { width: psd.width, height: psd.height, composite, layers };
  }
  // The AI model may time out on complex PSDs. This explicitly labelled
  // technical motion preserves every original source layer at frame zero.
  // It is not an artistic animation or a substitute for the user's prompt.
  async function create() {
    clearDownload();
    $('create').disabled = true;
    let stage = 'input validation';
    try {
      const motion = $('prompt').value.trim();
      if (!motion || motion.length > 20000) throw Error('Enter a motion description (up to 20,000 characters)');
      stage = 'PSD input';
      message('Loading PSD…');
      const rawPSD = await getBytes();
      stage = 'PSD parsing';
      const source = parse(rawPSD);
      source.loadedBytes = rawPSD.byteLength;
      $('layer-count').textContent = String(source.layers.length);
      $('source-size').textContent = source.width + ' × ' + source.height;
      $('source-mode').textContent = 'PSD';
      $('source-name').textContent = $('file').files[0]?.name || $('url').value.trim().split('/').pop().split('?')[0] || 'PSD';
      $('source-bytes').textContent = (source.loadedBytes || 0).toLocaleString('en-US');
      const preview = $('preview');
      preview.width = source.width; preview.height = source.height;
      preview.getContext('2d').drawImage(source.composite, 0, 0);
      preview.hidden = false;
      const request = JSON.stringify({ image: source.composite.toDataURL('image/png'),
        layers: source.layers, description: motion,
        instructions: 'Preserve original draw order and all source layer pixels. Keep frame-zero setup pose. This MUST be a genuinely animated Spine scene, never static keys: author real translate/rotate/scale/shear or mesh-deform timelines with at least two different numeric poses at distinct timestamps in every requested motion clip. Include anticipation, action, follow-through, settle and return where appropriate. Do not emit duplicate keys or empty animations. Verify evaluated poses differ over time while frame zero matches the source. Do not fake 360-degree depth.' });
      if (request.length > 19 * 1024 * 1024) throw Error('PSD exceeds cloud planning limit');
      stage = 'AI planning';
      message('Cloud animation in progress…');
      let plan;
      try {
        let planResponse;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            planResponse = await fetchLimited(STUDIO + '/api/plan', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: request
            }, 20 * 1024 * 1024, 'AI planner', 45000);
            break;
          } catch (error) {
            if (attempt !== 0 || ![502, 503].includes(error.status)) throw error;
            message('AI planner temporarily unavailable; retrying once…');
          }
        }
        plan = JSON.parse(new TextDecoder().decode(planResponse.bytes));
      } catch (error) {
        // No planner error may cross into export: 4xx/5xx, timeout, network
        // failure and malformed AI responses all fail closed without a ZIP.
        throw Error('AI planning failed closed: ' + (error?.message || String(error)) +
          '. No technical fallback ZIP was created.');
      }
      if (!plan.scene || !Array.isArray(plan.scene.clips) || !plan.scene.clips.length)
        throw Error('Cloud did not return complete animation clips. No incomplete ZIP created.');
      if (plan.scene.clips.some(clip => clip?.id === 'technical_bounce_unapproved'))
        throw Error('Planner returned an unapproved technical fallback scene. No ZIP created.');
      if (plan.validation?.initialPosePreserved !== true || plan.validation?.drawOrderPreserved !== true)
        throw Error('Cloud failed source-preservation validation');
      const exportBody = JSON.stringify({ canvas: { width: source.width, height: source.height },
        scene: plan.scene, layers: source.layers });
      if (exportBody.length > 19 * 1024 * 1024) throw Error('Export payload is too large');
      stage = 'Spine ZIP export';
      message('Exporting Spine ZIP…');
      const result = await fetchLimited(EXPORTER + '/api/build', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: exportBody
      }, 200 * 1024 * 1024, 'Spine ZIP exporter');
      const sig = new Uint8Array(result.bytes, 0, 4);
      if (sig.length < 4 || sig[0] !== 80 || sig[1] !== 75 || sig[2] !== 3 || sig[3] !== 4)
        throw Error('Server did not return a valid ZIP header');
      const animationAudit = await inspectSpineZip(result.bytes, plan.scene.clips);
      console.info('SPINE_ANIMATION_CONTENT_AUDIT', animationAudit);
      downloadURL = URL.createObjectURL(new Blob([result.bytes], { type: 'application/zip' }));
      $('download').href = downloadURL;
      $('download').hidden = false;
      message('ZIP ready. Check animations in Spine Editor 4.3 before production.');
    } catch (error) {
      const detail = error?.name === 'AbortError' ? '15-second network timeout' :
        (error?.message || String(error));
      message('Generation failed [' + stage + ']: ' + detail);
    } finally {
      $('create').disabled = false;
    }
  }
  $('create').addEventListener('click', create);
  $('prompt').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); create(); } });
  $('file').addEventListener('change', () => { $('url').value = ''; clearDownload(); });
  $('url').addEventListener('change', () => { $('file').value = ''; clearDownload(); });
  $('prompt').addEventListener('input', clearDownload);

  // Conversation layer: preserves the existing PSD/Spine execution path.
  const chatHistory = $('chat-history');
  const chatWelcome = $('chat-welcome');
  let chatStatusBubble = null;
  let chatResultBubble = null;
  function chatAppend(text, kind) {
    const value = String(text || '').trim();
    if (!value || !chatHistory) return null;
    // Attaching a source must not collapse the welcome block before the
    // user's next pointer gesture; that layout shift can move Animate mid-click.
    if (kind !== 'attachment') {
      document.body.classList.add('has-chat-content');
      if (chatWelcome) chatWelcome.hidden = true;
    }
    const node = document.createElement('div');
    node.className = kind === 'attachment' ? 'chat-attachment-message' :
      kind === 'assistant' ? 'chat-assistant-message' : 'chat-user-message';
    node.textContent = value;
    chatHistory.appendChild(node);
    // Appending a source attachment must not smooth-scroll the viewport: that moves
    // the composer under an in-flight pointer gesture and can drop the Animate click.
    if (kind !== 'attachment') node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return node;
  }
  const chatPrompt = $('prompt');
  const chatCreate = $('create');
  const chatFile = $('file');
  const chatUrl = $('url');
  const chatStatus = $('status');
  const chatDownload = $('download');
  let lastChatPrompt = '';
  let lastChatSubmittedAt = 0;
  function clearChatResult() {
    if (chatResultBubble) { chatResultBubble.remove(); chatResultBubble = null; }
    if (chatStatusBubble) { chatStatusBubble.remove(); chatStatusBubble = null; }
  }
  function submitChatPrompt() {
    const value = chatPrompt?.value?.trim();
    const now = Date.now();
    if (!value || (value === lastChatPrompt && now - lastChatSubmittedAt < 1200)) return;
    lastChatPrompt = value;
    lastChatSubmittedAt = now;
    clearChatResult();
    chatAppend(value, 'user');
  }
  if (chatCreate) chatCreate.addEventListener('click', submitChatPrompt, true);
  if (chatPrompt) chatPrompt.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitChatPrompt();
  }, true);
  if (chatFile) chatFile.addEventListener('change', () => {
    const file = chatFile.files && chatFile.files[0];
    if (file) { clearChatResult(); chatAppend('Attached PSD: ' + file.name, 'attachment'); }
  });
  if (chatUrl) chatUrl.addEventListener('change', () => {
    const value = chatUrl.value.trim();
    if (value) { clearChatResult(); chatAppend('Source link: ' + value, 'attachment'); }
  });
  if (chatStatus && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      const value = chatStatus.textContent.trim();
      if (!value) return;
      document.body.classList.add('has-chat-content');
      if (!chatStatusBubble) {
        chatStatusBubble = document.createElement('div');
        chatStatusBubble.className = 'chat-assistant-message chat-progress-message';
        chatHistory.appendChild(chatStatusBubble);
      }
      chatStatusBubble.textContent = value;
    });
    observer.observe(chatStatus, { childList: true, characterData: true, subtree: true });
  }
  if (chatDownload && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (chatDownload.hidden || !chatDownload.href || chatResultBubble) return;
      chatResultBubble = document.createElement('div');
      chatResultBubble.className = 'chat-assistant-message chat-result-message';
      const label = document.createElement('strong');
      label.textContent = 'Spine project package ready';
      const link = document.createElement('a');
      link.href = chatDownload.href;
      link.textContent = 'Download Spine project';
      link.className = 'chat-result-link';
      link.setAttribute('download', chatDownload.getAttribute('download') || 'spine-project.zip');
      chatResultBubble.append(label, document.createTextNode(' '), link);
      chatHistory.appendChild(chatResultBubble);
    });
    observer.observe(chatDownload, { attributes: true, attributeFilter: ['href', 'hidden', 'download'] });
  }
})();
