// Wikipedia Graph Explorer - WebGL2
document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const canvas = $('graphCanvas'), lab = $('labelCanvas'), ctx = lab.getContext('2d');
  const statusEl = $('status'), tooltip = $('tooltip'), infoPanel = $('infoPanel');
  const searchInput = $('searchInput'), searchResults = $('searchResults');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const gl = canvas.getContext('webgl2');
  const esc = s => s.replace(/[&<>]/g, c => '&#' + c.charCodeAt(0) + ';');

  let dirty = true, labelsDirty = true;
  const resize = () => {
    canvas.width = lab.width = innerWidth * dpr;
    canvas.height = lab.height = innerHeight * dpr;
    dirty = labelsDirty = true;
  };
  addEventListener('resize', resize);
  resize();

  // --- Shaders ---
  const VIEW = `uniform vec2 u_res; uniform float u_scale; uniform vec2 u_trans;
  vec4 project(vec2 p) { vec2 c = (p * u_scale + u_trans) / u_res * 2.0 - 1.0; return vec4(c.x, -c.y, 0.0, 1.0); }`;
  const LAYOUT = `uniform sampler2D u_centTex; uniform float u_spread, u_gravScale;
  vec2 transformPos(vec2 p0, float cid) {
    int ic = int(cid + 0.5);
    vec2 c = texelFetch(u_centTex, ivec2(ic & 1023, ic >> 10), 0).xy;
    return c * u_spread + (p0 - c) * u_gravScale;
  }`;
  const HIDE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';

  const program = (vs, fs) => {
    const p = gl.createProgram();
    [[gl.VERTEX_SHADER, '#version 300 es\n' + VIEW + vs],
     [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\n' + fs]].forEach(([t, src]) => {
      const s = gl.createShader(t);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      gl.attachShader(p, s);
    });
    gl.linkProgram(p);
    return p;
  };

  const nodeProg = program(LAYOUT + `
    layout(location=0) in vec2 a_pos; layout(location=1) in vec4 a_color;
    layout(location=2) in float a_deg; layout(location=3) in float a_comm;
    uniform float u_pscale, u_filter, u_minDeg, u_nodeSize;
    out vec3 v_color; out float v_hub;
    void main() {
      if ((u_filter >= 0.0 && a_comm != u_filter) || a_deg < u_minDeg) { ${HIDE} gl_PointSize = 0.0; return; }
      vec4 clip = project(transformPos(a_pos, a_comm));
      if (abs(clip.x) > 1.06 || abs(clip.y) > 1.06) { ${HIDE} gl_PointSize = 0.0; return; }
      gl_Position = clip;
      gl_PointSize = u_nodeSize * (1.5 + 4.5 * clamp(log(1.0 + a_deg) / 7.0, 0.0, 1.0)) * u_pscale;
      v_color = a_color.rgb;
      v_hub = a_deg > 500.0 ? 1.0 : 0.0;
    }`, `
    in vec3 v_color; in float v_hub; uniform float u_dim; out vec4 o;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      vec3 c = mix(v_color, vec3(1.0), 0.35 * (1.0 - r)) * (1.0 + 0.25 * v_hub);
      o = vec4(c, (1.0 - smoothstep(0.5, 1.0, r)) * mix(0.9, 0.08, u_dim));
    }`);

  const edgeProg = program(LAYOUT + `
    layout(location=0) in vec2 a_pos; layout(location=1) in vec4 a_color;
    layout(location=2) in vec2 a_comm; layout(location=3) in vec2 a_meta;
    uniform float u_filter, u_minDeg, u_alpha, u_zoom;
    out vec3 v_color; out float v_alpha;
    void main() {
      float fade = 1.0 / (1.0 + pow(a_meta.y * 2.2, 1.4));
      float a = min(0.45, u_alpha * fade * clamp(pow(u_zoom, 0.25), 1.0, 2.0));
      if ((u_filter >= 0.0 && a_comm.x != u_filter && a_comm.y != u_filter) || a_meta.x < u_minDeg || a < 0.0025) { ${HIDE} return; }
      gl_Position = project(transformPos(a_pos, a_comm.x));
      v_color = a_color.rgb;
      v_alpha = a;
    }`, `
    in vec3 v_color; in float v_alpha; out vec4 o;
    void main() { o = vec4(v_color * 0.72, v_alpha); }`);

  // mode 0: linha | 1: nó destacado com contorno | 2: anel de centro/seleção
  const hlProg = program(`
    layout(location=0) in vec2 a_pos; layout(location=1) in float a_scale;
    uniform float u_size, u_mode; uniform vec2 u_off;
    void main() {
      gl_Position = project(a_pos);
      gl_Position.xy += vec2(u_off.x, -u_off.y) / u_res * 2.0;
      float sc = a_scale > 0.0 ? a_scale : 1.0;
      gl_PointSize = u_mode > 0.5 ? u_size * sc : u_size;
    }`, `
    uniform vec4 u_color; uniform float u_mode; out vec4 o;
    void main() {
      if (u_mode < 0.5) { o = u_color; return; }
      float d = length(gl_PointCoord - 0.5) * 2.0;
      if (d > 1.0) discard;
      if (u_mode < 1.5) {
        vec3 fill = mix(u_color.rgb, vec3(1.0), 0.42 * max(0.0, 1.0 - d / 0.72));
        vec3 rgb = mix(fill, vec3(0.02, 0.03, 0.06), smoothstep(0.66, 0.80, d));
        o = vec4(rgb, (1.0 - smoothstep(0.88, 1.0, d)) * u_color.a);
        return;
      }
      float ring = smoothstep(0.96, 0.85, d) - smoothstep(0.68, 0.58, d);
      float core = smoothstep(0.32, 0.14, d);
      float backing = (smoothstep(1.0, 0.88, d) - smoothstep(0.62, 0.50, d)) * 0.85;
      vec3 col = mix(vec3(0.02, 0.03, 0.06), u_color.rgb, clamp((ring + core) * 1.15, 0.0, 1.0));
      o = vec4(col, max(max(ring, core), backing) * u_color.a);
    }`);

  gl.useProgram(nodeProg); gl.uniform1i(gl.getUniformLocation(nodeProg, 'u_centTex'), 0);
  gl.useProgram(edgeProg); gl.uniform1i(gl.getUniformLocation(edgeProg, 'u_centTex'), 0);

  const u = (p, n, ...v) => gl['uniform' + v.length + 'f'](gl.getUniformLocation(p, n), ...v);
  const buf = (loc, data, size, type = gl.FLOAT, norm = false, usage = gl.STATIC_DRAW) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
    return b;
  };
  const vao = () => { const v = gl.createVertexArray(); gl.bindVertexArray(v); return v; };

  // --- Estado ---
  let minDeg = 0, nodeSize = 1, edgeAlpha = 0.07;
  let filterComm = -1, sel = -1, hov = -1, showEdges = true, showLabels = true;
  let selTitle = '';
  // Destaque atual (vizinhança ou caminho): { layers, centers, labels } -> ver uploadHL()
  let hoodHL = null, pathHL = null, pathOnly = true;
  const focusPath = () => pathOnly && pathHL !== null;
  const hideBg = () => focusPath();
  let hl = null, hlRanges = null, hoodDepth = 1, hoodDir = 'both', maxShown = 2000;

  // --- Câmera ---
  const cam = { zoom: 1, panX: 0, panY: 0 };
  let target = null;
  const base = () => Math.min(canvas.width, canvas.height) * 0.49;
  const scale = () => base() * cam.zoom;
  const transX = () => canvas.width / 2 + cam.panX;
  const transY = () => canvas.height / 2 + cam.panY;
  const flyTo = (wx, wy, zoom = Math.max(cam.zoom, 6)) => {
    const s = base() * zoom;
    target = { zoom, panX: -wx * s, panY: -wy * s };
    dirty = labelsDirty = true;
  };

  let drag = false, moved = false, lx = 0, ly = 0;
  let pendingHov = null, hovRaf = 0;
  canvas.onpointerdown = e => {
    drag = true; moved = false; lx = e.clientX; ly = e.clientY; target = null;
    tooltip.classList.add('hidden');
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };
  canvas.onpointerup = () => {
    const wasMoved = moved;
    drag = false;
    canvas.style.cursor = hov >= 0 ? 'pointer' : 'grab';
    if (wasMoved) dirty = true;
  };
  canvas.onpointerleave = () => { pendingHov = null; tooltip.classList.add('hidden'); };
  canvas.onpointermove = e => {
    if (drag) {
      if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 2) moved = true;
      cam.panX += (e.clientX - lx) * dpr;
      cam.panY += (e.clientY - ly) * dpr;
      lx = e.clientX; ly = e.clientY;
      dirty = labelsDirty = true;
    } else {
      pendingHov = e;
      if (!hovRaf) hovRaf = requestAnimationFrame(() => { hovRaf = 0; if (pendingHov) hover(pendingHov); });
    }
  };
  const zoomAt = (px, py, f) => {
    const s0 = scale(), wx = (px - transX()) / s0, wy = (py - transY()) / s0;
    cam.zoom = Math.max(0.08, Math.min(cam.zoom * f, 500));
    const s1 = scale();
    cam.panX = px - wx * s1 - canvas.width / 2;
    cam.panY = py - wy * s1 - canvas.height / 2;
    dirty = labelsDirty = true;
  };
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    target = null;
    zoomAt(e.clientX * dpr, e.clientY * dpr, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  canvas.ondblclick = e => {
    const s = scale();
    flyTo((e.clientX * dpr - transX()) / s, (e.clientY * dpr - transY()) / s, cam.zoom * 2.5);
  };

  // --- Dados (carregamento concorrente + lookup seguro denso/esparso) ---
  async function fetchBuffer(name) {
    for (const path of [name, '../' + name]) {
      const res = await fetch(path);
      if (res.ok) return res.arrayBuffer();
    }
  }

  statusEl.innerText = 'Carregando binários...';
  let [nbuf, eb, strBuf] = await Promise.all([
    fetchBuffer('nodes.bin'),
    fetchBuffer('edges.bin'),
    fetchBuffer('strings.bin')
  ]);

  let dv = new DataView(nbuf);
  const N = nbuf.byteLength / 26;
  let minId = 0xffffffff, maxId = 0;
  for (let i = 0; i < N; i++) {
    const id = dv.getUint32(i * 26, true);
    if (id < minId) minId = id;
    if (id > maxId) maxId = id;
  }

  let lookup;
  const spanId = maxId - minId + 1;
  if (spanId <= 50000000) {
    lookup = new Int32Array(spanId).fill(-1);
  } else {
    const cap = 2 ** Math.ceil(Math.log2(N * 2 + 1)), mask = cap - 1;
    const hk = new Uint32Array(cap), hv = new Int32Array(cap).fill(-1);
    for (let i = 0; i < N; i++) {
      const id = dv.getUint32(i * 26, true);
      let h = (Math.imul(id, 2654435761) >>> 0) & mask;
      while (hv[h] !== -1) h = (h + 1) & mask;
      hk[h] = id; hv[h] = i;
    }
    lookup = id => {
      let h = (Math.imul(id, 2654435761) >>> 0) & mask;
      while (hv[h] !== -1) { if (hk[h] === id) return hv[h]; h = (h + 1) & mask; }
      return -1;
    };
  }

  const pos = new Float32Array(N * 2), pos0 = new Float32Array(N * 2), deg = new Float32Array(N), comm = new Uint32Array(N);
  const titleOff = new Uint32Array(N), titleLen = new Uint16Array(N);
  const denseLookup = typeof lookup !== 'function';
  let C = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 26;
    if (denseLookup) lookup[dv.getUint32(o, true) - minId] = i;
    pos[i * 2] = dv.getFloat32(o + 4, true);
    pos[i * 2 + 1] = dv.getFloat32(o + 8, true);
    comm[i] = dv.getUint32(o + 16, true);
    titleOff[i] = dv.getUint32(o + 20, true);
    titleLen[i] = dv.getUint16(o + 24, true);
    if (comm[i] > C) C = comm[i];
  }
  C++;
  pos0.set(pos);
  dv = null; nbuf = null;

  let edgeU32 = new Uint32Array(eb);
  const E = eb.byteLength / 8;
  statusEl.innerText = 'Indexando arestas...';
  await new Promise(r => setTimeout(r));
  const g = GraphAlgos.buildCSR(edgeU32, E, N, lookup, minId);
  edgeU32 = null; eb = null; lookup = null;

  for (let i = 0; i < N; i++) deg[i] = GraphAlgos.outDegree(g, i) + GraphAlgos.inDegree(g, i);

  const strings = new Uint8Array(strBuf);
  strBuf = null;
  const decoder = new TextDecoder();
  const titleOf = i => decoder.decode(strings.subarray(titleOff[i], titleOff[i] + titleLen[i]));

  // Comunidades: tamanho, hub (maior grau) e centroide
  const counts = new Uint32Array(C), hubOf = new Int32Array(C).fill(-1);
  const cxs = new Float64Array(C), cys = new Float64Array(C), c0 = new Float32Array(C * 2);
  for (let i = 0; i < N; i++) {
    const c = comm[i];
    counts[c]++;
    cxs[c] += pos[i * 2];
    cys[c] += pos[i * 2 + 1];
    if (hubOf[c] < 0 || deg[i] > deg[hubOf[c]]) hubOf[c] = i;
  }
  for (let c = 0; c < C; c++) {
    const k = Math.max(1, counts[c]);
    c0[c * 2] = cxs[c] / k;
    c0[c * 2 + 1] = cys[c] / k;
  }
  const top = Array.from({ length: C }, (_, i) => i).sort((a, b) => counts[b] - counts[a]).slice(0, 20);
  const commTitle = c => titleOf(hubOf[c]);

  // Cores RGBA8 alinhadas em 32 bits (evita cópias shadow RGB8 no driver GPU)
  const hueIdx = new Uint32Array(C);
  for (let c = 0; c < C; c++) hueIdx[c] = 20 + c;
  top.forEach((c, r) => hueIdx[c] = r);
  const hsl = (h, s, l) => {
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
  };
  const palette = new Uint8Array(C * 4);
  for (let c = 0; c < C; c++) {
    const [r, gr, b] = hsl((hueIdx[c] * 137.508) % 360, 0.85, 0.62);
    palette[c * 4] = r; palette[c * 4 + 1] = gr; palette[c * 4 + 2] = b; palette[c * 4 + 3] = 255;
  }
  const rgb = c => `rgb(${palette[c * 4]},${palette[c * 4 + 1]},${palette[c * 4 + 2]})`;
  const colors = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const co = comm[i] * 4, io = i * 4;
    colors[io] = palette[co]; colors[io + 1] = palette[co + 1];
    colors[io + 2] = palette[co + 2]; colors[io + 3] = 255;
  }

  // Ordenação por grau decrescente (byDeg) e índice inverso (rankOf):
  // na GPU os nós ficam ordenados por grau, então limitar a topN + minDeg
  // desenha apenas um prefixo contínuo sem processar o resto.
  const byDeg = new Int32Array(N), rankOf = new Uint32Array(N);
  {
    const SHn = 2 ** Math.ceil(Math.log2(N + 1)), keys = new Float64Array(N);
    for (let i = 0; i < N; i++) keys[i] = deg[i] * SHn + i;
    keys.sort();
    for (let k = 0; k < N; k++) { const i = keys[N - 1 - k] % SHn; byDeg[k] = i; rankOf[i] = k; }
  }
  const hubs = Array.from(byDeg.subarray(0, Math.min(N, 300)));
  const hubTitles = hubs.map(titleOf);

  // primeiro índice com arr[idx] >= v (arr crescente)
  const lowerBound = (arr, v) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  let topN = Math.min(N, 200000);
  const drawCount = () => {
    if (minDeg <= 0) return topN;
    let lo = 0, hi = topN;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (deg[byDeg[mid]] >= minDeg) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // Grid espacial dinâmico para hover/clique (sem restrição ao intervalo [-1, 1])
  const GS = 256;
  const gridHead = new Int32Array(GS * GS).fill(-1), gridNext = new Int32Array(N);
  let gMinX = -1, gMinY = -1, gScaleX = GS / 2, gScaleY = GS / 2;
  const gcellX = x => Math.min(GS - 1, Math.max(0, ((x - gMinX) * gScaleX) | 0));
  const gcellY = y => Math.min(GS - 1, Math.max(0, ((y - gMinY) * gScaleY) | 0));
  const buildGrid = () => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < N; i++) {
      const x = pos[i * 2], y = pos[i * 2 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    gMinX = x0; gMinY = y0;
    gScaleX = (GS - 1e-4) / Math.max(x1 - x0, 1e-6);
    gScaleY = (GS - 1e-4) / Math.max(y1 - y0, 1e-6);
    gridHead.fill(-1);
    for (let i = 0; i < N; i++) {
      const cell = gcellY(pos[i * 2 + 1]) * GS + gcellX(pos[i * 2]);
      gridNext[i] = gridHead[cell];
      gridHead[cell] = i;
    }
  };
  buildGrid();

  // Arestas de fundo: até PER_NODE_K links estruturais por nó (prioriza mesma comunidade e menor distância)
  statusEl.innerText = 'Selecionando espinha dorsal...';
  await new Promise(r => setTimeout(r));
  const MAX_BG_EDGES = 550000, PER_NODE_K = 6;
  const tmpS = new Uint32Array(MAX_BG_EDGES), tmpT = new Uint32Array(MAX_BG_EDGES);
  let w = 0;
  for (let r = 0; r < N && w < MAX_BG_EDGES; r++) {
    const u = byDeg[r];
    const start = g.outOff[u], end = g.outOff[u + 1];
    const outLen = end - start;
    if (outLen <= 0) continue;
    const ux = pos[u * 2], uy = pos[u * 2 + 1], uc = comm[u];
    if (outLen <= PER_NODE_K) {
      for (let k = start; k < end && w < MAX_BG_EDGES; k++) {
        const v = g.outAdj[k];
        if (v !== u) { tmpS[w] = u; tmpT[w] = v; w++; }
      }
    } else {
      const bestV = new Int32Array(PER_NODE_K).fill(-1);
      const bestScore = new Float64Array(PER_NODE_K).fill(1e18);
      const stride = Math.max(1, Math.floor(outLen / 64));
      for (let k = start; k < end; k += stride) {
        const v = g.outAdj[k];
        if (v === u) continue;
        const dx = pos[v * 2] - ux, dy = pos[v * 2 + 1] - uy;
        const score = (dx * dx + dy * dy) * (comm[v] === uc ? 0.35 : 1.0);
        let worstIdx = 0;
        for (let j = 1; j < PER_NODE_K; j++) if (bestScore[j] > bestScore[worstIdx]) worstIdx = j;
        if (score < bestScore[worstIdx]) { bestScore[worstIdx] = score; bestV[worstIdx] = v; }
      }
      for (let j = 0; j < PER_NODE_K && w < MAX_BG_EDGES; j++) {
        if (bestV[j] >= 0) { tmpS[w] = u; tmpT[w] = bestV[j]; w++; }
      }
    }
  }
  const M = w;
  const es = tmpS.subarray(0, M), et = tmpT.subarray(0, M);
  const ev = new Float32Array(M * 4), ec = new Uint8Array(M * 8);
  const em = new Float32Array(M * 4), ed = new Float32Array(M * 4);
  const edgeKey = new Uint32Array(M);
  {
    const SHm = 2 ** Math.ceil(Math.log2(M + 1)), keys = new Float64Array(M);
    for (let k = 0; k < M; k++) keys[k] = Math.max(rankOf[es[k]], rankOf[et[k]]) * SHm + k;
    keys.sort();
    const s0 = es.slice(), t0 = et.slice();
    for (let k = 0; k < M; k++) {
      const j = keys[k] % SHm;
      es[k] = s0[j]; et[k] = t0[j];
      edgeKey[k] = (keys[k] - j) / SHm;
    }
  }
  for (let k = 0; k < M; k++) {
    const s = es[k], t = et[k];
    const sx = pos[s * 2], sy = pos[s * 2 + 1], tx = pos[t * 2], ty = pos[t * 2 + 1];
    const elen = Math.hypot(tx - sx, ty - sy);
    const md = Math.min(deg[s], deg[t]);
    ev[k * 4] = sx; ev[k * 4 + 1] = sy;
    ev[k * 4 + 2] = tx; ev[k * 4 + 3] = ty;
    const so = s * 4, to = t * 4, ko = k * 8;
    ec[ko] = colors[so]; ec[ko + 1] = colors[so + 1]; ec[ko + 2] = colors[so + 2]; ec[ko + 3] = 255;
    ec[ko + 4] = colors[to]; ec[ko + 5] = colors[to + 1]; ec[ko + 6] = colors[to + 2]; ec[ko + 7] = 255;
    // cada vértice leva (sua própria comunidade, comunidade da outra ponta) para transformPos(a_pos, a_comm.x)
    em[k * 4] = comm[s]; em[k * 4 + 1] = comm[t];
    em[k * 4 + 2] = comm[t]; em[k * 4 + 3] = comm[s];
    ed[k * 4] = ed[k * 4 + 2] = md;
    ed[k * 4 + 1] = ed[k * 4 + 3] = elen;
  }
  const edgeVerts = M * 2;

  // --- Buffers GPU e textura RG32F de centroides ---
  const TEX_W = 1024, TEX_H = Math.max(1, Math.ceil(C / TEX_W));
  const texData = new Float32Array(TEX_W * TEX_H * 2);
  texData.set(c0);
  const centTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, centTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, TEX_H, 0, gl.RG, gl.FLOAT, texData);

  const nodeVao = vao();
  const byRank = (src, k) => {
    const o = new src.constructor(N * k);
    for (let r = 0; r < N; r++) for (let j = 0; j < k; j++) o[r * k + j] = src[byDeg[r] * k + j];
    return o;
  };
  buf(0, byRank(pos0, 2), 2); buf(1, byRank(colors, 4), 4, gl.UNSIGNED_BYTE, true);
  buf(2, byRank(deg, 1), 1); buf(3, byRank(new Float32Array(comm), 1), 1);
  const edgeVao = vao();
  buf(0, ev, 2); buf(1, ec, 4, gl.UNSIGNED_BYTE, true); buf(2, em, 2); buf(3, ed, 2);
  const hlPtVao = vao(), hlPtBuf = buf(0, new Float32Array(2), 2, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const hlPtScaleBuf = buf(1, new Float32Array(1), 1, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const hlLnVao = vao(), hlLnBuf = buf(0, new Float32Array(2), 2, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const hovVao = vao(), hovBuf = buf(0, new Float32Array(2), 2, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  const selVao = vao(), selBuf = buf(0, new Float32Array(2), 2, gl.FLOAT, false, gl.DYNAMIC_DRAW);
  gl.enable(gl.BLEND);

  $('nodeCount').innerText = N.toLocaleString();
  $('edgeCount').innerText = E.toLocaleString();
  $('commCount').innerText = C.toLocaleString();
  const setStatus = () => statusEl.innerText = pathHL ? pathHL.status
    : sel >= 0 ? 'Selecionado: ' + selTitle
    : filterComm >= 0 ? 'Comunidade: ' + commTitle(filterComm)
    : (edgeVerts / 2).toLocaleString() + ' arestas estruturais';
  setStatus();

  // --- Renderização ---
  const use = (p, v) => {
    gl.useProgram(p);
    gl.bindVertexArray(v);
    u(p, 'u_res', canvas.width, canvas.height);
    u(p, 'u_scale', scale());
    u(p, 'u_trans', transX(), transY());
  };

  let spread = 1, grav = 0;

  function render() {
    const md = minDeg, dc = drawCount(), dim = hl ? 1 : 0;
    const ps = Math.min(3.5, Math.sqrt(cam.zoom)) * dpr;
    const hlPs = Math.min(2.6, Math.pow(cam.zoom, 0.38)) * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.024, 0.035, 0.067, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (showEdges && !hideBg()) {
      use(edgeProg, edgeVao);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      u(edgeProg, 'u_filter', filterComm);
      u(edgeProg, 'u_minDeg', md);
      u(edgeProg, 'u_alpha', dim ? Math.min(0.015, edgeAlpha * 0.25) : edgeAlpha);
      u(edgeProg, 'u_zoom', cam.zoom);
      u(edgeProg, 'u_spread', spread);
      u(edgeProg, 'u_gravScale', 1 - grav);
      const eCnt = Math.min(lowerBound(edgeKey, dc) * 2, drag ? 350000 : edgeVerts);
      gl.drawArrays(gl.LINES, 0, eCnt);
    }

    if (!hideBg()) {
      use(nodeProg, nodeVao);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      u(nodeProg, 'u_pscale', ps);
      u(nodeProg, 'u_filter', filterComm);
      u(nodeProg, 'u_minDeg', md);
      u(nodeProg, 'u_nodeSize', nodeSize);
      u(nodeProg, 'u_dim', dim);
      u(nodeProg, 'u_spread', spread);
      u(nodeProg, 'u_gravScale', 1 - grav);
      gl.drawArrays(gl.POINTS, 0, dc);
    }

    if (hl && hlRanges) {
      const th = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
      use(hlProg, hlLnVao);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      u(hlProg, 'u_mode', 0);
      hl.layers.forEach((L, k) => {
        const R = hlRanges[k];
        if (!R.lineCount) return;
        const la = L.lineAlpha !== undefined ? L.lineAlpha : L.color[3];
        u(hlProg, 'u_color', L.color[0], L.color[1], L.color[2], la);
        for (const [ox, oy] of L.thick ? th : th.slice(0, 1)) {
          u(hlProg, 'u_off', ox * dpr * 0.7, oy * dpr * 0.7);
          gl.drawArrays(gl.LINES, R.lineStart, R.lineCount);
        }
      });
      u(hlProg, 'u_off', 0, 0);

      use(hlProg, hlPtVao);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      u(hlProg, 'u_off', 0, 0);
      u(hlProg, 'u_mode', 1);
      hl.layers.forEach((L, k) => {
        const R = hlRanges[k];
        if (!R.ptCount) return;
        const pa = L.ptAlpha !== undefined ? L.ptAlpha : 1.0;
        u(hlProg, 'u_size', (nodeSize * 6.2 + 5.5) * L.size * hlPs);
        u(hlProg, 'u_color', L.color[0], L.color[1], L.color[2], pa);
        gl.drawArrays(gl.POINTS, R.ptStart, R.ptCount);
      });
      u(hlProg, 'u_mode', 2);
      u(hlProg, 'u_size', (nodeSize * 7.2 + 16) * hlPs);
      u(hlProg, 'u_color', 1, 1, 1, 1);
      gl.drawArrays(gl.POINTS, 0, hl.centers.length);
    }

    if (sel >= 0) {
      use(hlProg, selVao);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      u(hlProg, 'u_off', 0, 0);
      u(hlProg, 'u_mode', 2);
      u(hlProg, 'u_size', (nodeSize * 6.5 + 18) * hlPs);
      u(hlProg, 'u_color', 0.22, 0.74, 0.97, 0.98);
      gl.drawArrays(gl.POINTS, 0, 1);
    }

    if (hov >= 0 && hov !== sel) {
      use(hlProg, hovVao);
      u(hlProg, 'u_off', 0, 0);
      u(hlProg, 'u_mode', 2);
      u(hlProg, 'u_size', 20 * dpr * Math.min(2, Math.sqrt(cam.zoom)));
      u(hlProg, 'u_color', 1, 1, 1, 0.85);
      gl.drawArrays(gl.POINTS, 0, 1);
    }
  }

  // --- Rótulos (canvas 2D, com anti-colisão e cache de largura de texto) ---
  const textWidthCache = new Map();
  function drawLabels() {
    ctx.clearRect(0, 0, lab.width, lab.height);
    if (!showLabels) return;
    const s = scale(), tx = transX(), ty = transY(), W = lab.width, H = lab.height, placed = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    let curFont = '';
    const put = (t, wx, wy, size, fill, a = 1, bold = false) => {
      const x = wx * s + tx, y = wy * s + ty;
      if (x < 0 || y < 0 || x > W || y > H) return;
      const font = `${bold ? '600 ' : ''}${size * dpr}px -apple-system, "Segoe UI", Roboto, sans-serif`;
      if (font !== curFont) { ctx.font = font; curFont = font; }
      const cKey = `${bold ? 1 : 0}:${size}:${t}`;
      let bw = textWidthCache.get(cKey);
      if (bw === undefined) {
        if (textWidthCache.size > 4000) textWidthCache.clear();
        bw = ctx.measureText(t).width + 8 * dpr;
        textWidthCache.set(cKey, bw);
      }
      const bh = size * dpr * 1.3;
      if (placed.some(b => Math.abs(b[0] - x) < (b[2] + bw) / 2 && Math.abs(b[1] - y) < (b[3] + bh) / 2)) return;
      placed.push([x, y, bw, bh]);
      ctx.globalAlpha = a;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(6,9,17,0.85)';
      ctx.strokeText(t, x, y);
      ctx.fillStyle = fill;
      ctx.fillText(t, x, y);
    };

    if (hl) {
      hl.centers.forEach((i, k) => put(hl.centerTitles[k], pos[i * 2], pos[i * 2 + 1] - 16 * dpr / s, 14, '#fff', 1, true));
      let hlPlaced = 0;
      for (const [i, t] of hl.labels) {
        const before = placed.length;
        put(t, pos[i * 2], pos[i * 2 + 1] - 12 * dpr / s, 12, '#fde68a', 1);
        if (placed.length > before && ++hlPlaced >= 85) break;
      }
    }

    if (hideBg()) { ctx.globalAlpha = 1; return; }

    const ca = Math.max(0, Math.min(1, (3.2 - cam.zoom) / 2));
    if (ca > 0 && filterComm < 0)
      for (const c of top) put(commTitle(c), cxs[c] / counts[c], cys[c] / counts[c], 15, rgb(c), ca, true);

    const md = minDeg, dc = drawCount();
    const n = cam.zoom < 1.5 ? 0 : Math.min(hubs.length, Math.floor(8 * cam.zoom * cam.zoom));
    for (let k = 0; k < n; k++) {
      const i = hubs[k];
      if ((filterComm >= 0 && comm[i] !== filterComm) || deg[i] < md || rankOf[i] >= dc) continue;
      put(hubTitles[k], pos[i * 2], pos[i * 2 + 1], 12, '#e2e8f0', 0.9);
    }
    ctx.globalAlpha = 1;
  }

  (function frame() {
    if (target) {
      cam.zoom += (target.zoom - cam.zoom) * 0.12;
      cam.panX += (target.panX - cam.panX) * 0.12;
      cam.panY += (target.panY - cam.panY) * 0.12;
      dirty = labelsDirty = true;
      if (Math.abs(target.zoom - cam.zoom) < 0.005 && Math.abs(target.panX - cam.panX) < 0.3 && Math.abs(target.panY - cam.panY) < 0.3) {
        Object.assign(cam, target);
        target = null;
      }
    }
    if (dirty) { dirty = false; render(); }
    if (labelsDirty) { labelsDirty = false; drawLabels(); }
    requestAnimationFrame(frame);
  })();

  // --- Hover / clique ---
  function nearest(mx, my) {
    const s = scale(), wx = (mx - transX()) / s, wy = (my - transY()) / s;
    const r = Math.max(10, 14 * nodeSize) * dpr / s, md = minDeg, dc = drawCount();
    let best = r * r, hit = -1;
    if (focusPath()) {
      for (const i of pathHL.fit) {
        const dx = pos[i * 2] - wx, dy = pos[i * 2 + 1] - wy, d = dx * dx + dy * dy;
        if (d < best) { best = d; hit = i; }
      }
      return hit;
    }
    for (let gy = gcellY(wy - r); gy <= gcellY(wy + r); gy++)
      for (let gx = gcellX(wx - r); gx <= gcellX(wx + r); gx++)
        for (let i = gridHead[gy * GS + gx]; i !== -1; i = gridNext[i]) {
          if ((filterComm >= 0 && comm[i] !== filterComm) || deg[i] < md || rankOf[i] >= dc) continue;
          const dx = pos[i * 2] - wx, dy = pos[i * 2 + 1] - wy, d = dx * dx + dy * dy;
          if (d < best) { best = d; hit = i; }
        }
    return hit;
  }

  function hover(e) {
    const h = nearest(e.clientX * dpr, e.clientY * dpr);
    if (h !== hov) {
      hov = h;
      canvas.style.cursor = h >= 0 ? 'pointer' : 'grab';
      if (h >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, hovBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pos.slice(h * 2, h * 2 + 2), gl.DYNAMIC_DRAW);
      }
      dirty = true;
    }
    if (h < 0) return tooltip.classList.add('hidden');
    tooltip.innerHTML = `<b>${esc(titleOf(h))}</b><br><span style="color:#94a3b8">Grau ${deg[h]} · ` +
      `<span style="color:${rgb(comm[h])}">●</span> ${esc(commTitle(comm[h]))}</span>`;
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    tooltip.classList.remove('hidden');
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    tooltip.style.left = Math.max(8, Math.min(e.clientX + 14, innerWidth - tw - 12)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(e.clientY + 14, innerHeight - th - 12)) + 'px';
  }

  canvas.onclick = e => {
    if (moved || e.detail > 1) return;
    const h = nearest(e.clientX * dpr, e.clientY * dpr);
    // só o caminho na tela: clique seleciona/inspeciona o nó sem desfazer o caminho
    if (focusPath()) {
      if (h >= 0) { selectNodeInPath(h); flyTo(pos[h * 2], pos[h * 2 + 1], Math.max(cam.zoom, 10)); }
      return;
    }
    h < 0 ? clearSelection() : selectNode(h);
  };

  // --- Destaques (vizinhança / caminho) ---
  // hl = { layers: [{ color: [r,g,b,a], lineAlpha, ptAlpha, size, thick, pairs: [a,b,...], pts: [i,...] }],
  //        centers: [i], centerTitles: [], labels: [[i, titulo]], fit: [i], status }
  const LEVEL_COLORS = [[0.98, 0.75, 0.25], [0.30, 0.85, 0.50], [0.22, 0.74, 0.97], [0.65, 0.55, 0.98], [0.96, 0.45, 0.70]];
  const PATH_COLOR = [0.96, 0.45, 0.71, 0.95];
  const cssColor = c => `rgb(${c.slice(0, 3).map(v => Math.round(v * 255))})`;

  function updateSelBuf() {
    if (sel < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, selBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos.slice(sel * 2, sel * 2 + 2), gl.DYNAMIC_DRAW);
  }

  function uploadHL() {
    if (!hl) { hlRanges = null; return; }
    let nPairs = 0, nPts = hl.centers.length;
    for (const L of hl.layers) { nPairs += L.pairs.length / 2; nPts += L.pts.length; }
    const lines = new Float32Array(nPairs * 4), pts = new Float32Array(nPts * 2), scales = new Float32Array(nPts);
    let lw = 0, pw = 0, sw = 0;
    for (const i of hl.centers) {
      pts[pw++] = pos[i * 2]; pts[pw++] = pos[i * 2 + 1];
      scales[sw++] = 1.35;
    }
    hlRanges = hl.layers.map(L => {
      const R = { lineStart: lw / 2, lineCount: L.pairs.length, ptStart: pw / 2, ptCount: L.pts.length };
      for (let k = 0; k < L.pairs.length; k += 2) {
        const a = L.pairs[k], b = L.pairs[k + 1];
        lines[lw++] = pos[a * 2]; lines[lw++] = pos[a * 2 + 1];
        lines[lw++] = pos[b * 2]; lines[lw++] = pos[b * 2 + 1];
      }
      for (const i of L.pts) {
        pts[pw++] = pos[i * 2]; pts[pw++] = pos[i * 2 + 1];
        scales[sw++] = 1.0 + 0.70 * Math.min(1, Math.log(1 + deg[i]) / 8.5);
      }
      return R;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, hlPtBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, hlPtScaleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, scales, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, hlLnBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
  }

  function refreshHL() {
    hl = pathHL || hoodHL;
    uploadHL();
    setStatus();
    dirty = labelsDirty = true;
  }

  const SH = 2 ** Math.ceil(Math.log2(N + 1));
  // ordena nós por grau decrescente (chave numérica = grau * SH + índice; sort nativo de Float64Array)
  function byDegree(list) {
    const keys = new Float64Array(list.length);
    for (let k = 0; k < list.length; k++) keys[k] = deg[list[k]] * SH + list[k];
    keys.sort();
    const outList = new Int32Array(list.length);
    for (let k = 0; k < keys.length; k++) outList[k] = keys[keys.length - 1 - k] % SH;
    return outList;
  }

  function fitNodes(list) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const i of list) {
      x0 = Math.min(x0, pos[i * 2]); x1 = Math.max(x1, pos[i * 2]);
      y0 = Math.min(y0, pos[i * 2 + 1]); y1 = Math.max(y1, pos[i * 2 + 1]);
    }
    flyTo((x0 + x1) / 2, (y0 + y1) / 2, Math.min(40, Math.max(0.1, 1.35 / Math.max(x1 - x0, y1 - y0, 0.04))));
  }

  function fillNeighborsList(level1) {
    const shown = level1.slice(0, 24);
    $('infoNeighbors').textContent = `${shown.length} de ${level1.length.toLocaleString()}`;
    const nl = $('neighborsList');
    nl.innerHTML = '';
    for (const ni of shown) {
      const chip = document.createElement('span');
      chip.className = 'neighborChip';
      chip.textContent = titleOf(ni);
      chip.style.borderColor = rgb(comm[ni]);
      chip.onclick = () => {
        if (focusPath()) {
          selectNodeInPath(ni);
          flyTo(pos[ni * 2], pos[ni * 2 + 1]);
        } else {
          selectNode(ni);
          flyTo(pos[ni * 2], pos[ni * 2 + 1]);
        }
      };
      nl.appendChild(chip);
    }
  }

  function populateInfoPanel(i, keepPath = false) {
    sel = i;
    selTitle = titleOf(i);
    if (!keepPath) pathHL = null;
    updateSelBuf();
    $('infoTitle').textContent = selTitle;
    $('infoDeg').textContent = `Grau ${deg[i]} (↗${GraphAlgos.outDegree(g, i)} ↙${GraphAlgos.inDegree(g, i)})`;
    $('infoComm').textContent = commTitle(comm[i]);
    $('infoComm').style.borderColor = rgb(comm[i]);
    $('wikiLink').href = 'https://pt.wikipedia.org/wiki/' + encodeURIComponent(selTitle.replace(/ /g, '_'));
    infoPanel.classList.remove('hidden');
  }

  const hoodTreeMark = new Uint32Array(N);
  let hoodTreeStamp = 0;

  // --- Vizinhança: BFS até `hoodDepth` a partir do nó selecionado ---
  // Contagens por nível são exatas; o desenho mostra só os nós de maior grau
  // (até `maxShown`, dividido entre os níveis), ligados por arestas da árvore da BFS.
  function computeHood() {
    if (sel < 0) { hoodHL = null; return refreshHL(); }
    const r = GraphAlgos.bfsFast(g, sel, hoodDepth, hoodDir);
    const reached = r.levelStart.length - 2;
    if (hoodTreeStamp >= 0x7ffffffe) { hoodTreeMark.fill(0); hoodTreeStamp = 0; }
    const stamp = ++hoodTreeStamp;
    hoodTreeMark[sel] = stamp;
    const layers = [], labels = [], fit = [sel], rows = [];
    let remaining = maxShown, nLabels = 0, level1 = [];

    for (let d = 1; d <= reached; d++) {
      const cand = [];
      for (let k = r.levelStart[d]; k < r.levelStart[d + 1]; k++) {
        const v = r.order[k];
        if (hoodTreeMark[r.parent[v]] === stamp) cand.push(v);
      }
      const sorted = byDegree(cand);
      if (d === 1) level1 = sorted;
      const take = Math.min(sorted.length, Math.ceil(remaining / (reached - d + 1)));
      remaining -= take;
      const col = LEVEL_COLORS[d - 1];
      const la = Math.max(0.18, 0.55 - 0.08 * (d - 1));
      const L = { color: [...col, la], lineAlpha: la, ptAlpha: 1.0, size: 1 - 0.10 * (d - 1), thick: false, pairs: [], pts: [] };
      for (let k = 0; k < take; k++) {
        const v = sorted[k];
        hoodTreeMark[v] = stamp;
        L.pairs.push(r.parent[v], v);
        L.pts.push(v);
        fit.push(v);
        if (nLabels < 14 && k < (d === 1 ? 8 : 3)) { labels.push([v, titleOf(v)]); nLabels++; }
      }
      layers.push(L);
      rows.push({ d, total: r.levelStart[d + 1] - r.levelStart[d], shown: take });
    }
    hoodHL = { layers, centers: [sel], centerTitles: [selTitle], labels, fit };

    // painel: níveis
    const list = $('levelList');
    list.innerHTML = '';
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'levelRow';
      el.innerHTML = `<span class="dot" style="background:${cssColor(LEVEL_COLORS[row.d - 1])}"></span><span>Nível ${row.d}</span>` +
        `<span class="cnt">${row.total.toLocaleString()}${row.shown < row.total ? ` (${row.shown.toLocaleString()} desenhados)` : ''}</span>`;
      list.appendChild(el);
    }
    if (!rows.length) list.innerHTML = '<div class="hint">Nenhum link nessa direção.</div>';
    const total = r.order.length - 1;
    $('fitHood').textContent = `Enquadrar vizinhança (${total.toLocaleString()} artigos)`;

    fillNeighborsList(level1);
    refreshHL();
  }

  function clearSelection() {
    sel = -1;
    hoodHL = null;
    infoPanel.classList.add('hidden');
    refreshHL();
  }

  function selectNode(i) {
    populateInfoPanel(i);
    $('hoodControls').classList.remove('hidden');
    computeHood();
  }

  function selectNodeInPath(i) {
    populateInfoPanel(i, true);
    $('hoodControls').classList.add('hidden');
    const seen = new Set([i]), nb = [];
    GraphAlgos.forEachNeighbor(g, i, 'both', v => { if (!seen.has(v)) { seen.add(v); nb.push(v); } });
    fillNeighborsList(byDegree(nb));
    dirty = labelsDirty = true;
  }

  const goto = i => {
    selectNode(i);
    flyTo(pos[i * 2], pos[i * 2 + 1], 12);
  };
  $('clearSel').onclick = clearSelection;

  $('sliderDepth').oninput = e => { $('valDepth').textContent = e.target.value; };
  $('sliderDepth').onchange = e => { hoodDepth = +e.target.value; computeHood(); if (hoodHL) fitNodes(hoodHL.fit); };
  $('sliderMaxShown').oninput = e => { $('valMaxShown').textContent = (+e.target.value).toLocaleString(); };
  $('sliderMaxShown').onchange = e => { maxShown = +e.target.value; computeHood(); };
  $('hoodDir').onchange = e => { hoodDir = e.target.value; computeHood(); };
  $('fitHood').onclick = () => { if (hoodHL) fitNodes(hoodHL.fit); };

  // --- Busca: títulos que começam com o termo vêm primeiro; depois por grau ---
  // O índice rápido só tem artigos de grau >= 60; "Buscar em todos" varre todos os títulos.
  const pool = [];
  for (let i = 0; i < N; i++) if (deg[i] >= 60) { const t = titleOf(i); pool.push({ i, t, l: t.toLowerCase(), d: deg[i] }); }
  pool.sort((a, b) => b.d - a.d);
  const rank = (arr, q) => arr.sort((a, b) => (b.l.startsWith(q) - a.l.startsWith(q)) || (b.d - a.d)).slice(0, 8);

  function fullSearch(q) {
    const m = [];
    for (let i = 0; i < N && m.length < 3000; i++) {
      const t = titleOf(i), l = t.toLowerCase();
      if (l.includes(q)) m.push({ i, t, l, d: deg[i] });
    }
    return rank(m, q);
  }

  function makeSearch(input, results, onPick, onEdit) {
    let first = null, focusIdx = -1;
    const hide = () => { results.classList.add('hidden'); focusIdx = -1; };
    const setFocus = idx => {
      const items = results.querySelectorAll('.searchItem[data-pick]');
      if (!items.length) { focusIdx = -1; return; }
      focusIdx = ((idx % items.length) + items.length) % items.length;
      items.forEach((el, k) => el.classList.toggle('focused', k === focusIdx));
      items[focusIdx].scrollIntoView({ block: 'nearest' });
    };
    const render = (m, q, full) => {
      first = m.length ? m[0] : null;
      focusIdx = -1;
      results.innerHTML = m.length ? '' : '<div class="searchItem" style="cursor:default">Nenhum artigo encontrado</div>';
      for (const p of m) {
        const item = document.createElement('div');
        item.className = 'searchItem';
        item.dataset.pick = '1';
        item.innerHTML = `<span>${esc(p.t)}</span><span class="searchDeg">${p.d}</span>`;
        item._pick = p;
        item.onclick = () => { hide(); onPick(p); };
        results.appendChild(item);
      }
      if (!full) {
        const more = document.createElement('div');
        more.className = 'searchItem';
        more.style.color = '#7dd3fc';
        more.textContent = 'Buscar em todos os artigos (inclui os pouco conectados)';
        more.onclick = e => {
          e.stopPropagation();
          more.textContent = 'Buscando...';
          setTimeout(() => render(fullSearch(q), q, true));
        };
        results.appendChild(more);
      }
      results.classList.remove('hidden');
    };
    input.oninput = () => {
      if (onEdit) onEdit();
      const q = input.value.trim().toLowerCase();
      first = null;
      if (q.length < 2) return hide();
      render(rank(pool.filter(p => p.l.includes(q)).slice(0, 200), q), q, false);
    };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' && !results.classList.contains('hidden')) {
        e.preventDefault();
        setFocus(focusIdx < 0 ? 0 : focusIdx + 1);
      } else if (e.key === 'ArrowUp' && !results.classList.contains('hidden')) {
        e.preventDefault();
        setFocus(focusIdx < 0 ? -1 : focusIdx - 1);
      } else if (e.key === 'Escape' && !results.classList.contains('hidden')) {
        e.preventDefault();
        e.stopPropagation();
        hide();
        input.blur();
      } else if (e.key === 'Enter') {
        const items = results.querySelectorAll('.searchItem[data-pick]');
        const chosen = focusIdx >= 0 && items[focusIdx] ? items[focusIdx]._pick : first;
        if (chosen) { hide(); onPick(chosen); input.blur(); }
      }
    };
    document.addEventListener('click', e => {
      if (!input.contains(e.target) && !results.contains(e.target)) hide();
    });
  }

  makeSearch(searchInput, searchResults, p => { searchInput.value = p.t; goto(p.i); });

  // --- Menor caminho ---
  const pathPanel = $('pathPanel'), pathResult = $('pathResult');
  let pathFrom = -1, pathTo = -1;
  const pickInto = (inputId, set) => p => { $(inputId).value = p.t; set(p.i); };
  makeSearch($('pathFrom'), $('pathFromResults'), pickInto('pathFrom', i => pathFrom = i), () => { pathFrom = -1; });
  makeSearch($('pathTo'), $('pathToResults'), pickInto('pathTo', i => pathTo = i), () => { pathTo = -1; });

  const openPath = () => {
    pathPanel.classList.remove('hidden');
    $('btnPath').classList.add('active');
  };
  $('btnPath').onclick = () => {
    const opening = pathPanel.classList.contains('hidden');
    if (opening) {
      openPath();
    } else {
      pathPanel.classList.add('hidden');
      $('btnPath').classList.remove('active');
      clearPath();
    }
  };
  $('closePath').onclick = () => {
    pathPanel.classList.add('hidden');
    $('btnPath').classList.remove('active');
    clearPath();
  };
  $('setFrom').onclick = () => { if (sel < 0) return; pathFrom = sel; $('pathFrom').value = selTitle; openPath(); };
  $('setTo').onclick = () => { if (sel < 0) return; pathTo = sel; $('pathTo').value = selTitle; openPath(); };
  $('pathSwap').onclick = () => {
    [pathFrom, pathTo] = [pathTo, pathFrom];
    [$('pathFrom').value, $('pathTo').value] = [$('pathTo').value, $('pathFrom').value];
  };

  function clearPath() {
    pathHL = null;
    pathResult.innerHTML = '';
    refreshHL();
  }
  $('pathClear').onclick = clearPath;
  $('chkPathOnly').onchange = e => { pathOnly = e.target.checked; hov = -1; dirty = labelsDirty = true; };

  $('pathGo').onclick = () => {
    if (pathFrom < 0 || pathTo < 0) {
      pathResult.innerHTML = '<div class="warn">Escolha origem e destino na lista de sugestões.</div>';
      return;
    }
    pathResult.textContent = 'Calculando...';
    setTimeout(() => {
      const directed = $('pathDir').value === 'dir';
      const t0 = performance.now();
      const r = GraphAlgos.shortestPath(g, pathFrom, pathTo, directed);
      const ms = Math.round(performance.now() - t0);
      const info = `${r.visited.toLocaleString()} artigos explorados em ${ms} ms`;
      if (!r.path) {
        pathHL = null;
        pathResult.innerHTML = `<div class="summary warn">Não há caminho ${directed ? 'seguindo o sentido dos links' : 'entre esses artigos'}.` +
          `${directed ? ' Tente "Ignorar o sentido".' : ''}</div><div class="hint">${info}</div>`;
        return refreshHL();
      }
      const p = r.path;
      sel = -1; hoodHL = null;
      infoPanel.classList.add('hidden');
      const inner = p.slice(1, -1);
      pathHL = {
        layers: [{ color: PATH_COLOR, lineAlpha: 0.90, ptAlpha: 1.0, size: 1.1, thick: true, pairs: p.flatMap((v, k) => k ? [p[k - 1], v] : []), pts: inner }],
        centers: [p[0], p[p.length - 1]],
        centerTitles: [titleOf(p[0]), titleOf(p[p.length - 1])],
        labels: inner.map(v => [v, titleOf(v)]),
        fit: p,
        status: `Caminho: ${r.length} link${r.length === 1 ? '' : 's'}`,
      };
      pathResult.innerHTML = `<div class="summary">${r.length === 0 ? 'Origem e destino são o mesmo artigo.' :
        `Menor caminho: <b>${r.length}</b> link${r.length === 1 ? '' : 's'}`}<div class="hint">${info}</div></div>`;
      p.forEach((v, k) => {
        if (k) {
          const f = GraphAlgos.hasEdge(g, p[k - 1], v), b = GraphAlgos.hasEdge(g, v, p[k - 1]);
          const a = document.createElement('div');
          a.className = 'pathArrow';
          a.textContent = f && b ? '↕ (links nos dois sentidos)' : f ? '↓ linka para' : '↑ é linkado por';
          pathResult.appendChild(a);
        }
        const step = document.createElement('div');
        step.className = 'pathStep';
        const chip = document.createElement('span');
        chip.className = 'neighborChip';
        chip.textContent = titleOf(v);
        chip.style.borderColor = rgb(comm[v]);
        chip.onclick = () => { selectNodeInPath(v); flyTo(pos[v * 2], pos[v * 2 + 1], Math.max(cam.zoom, 10)); };
        step.appendChild(chip);
        pathResult.appendChild(step);
      });
      refreshHL();
      fitNodes(p);
    });
  };

  addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      pathPanel.classList.add('hidden');
      $('btnPath').classList.remove('active');
      clearSelection(); clearPath(); document.activeElement.blur();
    }
    else if (e.key === '/' && !/INPUT|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); searchInput.focus(); }
  });

  // --- Espalhamento / gravidade ao vivo na GPU (oninput) + sync CPU ao soltar (onchange) ---
  function updateLiveLayout() {
    for (let c = 0; c < C; c++) {
      cxs[c] = c0[c * 2] * counts[c] * spread;
      cys[c] = c0[c * 2 + 1] * counts[c] * spread;
    }
    dirty = labelsDirty = true;
  }
  function relayout() {
    const G = 1 - grav;
    for (let i = 0; i < N; i++) {
      const c = comm[i] * 2;
      pos[i * 2] = c0[c] * spread + (pos0[i * 2] - c0[c]) * G;
      pos[i * 2 + 1] = c0[c + 1] * spread + (pos0[i * 2 + 1] - c0[c + 1]) * G;
    }
    updateLiveLayout();
    buildGrid();
    hov = -1;
    updateSelBuf();
    uploadHL();
  }
  const bindLayout = (id, fn) => {
    $(id).oninput = e => { fn(+e.target.value); updateLiveLayout(); };
    $(id).onchange = relayout;
  };
  bindLayout('sliderSpread', v => { spread = v; $('valSpread').textContent = v.toFixed(1) + 'x'; });
  bindLayout('sliderGrav', v => { grav = v; $('valGrav').textContent = Math.round(v * 100) + '%'; });

  // --- Controles ---
  const degFromSlider = v => v <= 20 ? v : Math.round(20 + Math.pow((v - 20) / 80, 2) * 480);
  $('sliderDeg').oninput = e => {
    minDeg = degFromSlider(+e.target.value);
    $('valDeg').textContent = minDeg.toLocaleString();
    dirty = labelsDirty = true;
  };
  $('sliderSize').oninput = e => { nodeSize = +e.target.value; $('valSize').textContent = nodeSize.toFixed(1) + 'x'; dirty = true; };
  $('sliderEdge').oninput = e => { edgeAlpha = +e.target.value; $('valEdge').textContent = edgeAlpha.toFixed(3); dirty = true; };
  // escala logarítmica: 0 -> 1.000 nós, 1000 -> todos
  const topNFromSlider = v => v >= 1000 ? N : Math.round(1000 * Math.pow(N / 1000, v / 1000));
  const showTopN = () => $('valTopN').textContent = topN >= N ? 'todos' : topN.toLocaleString();
  $('sliderTopN').value = Math.round(1000 * Math.log(topN / 1000) / Math.log(N / 1000));
  showTopN();
  $('sliderTopN').oninput = e => { topN = topNFromSlider(+e.target.value); showTopN(); hov = -1; dirty = labelsDirty = true; };
  $('chkEdges').onchange = e => { showEdges = e.target.checked; dirty = true; };
  $('chkLabels').onchange = e => { showLabels = e.target.checked; labelsDirty = true; };

  $('btnRandom').onclick = () => {
    for (let t = 0; t < 200; t++) {
      const i = (Math.random() * N) | 0;
      if (deg[i] >= 15) return goto(i);
    }
  };
  $('btnReset').onclick = () => {
    pathPanel.classList.add('hidden');
    $('btnPath').classList.remove('active');
    target = { zoom: 1, panX: 0, panY: 0 }; clearSelection(); clearPath(); setFilter(-1);
  };

  // --- Comunidades ---
  const rows = new Map();
  for (const c of top) {
    const row = document.createElement('div');
    row.className = 'commRow';
    row.innerHTML = `<span class="dot" style="background:${rgb(c)}"></span><span>${esc(commTitle(c))}</span>` +
      `<span class="cnt">${counts[c].toLocaleString()}</span>`;
    row.onclick = () => setFilter(filterComm === c ? -1 : c);
    rows.set(c, row);
    $('commList').appendChild(row);
  }

  function focusCommunity(c) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < N; i++) {
      if (comm[i] !== c) continue;
      x0 = Math.min(x0, pos[i * 2]); x1 = Math.max(x1, pos[i * 2]);
      y0 = Math.min(y0, pos[i * 2 + 1]); y1 = Math.max(y1, pos[i * 2 + 1]);
    }
    flyTo((x0 + x1) / 2, (y0 + y1) / 2, Math.min(30, Math.max(1.8, 1.8 / Math.max(x1 - x0, y1 - y0, 0.08))));
  }

  function setFilter(c) {
    if (c >= 0 && pathHL) {
      clearPath(); pathPanel.classList.add('hidden'); $('btnPath').classList.remove('active');
    }
    filterComm = c;
    clearSelection();
    for (const [k, row] of rows) row.classList.toggle('active', k === c);
    $('clearFilter').classList.toggle('active', c === -1);
    if (c >= 0) focusCommunity(c);
    setStatus();
    dirty = labelsDirty = true;
  }
  $('clearFilter').classList.add('active');
  $('clearFilter').onclick = () => setFilter(-1);
});