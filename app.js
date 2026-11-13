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
  function sourceURL(text) {
    const u = new URL(text);
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
    const file = $('file').files[0];
    if (file) {
      if (file.size > LIMIT) throw Error('PSD is larger than 180 MB');
      if (file.size < 26) throw Error('Selected PSD is empty or truncated');
      return file.arrayBuffer();
    }
    const u = sourceURL($('url').value.trim());
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
  async function create() {
    clearDownload();
    $('create').disabled = true;
    try {
      const motion = $('prompt').value.trim();
      if (!motion || motion.length > 20000) throw Error('Enter a motion description (up to 20,000 characters)');
      message('Loading PSD…');
      const rawPSD = await getBytes();
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
        instructions: 'Preserve original draw order and all source layer pixels. Keep frame-zero setup pose. Return complete animated Spine scene. Do not fake 360-degree depth.' });
      if (request.length > 19 * 1024 * 1024) throw Error('PSD exceeds cloud planning limit');
      message('Cloud animation in progress…');
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
      const plan = JSON.parse(new TextDecoder().decode(planResponse.bytes));
      if (!plan.scene || !Array.isArray(plan.scene.clips) || !plan.scene.clips.length)
        throw Error('Cloud did not return complete animation clips. No incomplete ZIP created.');
      if (plan.validation?.initialPosePreserved !== true || plan.validation?.drawOrderPreserved !== true)
        throw Error('Cloud failed source-preservation validation');
      const exportBody = JSON.stringify({ canvas: { width: source.width, height: source.height },
        scene: plan.scene, layers: source.layers });
      if (exportBody.length > 19 * 1024 * 1024) throw Error('Export payload is too large');
      message('Exporting Spine ZIP…');
      const result = await fetchLimited(EXPORTER + '/api/build', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: exportBody
      }, 200 * 1024 * 1024, 'Spine ZIP exporter');
      const sig = new Uint8Array(result.bytes, 0, 4);
      if (sig.length < 4 || sig[0] !== 80 || sig[1] !== 75 || sig[2] !== 3 || sig[3] !== 4)
        throw Error('Server did not return a valid ZIP header');
      downloadURL = URL.createObjectURL(new Blob([result.bytes], { type: 'application/zip' }));
      $('download').href = downloadURL;
      $('download').hidden = false;
      message('ZIP ready. Check animations in Spine Editor 4.3 before production.');
    } catch (error) {
      message('Generation failed: ' + (error?.name === 'AbortError' ? '15-second network timeout' : error.message));
    } finally {
      $('create').disabled = false;
    }
  }
  $('create').addEventListener('click', create);
  $('prompt').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); create(); } });
  $('file').addEventListener('change', () => { $('url').value = ''; clearDownload(); });
  $('url').addEventListener('change', () => { $('file').value = ''; clearDownload(); });
  $('prompt').addEventListener('input', clearDownload);
})();
