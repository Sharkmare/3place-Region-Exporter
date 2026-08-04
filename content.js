(() => {
  'use strict';

  const WORLD = 1 << 21;
  const CHUNK = 32;
  const SUB_BATCH = 25;
  const SUB_WAIT = 9000;

  let live = null;
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (this.readyState === 1) live = this;
    return origSend.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const lonLatTo3P = (lon, lat) => {
    const tx = (lon + 180) / 360;
    const s = Math.sin((lat * Math.PI) / 180);
    const ty = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [Math.round((tx - 0.5) * WORLD), Math.round(-(ty - 0.5) * WORLD)];
  };

  const centreFromHash = () => {
    const p = location.hash.replace(/^#/, '').split('/');
    const lat = parseFloat(p[1]), lon = parseFloat(p[2]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat, lon, xy: lonLatTo3P(lon, lat) };
  };

  async function readRegion(cx, cy, rad, zmin, zmax, shape, onProgress) {
    if (!live || live.readyState !== 1) throw new Error('no live socket, reload the page');
    const keys = [];
    for (let qx = Math.floor((cx - rad) / CHUNK); qx <= Math.floor((cx + rad) / CHUNK); qx++)
      for (let qy = Math.floor((cy - rad) / CHUNK); qy <= Math.floor((cy + rad) / CHUNK); qy++)
        for (let qz = Math.floor(zmin / CHUNK); qz <= Math.floor(zmax / CHUNK); qz++)
          keys.push(`${qx},${qy},${qz}`);

    const got = new Map();
    for (let i = 0; i < keys.length; i += SUB_BATCH) {
      const batch = keys.slice(i, i + SUB_BATCH);
      const set = new Set(batch);
      const onMsg = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t !== 'chunk' || !set.has(m.key)) return;
        const [qx, qy, qz] = m.key.split(',').map(Number);
        for (const [idx, colour] of (m.voxels || [])) {
          const lz = Math.floor(idx / (CHUNK * CHUNK));
          const rem = idx % (CHUNK * CHUNK);
          const ly = Math.floor(rem / CHUNK), lx = rem % CHUNK;
          got.set(`${qx * CHUNK + lx},${qy * CHUNK + ly},${qz * CHUNK + lz}`, colour);
        }
      };
      live.addEventListener('message', onMsg);
      live.send(JSON.stringify({ t: 'unsub', keys: batch }));
      await sleep(250);
      live.send(JSON.stringify({ t: 'sub', keys: batch }));
      await sleep(SUB_WAIT);
      live.removeEventListener('message', onMsg);
      onProgress(Math.min(i + SUB_BATCH, keys.length), keys.length, got.size);
    }

    const vox = new Map();
    for (const [k, c] of got) {
      const [x, y, z] = k.split(',').map(Number);
      if (z < zmin || z > zmax) continue;
      const dx = x - cx, dy = y - cy;
      const d = shape === 'box' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      if (d > rad) continue;
      vox.set(k, c);
    }
    return vox;
  }

  const FACES = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];

  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  const hexRgb = (h, linear) => {
    h = (h || '#ff00ff').replace('#', '');
    const rgb = [parseInt(h.slice(0, 2), 16) / 255,
                 parseInt(h.slice(2, 4), 16) / 255,
                 parseInt(h.slice(4, 6), 16) / 255];
    return linear ? rgb.map(srgbToLinear) : rgb;
  };

  function buildOBJ(vox, cx, cy, mode, palette, linear) {
    const verts = [], vindex = new Map(), byMat = new Map(), vcol = new Map();
    const vid = (key, p, colour) => {
      if (!vindex.has(key)) {
        verts.push(p);
        vindex.set(key, verts.length);
        if (mode === 'vertex') vcol.set(verts.length, hexRgb(palette[colour], linear));
      }
      return vindex.get(key);
    };

    for (const [k, colour] of vox) {
      const [x, y, z] = k.split(',').map(Number);
      for (const [n, corners] of FACES) {
        if (vox.has(`${x + n[0]},${y + n[1]},${z + n[2]}`)) continue;
        const quad = [];
        for (const o of corners) {
          const px = x + o[0] - cx, py = y + o[1] - cy, pz = z + o[2];
          const key = mode === 'vertex' ? `${px},${py},${pz}|${colour}` : `${px},${py},${pz}`;
          quad.push(vid(key, [px, pz, -py], colour));
        }
        if (!byMat.has(colour)) byMat.set(colour, []);
        byMat.get(colour).push(quad);
      }
    }

    const out = ['# 3place region export'];
    if (mode === 'material') out.push('mtllib region.mtl');
    for (let i = 0; i < verts.length; i++) {
      const [a, b, c] = verts[i];
      if (mode === 'vertex') {
        const [r, g, bl] = vcol.get(i + 1);
        out.push(`v ${a} ${b} ${c} ${r.toFixed(4)} ${g.toFixed(4)} ${bl.toFixed(4)}`);
      } else out.push(`v ${a} ${b} ${c}`);
    }
    let faces = 0;
    for (const colour of [...byMat.keys()].sort((p, q) => p - q)) {
      const pad = String(colour).padStart(2, '0');
      if (mode === 'material') out.push(`usemtl color_${pad}`);
      out.push(`g color_${pad}`);
      for (const q of byMat.get(colour)) { out.push(`f ${q[0]} ${q[1]} ${q[2]} ${q[3]}`); faces++; }
    }

    let mtl = null;
    if (mode === 'material') {
      const m = [];
      for (const colour of [...byMat.keys()].sort((p, q) => p - q)) {
        const [r, g, b] = hexRgb(palette[colour], linear);
        m.push(`newmtl color_${String(colour).padStart(2, '0')}`);
        m.push(`Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`);
        m.push('Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1', '');
      }
      mtl = m.join('\n');
    }
    return { obj: out.join('\n'), mtl, verts: verts.length, faces, mats: byMat.size };
  }

  async function paletteStrip(hexes) {
    const cv = document.createElement('canvas');
    cv.width = hexes.length; cv.height = 1;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(hexes.length, 1);
    for (let i = 0; i < hexes.length; i++) {
      const h = (hexes[i] || '#ff00ff').replace('#', '');
      img.data[i * 4] = parseInt(h.slice(0, 2), 16);
      img.data[i * 4 + 1] = parseInt(h.slice(2, 4), 16);
      img.data[i * 4 + 2] = parseInt(h.slice(4, 6), 16);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function buildGLB(vox, cx, cy, palette, name) {
    const used = [...new Set(vox.values())].sort((a, b) => a - b);
    const slot = new Map(used.map((c, i) => [c, i]));
    const png = await paletteStrip(used.map((c) => palette[c]));

    const pos = [], uv = [], idx = [], vindex = new Map();
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

    const vid = (key, p, colour) => {
      let i = vindex.get(key);
      if (i === undefined) {
        i = pos.length / 3;
        pos.push(p[0], p[1], p[2]);
        uv.push((slot.get(colour) + 0.5) / used.length, 0.5);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
        vindex.set(key, i);
      }
      return i;
    };

    for (const [k, colour] of vox) {
      const [x, y, z] = k.split(',').map(Number);
      for (const [n, corners] of FACES) {
        if (vox.has(`${x + n[0]},${y + n[1]},${z + n[2]}`)) continue;
        const q = corners.map((o) => {
          const px = x + o[0] - cx, py = y + o[1] - cy, pz = z + o[2];
          return vid(`${px},${py},${pz}|${colour}`, [px, pz, -py], colour);
        });
        idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
      }
    }

    const nVerts = pos.length / 3;
    const short = nVerts <= 65535;
    const arrays = [
      new Float32Array(pos),
      new Float32Array(uv),
      short ? new Uint16Array(idx) : new Uint32Array(idx),
    ];

    const views = [], parts = [];
    let off = 0;
    const addView = (src, target) => {
      const bytes = src instanceof Uint8Array
        ? src : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      parts.push([off, bytes]);
      const v = { buffer: 0, byteOffset: off, byteLength: bytes.length };
      if (target) v.target = target;
      views.push(v);
      off = (off + bytes.length + 3) & ~3;
      return views.length - 1;
    };
    const vPos = addView(arrays[0], 34962);
    const vUv = addView(arrays[1], 34962);
    const vIdx = addView(arrays[2], 34963);
    const vImg = addView(png);

    const bin = new Uint8Array(off);
    for (const [o, b] of parts) bin.set(b, o);

    const gltf = {
      asset: { version: '2.0', generator: '3place Region Exporter' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name }],
      meshes: [{ name, primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
      materials: [{
        name: 'palette',
        doubleSided: false,
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      }],
      textures: [{ sampler: 0, source: 0 }],
      samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
      images: [{ bufferView: vImg, mimeType: 'image/png', name: 'palette' }],
      accessors: [
        { bufferView: vPos, componentType: 5126, count: nVerts, type: 'VEC3', min, max },
        { bufferView: vUv, componentType: 5126, count: nVerts, type: 'VEC2' },
        { bufferView: vIdx, componentType: short ? 5123 : 5125, count: idx.length, type: 'SCALAR' },
      ],
      bufferViews: views,
      buffers: [{ byteLength: bin.length }],
    };

    let jb = new TextEncoder().encode(JSON.stringify(gltf));
    const jpad = (4 - (jb.length % 4)) % 4;
    if (jpad) {
      const t = new Uint8Array(jb.length + jpad);
      t.set(jb); t.fill(0x20, jb.length);
      jb = t;
    }

    const total = 12 + 8 + jb.length + 8 + bin.length;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jb.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    u8.set(jb, 20);
    const bo = 20 + jb.length;
    dv.setUint32(bo, bin.length, true);
    dv.setUint32(bo + 4, 0x004e4942, true);
    u8.set(bin, bo + 8);

    return { glb: buf, verts: nVerts, tris: idx.length / 3, colours: used.length, bytes: total };
  }

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type: type || 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function applyPos(el, p) {
    if (p && p.left != null) {
      el.style.left = p.left + 'px'; el.style.top = p.top + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    } else {
      el.style.right = ((p && p.right) || 14) + 'px';
      el.style.top = ((p && p.top) || 70) + 'px';
    }
  }

  function makeDraggable(el, handle, key, def) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
    applyPos(el, saved || def);
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = 0, dragging = false;
    handle.style.cursor = 'move';
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = 0;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      try { handle.setPointerCapture(e.pointerId); } catch (er) {}
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      el.style.left = Math.min(Math.max(0, ox + dx), innerWidth - el.offsetWidth) + 'px';
      el.style.top = Math.min(Math.max(0, oy + dy), innerHeight - 40) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (er) {}
      if (moved > 4) {
        try {
          localStorage.setItem(key, JSON.stringify({
            left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10) }));
        } catch (er) {}
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    addEventListener('resize', () => {
      const r = el.getBoundingClientRect();
      if (r.left > innerWidth - 60) el.style.left = Math.max(0, innerWidth - el.offsetWidth) + 'px';
      if (r.top > innerHeight - 40) el.style.top = Math.max(0, innerHeight - 60) + 'px';
    });
    return () => moved <= 4;
  }

  const CSS = `
  #tpx{position:fixed;z-index:2147483647;width:216px;background:#fff;color:#1a1a1a;
       border:1px solid #d0d0d0;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       font-size:13px;line-height:1.45}
  #tpx header{display:flex;justify-content:space-between;align-items:center;
       padding:8px 10px;border-bottom:1px solid #ececec;font-weight:600;user-select:none}
  #tpx .body{padding:10px}
  #tpx label{display:block;margin:11px 0 4px;font-size:12px;color:#555}
  #tpx input,#tpx select{width:100%;box-sizing:border-box;padding:5px 6px;border-radius:4px;
       border:1px solid #c6c6c6;background:#fff;color:#1a1a1a;
       font-family:inherit;font-size:13px}
  #tpx input:focus,#tpx select:focus{outline:none;border-color:#666}
  #tpx .row{display:flex;align-items:center;gap:6px}
  #tpx .row input{flex:1;min-width:0}
  #tpx .note{font-size:12px;color:#777}
  #tpx .loc{padding-bottom:9px;border-bottom:1px solid #ececec}
  #tpx .dim{margin-top:5px}
  #tpx details{margin-top:11px}
  #tpx summary{cursor:pointer;font-size:12px;color:#555}
  #tpx button{width:100%;margin-top:13px;padding:7px;border-radius:4px;cursor:pointer;
       background:#1a1a1a;color:#fff;border:1px solid #1a1a1a;
       font-family:inherit;font-size:13px;font-weight:500}
  #tpx button:hover{background:#333}
  #tpx button:disabled{background:#a0a0a0;border-color:#a0a0a0;cursor:default}
  #tpx .st{margin-top:9px;min-height:16px;font-size:12px;color:#555}
  @media (prefers-color-scheme:dark){
    #tpx{background:#1f1f1f;color:#e8e8e8;border-color:#3c3c3c}
    #tpx header,#tpx .loc{border-bottom-color:#343434}
    #tpx label,#tpx summary{color:#a8a8a8}
    #tpx .note,#tpx .st{color:#969696}
    #tpx input,#tpx select{background:#2b2b2b;color:#e8e8e8;border-color:#484848}
    #tpx input:focus,#tpx select:focus{border-color:#8a8a8a}
    #tpx button{background:#e8e8e8;color:#1a1a1a;border-color:#e8e8e8}
    #tpx button:hover{background:#fff}
    #tpx button:disabled{background:#4a4a4a;border-color:#4a4a4a;color:#8a8a8a}
  }`;

  function mount() {
    if (document.getElementById('tpx')) return;
    const st = document.createElement('style'); st.textContent = CSS;
    document.head.appendChild(st);

    const el = document.createElement('div');
    el.id = 'tpx';
    el.innerHTML = `
      <header><span>Region export</span><span id="tpx-t" class="note">Hide</span></header>
      <div class="body">
        <div class="note loc" id="tpx-pt">Pan the map to set a centre</div>
        <label for="tpx-r">Size</label>
        <div class="row">
          <input id="tpx-r" type="number" value="120" min="1" max="600">
          <span class="note">blocks out</span>
        </div>
        <label for="tpx-z0">Height</label>
        <div class="row">
          <input id="tpx-z0" type="number" value="0" min="0" max="511">
          <span class="note">to</span>
          <input id="tpx-z1" type="number" value="64" min="0" max="511">
        </div>
        <div class="note dim" id="tpx-dim"></div>
        <label for="tpx-s">Area</label>
        <select id="tpx-s"><option value="cylinder">Circle</option><option value="box">Square</option></select>
        <label for="tpx-f">File</label>
        <select id="tpx-f"><option value="glb">GLB, textured</option>
                           <option value="obj">OBJ and MTL</option></select>
        <details id="tpx-oo" style="display:none">
          <summary>OBJ options</summary>
          <label for="tpx-m">Colour</label>
          <select id="tpx-m"><option value="material">One material per colour</option>
                             <option value="vertex">Vertex colours</option></select>
          <label for="tpx-cs">Colour space</label>
          <select id="tpx-cs"><option value="linear">Linear, for Blender</option>
                              <option value="srgb">sRGB, raw</option></select>
        </details>
        <button id="tpx-go">Export</button>
        <div class="st" id="tpx-st"></div>
      </div>`;
    document.body.appendChild(el);

    const $ = (id) => document.getElementById(id);
    const status = (s) => { $('tpx-st').textContent = s; };

    const refresh = () => {
      const c = centreFromHash();
      $('tpx-pt').textContent = c
        ? `Centre ${c.xy[0]}, ${c.xy[1]}`
        : 'Pan the map to set a centre';
      return c;
    };

    const dims = () => {
      const r = Math.max(1, +$('tpx-r').value || 0);
      const z0 = Math.max(0, +$('tpx-z0').value || 0);
      const z1 = Math.min(511, +$('tpx-z1').value || 0);
      const h = z1 - z0 + 1;
      $('tpx-dim').textContent = h > 0
        ? `${r * 2 + 1} x ${r * 2 + 1} x ${h} blocks`
        : 'Height range is empty';
    };
    for (const id of ['tpx-r', 'tpx-z0', 'tpx-z1']) $(id).oninput = dims;

    refresh(); dims();
    addEventListener('hashchange', refresh);
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash !== lastHash) { lastHash = location.hash; refresh(); }
    }, 400);

    $('tpx-f').onchange = () => {
      $('tpx-oo').style.display = $('tpx-f').value === 'glb' ? 'none' : '';
    };

    const hdr = el.querySelector('header');
    const wasClick = makeDraggable(el, hdr, 'tpx.pos', { right: 14, top: 392 });
    hdr.onclick = () => {
      if (!wasClick()) return;
      const b = el.querySelector('.body');
      const hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      $('tpx-t').textContent = hidden ? 'Hide' : 'Show';
    };

    $('tpx-go').onclick = async () => {
      const c = refresh();
      if (!c) { status('pan the map to set a centre'); return; }
      const btn = $('tpx-go');
      btn.disabled = true;
      try {
        const rad = Math.max(1, +$('tpx-r').value || 120);
        const z0 = Math.max(0, +$('tpx-z0').value || 0);
        const z1 = Math.min(511, +$('tpx-z1').value || 64);
        const shape = $('tpx-s').value, fmt = $('tpx-f').value;

        status('Reading palette');
        const pal = (await (await fetch('/api/manifest')).json()).palette;

        const vox = await readRegion(c.xy[0], c.xy[1], rad, z0, z1, shape,
          (done, total, n) => status(`Reading ${done} of ${total} chunks, ${n} blocks so far`));
        if (!vox.size) { status('No blocks in that region'); btn.disabled = false; return; }

        status(`Building mesh from ${vox.size} blocks`);
        await sleep(30);
        const stem = `3place_${c.xy[0]}_${c.xy[1]}_r${rad}`;

        if (fmt === 'glb') {
          const g = await buildGLB(vox, c.xy[0], c.xy[1], pal, stem);
          download(`${stem}.glb`, g.glb, 'model/gltf-binary');
          status(`Saved ${stem}.glb, ${g.tris} triangles, ${g.colours} colours, ${(g.bytes / 1048576).toFixed(1)} MB`);
        } else {
          const mode = $('tpx-m').value, linear = $('tpx-cs').value === 'linear';
          const r = buildOBJ(vox, c.xy[0], c.xy[1], mode, pal, linear);
          download(`${stem}.obj`, r.obj);
          if (r.mtl) download(`${stem}.mtl`, r.mtl, 'text/plain');
          status(`Saved ${stem}.obj, ${r.faces} faces, ${r.mats} colours`);
        }
      } catch (e) {
        status('Failed: ' + (e && e.message ? e.message : e));
      }
      btn.disabled = false;
    };
  }

  if (document.readyState === 'loading')
    addEventListener('DOMContentLoaded', mount);
  else mount();
})();
