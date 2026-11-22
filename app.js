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
        let reason = '', remoteCode = '';
        if (/json/i.test(response.headers.get('content-type') || '')) {
          try {
            const detail = await response.json();
            reason = detail?.error?.message || (typeof detail?.error === 'string' ? detail.error : '') || detail?.message || '';
            remoteCode = detail?.error?.code || detail?.code || detail?.errorCode || '';
          } catch (_) {}
        }
        const error = new Error(stage + ': HTTP ' + response.status +
          (reason ? ' — ' + String(reason).slice(0, 240) : ''));
        error.status = response.status;
        error.remoteCode = String(remoteCode || '');
        error.cfRay = response.headers.get('cf-ray') || '';
        throw error;
      }
      const expected = Number(response.headers.get('content-length'));
      if (expected > limit) throw Error(stage + ': response is too large');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > limit) throw Error(stage + ': response is too large');
      return { response, bytes };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = Error(stage + ': ' + Math.round(timeoutMs / 1000) + '-second network timeout');
        timeout.code = 'NETWORK_TIMEOUT';
        timeout.cause = error;
        throw timeout;
      }
      if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed|fetch failed/i.test(String(error?.message || ''))) {
        const network = Error(stage + ': network/CORS/DNS/TLS connection failed (' + String(error?.message || 'fetch failed').slice(0, 160) + ')');
        network.code = 'NETWORK_ERROR';
        network.cause = error;
        throw network;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const TRANSIENT_PLANNER_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
  function isTransientPlannerError(error) {
    if (error?.remoteCode === 'ANALYSIS_SCHEMA' || /ANALYSIS_SCHEMA|Invalid visual subject/i.test(String(error?.message || ''))) return false;
    return error?.code === 'NETWORK_ERROR' || error?.code === 'NETWORK_TIMEOUT' ||
      TRANSIENT_PLANNER_HTTP.has(error?.status);
  }
  async function fetchPlannerWithRetry(body) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetchLimited(STUDIO + '/api/plan', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body
        }, 20 * 1024 * 1024, 'AI planner', 45000);
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || !isTransientPlannerError(error)) throw error;
        const delay = attempt === 1 ? 800 : 1600;
        message('AI planner connection interrupted; retry ' + (attempt + 1) + '/3: ' + String(error.message || error).slice(0, 140));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError || Error('AI planner did not respond');
  }
  async function inspectSpineZip(bytes, plannedClips, source) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 22)
      throw Error('ZIP archive is truncated.');
    const view = new DataView(bytes);
    const minEocd = Math.max(0, bytes.byteLength - 22 - 65535);
    let eocd = -1;
    for (let p = bytes.byteLength - 22; p >= minEocd; p--) {
      if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw Error('ZIP end-of-central-directory record is missing.');
    const disk = view.getUint16(eocd + 4, true);
    const centralDisk = view.getUint16(eocd + 6, true);
    const diskEntries = view.getUint16(eocd + 8, true);
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    const commentLength = view.getUint16(eocd + 20, true);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || !entries || entries > 1024 ||
        entries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff ||
        centralOffset + centralSize !== eocd || eocd + 22 + commentLength !== bytes.byteLength)
      throw Error('ZIP directory metadata is inconsistent or unsupported.');
    const decoder = new TextDecoder();
    const files = new Map();
    const localOffsets = new Set();
    const ranges = [];
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    function crc32(data) {
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ crcTable[(c ^ data[i]) & 255];
      return (c ^ 0xffffffff) >>> 0;
    }
    async function unpack(method, packed) {
      if (method === 0) return packed;
      if (method === 8 && typeof DecompressionStream === 'function') {
        const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw Error('Unsupported ZIP compression method: ' + method);
    }
    let cursor = centralOffset;
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50)
        throw Error('ZIP central directory entry is corrupt.');
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const expectedCrc = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const entryCommentLength = view.getUint16(cursor + 32, true);
      const startDisk = view.getUint16(cursor + 34, true);
      const localOffset = view.getUint32(cursor + 42, true);
      if ((flags & 1) || startDisk !== 0 || compressedSize === 0xffffffff ||
          uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
          cursor + 46 + nameLength + extraLength + entryCommentLength > eocd)
        throw Error('Encrypted, multi-disk or ZIP64 entries are not supported.');
      const name = decoder.decode(new Uint8Array(bytes, cursor + 46, nameLength));
      if (!name || name.startsWith('/') || name.includes('\\') ||
          name.split('/').some(part => part === '..' || part === '') ||
          files.has(name) || localOffsets.has(localOffset))
        throw Error('ZIP contains an unsafe or duplicate path.');
      if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50)
        throw Error('ZIP local file header is corrupt: ' + name);
      const localFlags = view.getUint16(localOffset + 6, true);
      const localMethod = view.getUint16(localOffset + 8, true);
      const localCrc = view.getUint32(localOffset + 14, true);
      const localCompressed = view.getUint32(localOffset + 18, true);
      const localUncompressed = view.getUint32(localOffset + 22, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localName = decoder.decode(new Uint8Array(bytes, localOffset + 30, localNameLength));
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (localName !== name || localFlags !== flags || localMethod !== method ||
          dataEnd > centralOffset || dataEnd > bytes.byteLength ||
          (!(flags & 8) && (localCrc !== expectedCrc ||
            localCompressed !== compressedSize || localUncompressed !== uncompressedSize)))
        throw Error('ZIP local and central records disagree: ' + name);
      const packed = new Uint8Array(bytes, dataStart, compressedSize);
      const raw = await unpack(method, packed);
      if (raw.byteLength !== uncompressedSize || crc32(raw) !== expectedCrc)
        throw Error('ZIP entry size or CRC32 check failed: ' + name);
      files.set(name, raw);
      localOffsets.add(localOffset);
      ranges.push([localOffset, dataEnd, name]);
      cursor += 46 + nameLength + extraLength + entryCommentLength;
    }
    if (cursor !== centralOffset + centralSize)
      throw Error('ZIP central directory size does not match its entries.');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i][0] < ranges[i - 1][1])
        throw Error('ZIP local entries overlap: ' + ranges[i][2]);
    for (const name of ['skeleton.json', 'skeleton.atlas', 'manifest.json'])
      if (!files.has(name)) throw Error('ZIP is missing required file: ' + name);
    if (!source || !Array.isArray(source.layers) || !Array.isArray(plannedClips) || !plannedClips.length)
      throw Error('Source layer inventory or planned clip list is missing.');
    const skeleton = JSON.parse(decoder.decode(files.get('skeleton.json')));
    const manifest = JSON.parse(decoder.decode(files.get('manifest.json')));
    if (!skeleton.skeleton || !/^4\.3(?:\.|$)/.test(String(skeleton.skeleton.spine || '')) ||
        !Array.isArray(skeleton.bones) || !skeleton.bones.length ||
        !Array.isArray(skeleton.slots) || !skeleton.slots.length ||
        !skeleton.animations || typeof skeleton.animations !== 'object')
      throw Error('ZIP does not contain a valid Spine 4.3 skeleton.');
    if (manifest.backend !== '2spine-cloud-executor' || manifest.spine !== '4.3.26' ||
        manifest.layerCount !== source.layers.length || manifest.clipCount !== plannedClips.length ||
        manifest.validation?.setupPreserved !== true ||
        manifest.validation?.drawOrderPreserved !== true ||
        manifest.validation?.frameZeroPreserved !== true ||
        manifest.renderEvidence?.status !== 'not-rendered' || manifest.renderEvidence?.frameCount !== 0 ||
        manifest.artisticApproval !== 'pending' || manifest.releaseReady !== false ||
        manifest.nativeSpineEditorFile !== false)
      throw Error('ZIP manifest does not certify the expected source-preserving pending export.');
    const expectedAnimations = plannedClips.map(clip => clip.id).sort();
    const animationEntries = Object.entries(skeleton.animations);
    const actualAnimations = animationEntries.map(entry => entry[0]).sort();
    if (expectedAnimations.length !== actualAnimations.length ||
        expectedAnimations.some((name, index) => name !== actualAnimations[index]))
      throw Error('ZIP animation names do not match the AI-authored clips.');
    const atlasText = decoder.decode(files.get('skeleton.atlas'));
    const textureNames = Array.from(files.keys()).filter(name => /^images\/.+\.png$/i.test(name)).sort();
    const expectedTextures = source.layers.map(layer => 'images/' + layer.id + '.png').sort();
    if (textureNames.length !== expectedTextures.length ||
        expectedTextures.some((name, index) => name !== textureNames[index]))
      throw Error('ZIP texture inventory does not match the original PSD layers.');
    for (const layer of source.layers) {
      const name = 'images/' + layer.id + '.png';
      const png = files.get(name);
      if (!png || png.length < 24 ||
          [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => png[index] !== value))
        throw Error('ZIP contains an invalid source texture: ' + layer.id);
      const pngView = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const pngWidth = pngView.getUint32(16, false);
      const pngHeight = pngView.getUint32(20, false);
      if (String.fromCharCode(...png.slice(12, 16)) !== 'IHDR' ||
          pngWidth !== layer.bounds.width || pngHeight !== layer.bounds.height)
        throw Error('ZIP texture dimensions changed for source layer: ' + layer.id);
      if (!atlasText.includes(name) || !atlasText.includes('\n' + layer.id + '\n'))
        throw Error('Spine atlas is missing source layer region: ' + layer.id);
    }
    function scan(value, path, depth, found) {
      if (!value || typeof value !== 'object' || depth > 16) return;
      if (Array.isArray(value)) {
        if (/\.bones\.[^.]+\.(translate|rotate|scale|shear)$/.test(path)) {
          const frames = value.map((frame, index) => frame && typeof frame === 'object' &&
            !Array.isArray(frame) && (Number.isFinite(frame.time) || index === 0)
            ? { ...frame, time: Number.isFinite(frame.time) ? frame.time : 0 } : null).filter(Boolean);
          const poses = new Set(frames.map(frame => JSON.stringify(Object.fromEntries(
            Object.entries(frame).filter(([key]) => !['time', 'curve', 'c2', 'c3'].includes(key))
          ))));
          if (frames.length >= 2 && new Set(frames.map(frame => frame.time)).size >= 2 && poses.size >= 2)
            found.push({ path, keys: frames.length, distinctTimes: new Set(frames.map(frame => frame.time)).size });
        }
        for (let i = 0; i < value.length; i++) scan(value[i], path + '[' + i + ']', depth + 1, found);
        return;
      }
      for (const [key, child] of Object.entries(value))
        scan(child, path ? path + '.' + key : key, depth + 1, found);
    }
    const moving = [];
    for (const [name, animation] of animationEntries) {
      const before = moving.length;
      scan(animation, name, 0, moving);
      if (moving.length === before)
        throw Error('Static Spine animation rejected: "' + name + '" has no changing transform keys.');
    }
    return { animationNames: actualAnimations, movingTimelines: moving,
      zipEntries: files.size, textureFiles: textureNames, manifest };
  }

  function aiSchemaError(message) {
    const error = Error(message);
    error.code = 'AI_SCHEMA_INVALID';
    throw error;
  }
  function validateVisualAnalysis(analysis, source) {
    if (!analysis || typeof analysis !== 'object' || !analysis.subject ||
        typeof analysis.subject.kind !== 'string' || !analysis.subject.kind.trim() ||
        !Number.isFinite(analysis.subject.confidence) || analysis.subject.confidence < 0 ||
        analysis.subject.confidence > 1 || !Array.isArray(analysis.parts) || analysis.parts.length > 10000)
      aiSchemaError('AI visual analysis schema is invalid: subject.kind, subject.confidence and parts[] are required');
    const partIds = new Set();
    for (const part of analysis.parts) {
      if (!part || typeof part.id !== 'string' || !part.id.trim() || partIds.has(part.id) ||
          typeof part.kind !== 'string' || !part.kind.trim() ||
          !Number.isFinite(part.confidence) || part.confidence < 0 || part.confidence > 1 ||
          !Array.isArray(part.layerIds) || !Array.isArray(part.chains) ||
          part.chains.length > 10000)
        aiSchemaError('AI visual analysis contains an invalid part record');
      partIds.add(part.id);
      if (part.layerIds.some(id => !source.layers.some(layer => layer.id === id)))
        aiSchemaError('AI visual analysis references an unknown PSD layer');
      for (const chain of part.chains) {
        if (!chain || !Array.isArray(chain.points) || chain.points.length < 2 || chain.points.length > 10000 ||
            chain.points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
              point.x < 0 || point.y < 0 || point.x > source.width || point.y > source.height))
          aiSchemaError('AI visual analysis contains an invalid or out-of-bounds chain');
      }
    }
  }
  function validateAIPlan(plan, source) {
    if (!plan || typeof plan !== 'object' || !plan.scene ||
        !Array.isArray(plan.scene.nodes) || !plan.scene.nodes.length ||
        !Array.isArray(plan.scene.clips) || !plan.scene.clips.length)
      aiSchemaError('AI returned no complete scene with non-empty animation clips');
    const scene = plan.scene;
    const nodes = new Map(scene.nodes.map(node => [node?.id, node]));
    if (nodes.size !== scene.nodes.length || scene.nodes.some(node => !node ||
        typeof node.id !== 'string' || !node.id.trim()))
      aiSchemaError('AI scene contains missing or duplicate node IDs');
    const order = Array.isArray(scene.drawOrder) ? scene.drawOrder : scene.nodes.map(node => node.id);
    if (order.length !== scene.nodes.length || new Set(order).size !== scene.nodes.length ||
        order.some(id => !nodes.has(id)))
      aiSchemaError('AI scene draw order is incomplete or contains unknown nodes');
    const assets = order.map(id => nodes.get(id)).filter(node => node.asset).map(node => node.asset);
    if (assets.length !== source.layers.length ||
        assets.some((id, index) => id !== source.layers[index].id))
      aiSchemaError('AI scene changed the exact source layer inventory or draw order');
    const validation = plan.validation;
    if (!validation || validation.initialPosePreserved !== true ||
        validation.drawOrderPreserved !== true || validation.sourceLayers !== source.layers.length)
      aiSchemaError('AI scene did not certify the original frame-zero pose, draw order and source layer count');
    const clipIds = new Set();
    for (const clip of scene.clips) {
      if (!clip || typeof clip.id !== 'string' || !clip.id.trim() || clipIds.has(clip.id) ||
          clip.id === 'technical_bounce_unapproved' ||
          !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 86400 ||
          !Array.isArray(clip.tracks) || !clip.tracks.length)
        aiSchemaError('AI clip is missing a unique ID, valid duration or authored node tracks');
      clipIds.add(clip.id);
      let moving = false;
      for (const track of clip.tracks) {
        if (!track || !nodes.has(track.target) ||
            !['x', 'y', 'z', 'rotation', 'scaleX', 'scaleY', 'opacity', 'depth'].includes(track.property) ||
            !Array.isArray(track.keys) || track.keys.length < 2 || track.keys.length > 10000)
          aiSchemaError('AI clip contains an invalid track or fewer than two keyframes');
        let previous = -1;
        const values = new Set();
        for (const key of track.keys) {
          if (!key || !Number.isFinite(key.time) || key.time < 0 || key.time > clip.duration ||
              key.time <= previous || !Number.isFinite(key.value) ||
              (key.interpolation !== undefined && !['linear', 'stepped'].includes(key.interpolation)) ||
              key.curve !== undefined)
            aiSchemaError('AI clip contains invalid, unordered or unsupported keyframe data');
          previous = key.time;
          values.add(key.value);
        }
        if (values.size > 1) moving = true;
      }
      if (!moving) aiSchemaError('AI clip "' + clip.id + '" is static and has no changing numeric node pose');
    }
    if (plan.analysis !== undefined && plan.analysis !== null) validateVisualAnalysis(plan.analysis, source);
    return true;
  }
  async function requestAIPlan(body, source) {
    let current = body;
    for (let repair = 0; repair < 2; repair++) {
      try {
        const result = await fetchPlannerWithRetry(current);
        let plan;
        try { plan = JSON.parse(new TextDecoder().decode(result.bytes)); }
        catch (_) { aiSchemaError('AI planner returned malformed JSON'); }
        validateAIPlan(plan, source);
        return plan;
      } catch (error) {
        const schemaFailure = error?.code === 'AI_SCHEMA_INVALID' ||
          error?.remoteCode === 'ANALYSIS_SCHEMA' ||
          /ANALYSIS_SCHEMA|Invalid visual subject|visual analysis schema/i.test(String(error?.message || ''));
        if (!schemaFailure || repair >= 1) throw error;
        const corrected = JSON.parse(current);
        corrected.instructions = String(corrected.instructions || '') +
          ' REPAIR THE PREVIOUS AI RESPONSE. Return a complete valid scene and visual analysis. ' +
          'analysis.subject must be an object {kind: non-empty string, confidence: finite 0..1}; ' +
          'use kind unclassified and confidence 0 when uncertain, never a string subject. ' +
          'analysis.parts must be an array; every part has id, kind, confidence, layerIds and chains arrays. ' +
          'Every clip must contain moving numeric node tracks with at least two distinct keyframes. ' +
          'Preserve exact source layers, frame zero and draw order. Do not emit a technical fallback.';
        corrected.description = String(corrected.description || '') +
          '\n\nCorrective validation request: ' + String(error.message || error).slice(0, 500) +
          '. Return a corrected AI-authored scene; do not relax source-preservation or animation checks.';
        current = JSON.stringify(corrected);
        if (current.length > 19 * 1024 * 1024)
          throw Error('AI repair request exceeds the 19 MB planning limit');
        message('AI response did not match the strict scene schema; requesting one corrected AI plan…');
      }
    }
    throw Error('AI planner could not produce a valid scene after one schema repair');
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
        const bytes = (await fetchLimited(endpoint, { method: 'GET' }, LIMIT, name, 45000)).bytes;
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
          const bytes = (await fetchLimited(endpoint, { method: 'GET' }, LIMIT, 'Cherry backup', 45000)).bytes;
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
        instructions: 'Preserve original draw order and all source layer pixels. Keep frame-zero setup pose. This MUST be a genuinely animated Spine scene, never static keys: author real translate/rotate/scale/shear or mesh-deform timelines with at least two different numeric poses at distinct timestamps in every requested motion clip. Include anticipation, action, follow-through, settle and return where appropriate. Do not emit duplicate keys or empty animations. Verify evaluated poses differ over time while frame zero matches the source. Do not fake 360-degree depth. If returning visual analysis, analysis.subject MUST be an object with a non-empty kind string and finite confidence from 0 to 1; use kind unclassified and confidence 0 when semantics are uncertain. analysis.parts MUST be an array; every part needs id, kind, confidence, layerIds and chains arrays. Every chain must have at least two finite in-bounds points. Never return subject as a plain string.' });
      if (request.length > 19 * 1024 * 1024) throw Error('PSD exceeds cloud planning limit');
      stage = 'AI planning';
      message('Cloud animation in progress…');
      let plan;
      try {
        plan = await requestAIPlan(request, source);
      } catch (error) {
        // Network failures, invalid AI schemas and source-preservation failures
        // all fail closed. A schema mismatch gets one explicit AI repair request;
        // no technical or template ZIP is ever created.
        throw Error('AI planning failed closed: ' + (error?.message || String(error)) +
          '. No technical fallback ZIP was created.');
      }
      const exportBody = JSON.stringify({ canvas: { width: source.width, height: source.height },
        scene: plan.scene, layers: source.layers });
      if (exportBody.length > 19 * 1024 * 1024) throw Error('Export payload is too large');
      stage = 'Spine ZIP export';
      message('Exporting Spine ZIP…');
      const result = await fetchLimited(EXPORTER + '/api/build', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: exportBody
      }, 200 * 1024 * 1024, 'Spine ZIP exporter', 45000);
      const sig = new Uint8Array(result.bytes, 0, 4);
      if (sig.length < 4 || sig[0] !== 80 || sig[1] !== 75 || sig[2] !== 3 || sig[3] !== 4)
        throw Error('Server did not return a valid ZIP header');
      const animationAudit = await inspectSpineZip(result.bytes, plan.scene.clips, source);
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
