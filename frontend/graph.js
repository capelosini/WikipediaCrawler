// Algoritmos de grafo para o Wikipedia Graph Explorer (sem dependência de DOM/WebGL).
//
// O grafo é guardado em CSR (compressed sparse row), uma vez para links que saem
// ("out") e outra para links que entram ("in"):
//   outOff[i] .. outOff[i+1]  ->  faixa de outAdj com os destinos dos links do nó i
//   inOff[i]  .. inOff[i+1]   ->  faixa de inAdj com as origens dos links que chegam em i
// Com 30M de arestas isso ocupa ~240 MB em 2 Uint32Array, sem objetos por nó.
(function (root) {
  'use strict';

  const MODES = { out: 1, in: 2, both: 3 };

  // edges: Uint32Array [src0, dst0, src1, dst1, ...] com os ids originais do Neo4j.
  // lookup pode ser um array/TypedArray (valores < 0 ou >= N são ignorados) ou função (id) => índice.
  function buildCSR(edges, E, N, lookup, minId) {
    const outOff = new Uint32Array(N + 1), inOff = new Uint32Array(N + 1);
    const isFn = typeof lookup === 'function';
    const L = isFn ? 0 : lookup.length;
    let valid = 0;
    for (let e = 0; e < E; e++) {
      let s, t;
      if (isFn) {
        s = lookup(edges[e * 2]);
        t = lookup(edges[e * 2 + 1]);
      } else {
        const a = edges[e * 2] - minId, b = edges[e * 2 + 1] - minId;
        if (a >= L || b >= L || a < 0 || b < 0) continue;
        s = lookup[a];
        t = lookup[b];
      }
      if (s < 0 || t < 0 || s >= N || t >= N) continue;
      outOff[s + 1]++;
      inOff[t + 1]++;
      valid++;
    }
    for (let i = 0; i < N; i++) { outOff[i + 1] += outOff[i]; inOff[i + 1] += inOff[i]; }
    const outAdj = new Uint32Array(valid), inAdj = new Uint32Array(valid);
    const oc = outOff.slice(0, N), ic = inOff.slice(0, N);
    for (let e = 0; e < E; e++) {
      let s, t;
      if (isFn) {
        s = lookup(edges[e * 2]);
        t = lookup(edges[e * 2 + 1]);
      } else {
        const a = edges[e * 2] - minId, b = edges[e * 2 + 1] - minId;
        if (a >= L || b >= L || a < 0 || b < 0) continue;
        s = lookup[a];
        t = lookup[b];
      }
      if (s < 0 || t < 0 || s >= N || t >= N) continue;
      outAdj[oc[s]++] = t;
      inAdj[ic[t]++] = s;
    }
    return { N, E: valid, outOff, outAdj, inOff, inAdj };
  }

  const outDegree = (g, i) => g.outOff[i + 1] - g.outOff[i];
  const inDegree = (g, i) => g.inOff[i + 1] - g.inOff[i];

  function hasEdge(g, a, b) {
    for (let k = g.outOff[a]; k < g.outOff[a + 1]; k++) if (g.outAdj[k] === b) return true;
    return false;
  }

  // Chama fn(v) para cada vizinho de u. mode: 'out' | 'in' | 'both'.
  function forEachNeighbor(g, u, mode, fn) {
    const m = MODES[mode];
    if (m & 1) for (let k = g.outOff[u]; k < g.outOff[u + 1]; k++) fn(g.outAdj[k]);
    if (m & 2) for (let k = g.inOff[u]; k < g.inOff[u + 1]; k++) fn(g.inAdj[k]);
  }

  // BFS limitada por profundidade a partir de src.
  // Retorna:
  //   order      nós alcançados, em ordem de BFS (order[0] === src)
  //   levelStart levelStart[d] .. levelStart[d+1] = faixa de `order` à distância d
  //              (length === profundidade alcançada + 2)
  //   dist       Int8Array(N): distância ao src, -1 se não alcançado
  //   parent     Int32Array(N): pai na árvore da BFS (-1 para src e não alcançados)
  function bfs(g, src, maxDepth, mode) {
    const N = g.N, m = MODES[mode];
    const dist = new Int8Array(N).fill(-1), parent = new Int32Array(N).fill(-1);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    queue[tail++] = src;
    dist[src] = 0;
    const levelStart = [0];
    let curLevel = 0;
    while (head < tail) {
      if (dist[queue[head]] !== curLevel) { levelStart.push(head); curLevel++; }
      const u = queue[head++], d = dist[u];
      if (d >= maxDepth) continue;
      if (m & 1) for (let k = g.outOff[u], e = g.outOff[u + 1]; k < e; k++) {
        const v = g.outAdj[k];
        if (dist[v] < 0) { dist[v] = d + 1; parent[v] = u; queue[tail++] = v; }
      }
      if (m & 2) for (let k = g.inOff[u], e = g.inOff[u + 1]; k < e; k++) {
        const v = g.inAdj[k];
        if (dist[v] < 0) { dist[v] = d + 1; parent[v] = u; queue[tail++] = v; }
      }
    }
    levelStart.push(tail);
    return { order: queue.subarray(0, tail), levelStart, dist, parent };
  }

  // Menor caminho (em número de links) entre s e t por BFS bidirecional com buffers reutilizáveis.
  // directed = true : segue o sentido dos links (s -> ... -> t).
  // directed = false: ignora o sentido dos links.
  // Retorna { path: number[] | null, visited, length } onde path inclui s e t.
  function shortestPath(g, s, t, directed) {
    if (s === t) return { path: [s], visited: 1, length: 0 };
    ensureScratch(g);
    if (g._spStamp >= 0x7ffffffe) {
      g._spMarkF.fill(0);
      g._spMarkB.fill(0);
      g._spStamp = 0;
    }
    const stamp = ++g._spStamp;
    const fMode = directed ? 1 : 3, bMode = directed ? 2 : 3;
    const markF = g._spMarkF, markB = g._spMarkB;
    const parF = g._spParF, parB = g._spParB;
    let fA = g._spFrontA, fB = g._spFrontB, nextArr = g._spNext;
    markF[s] = stamp; parF[s] = -1;
    markB[t] = stamp; parB[t] = -1;
    fA[0] = s; fB[0] = t;
    let lenF = 1, lenB = 1, visited = 2;

    while (lenF > 0 && lenB > 0) {
      // expande sempre o lado com menos nós na fronteira
      const fwd = lenF <= lenB;
      const front = fwd ? fA : fB, len = fwd ? lenF : lenB;
      const mark = fwd ? markF : markB, otherMark = fwd ? markB : markF;
      const par = fwd ? parF : parB, m = fwd ? fMode : bMode;
      let nLen = 0, meet = -1;

      for (let x = 0; x < len && meet < 0; x++) {
        const u = front[x];
        if (m & 1) for (let k = g.outOff[u], e = g.outOff[u + 1]; k < e; k++) {
          const v = g.outAdj[k];
          if (mark[v] === stamp) continue;
          mark[v] = stamp; par[v] = u; visited++;
          if (otherMark[v] === stamp) { meet = v; break; }
          nextArr[nLen++] = v;
        }
        if (meet < 0 && (m & 2)) for (let k = g.inOff[u], e = g.inOff[u + 1]; k < e; k++) {
          const v = g.inAdj[k];
          if (mark[v] === stamp) continue;
          mark[v] = stamp; par[v] = u; visited++;
          if (otherMark[v] === stamp) { meet = v; break; }
          nextArr[nLen++] = v;
        }
      }
      if (meet >= 0) {
        const path = [];
        for (let v = meet; v !== -1; v = parF[v]) path.push(v);
        path.reverse();
        for (let v = parB[meet]; v !== -1; v = parB[v]) path.push(v);
        return { path, visited, length: path.length - 1 };
      }
      if (fwd) { const tmp = fA; fA = nextArr; nextArr = tmp; lenF = nLen; }
      else { const tmp = fB; fB = nextArr; nextArr = tmp; lenB = nLen; }
    }
    return { path: null, visited, length: -1 };
  }

  // Buffers reutilizáveis para evitar alocações de dezenas de MB por clique no Modo Rede e Caminho
  function ensureScratch(g) {
    const N = g.N;
    if (g._bfsMark && g._bfsMark.length === N) return g;
    g._bfsMark = new Uint32Array(N);
    g._bfsStamp = 0;
    g._bfsDist = new Int16Array(N);
    g._bfsParent = new Int32Array(N);
    g._bfsQueue = new Int32Array(N);
    g._netMark = new Uint32Array(N);
    g._netStamp = 0;
    g._netHop = new Int16Array(N);
    g._treeMark = new Uint32Array(N);
    g._treeStamp = 0;
    g._spMarkF = new Uint32Array(N);
    g._spMarkB = new Uint32Array(N);
    g._spStamp = 0;
    g._spParF = new Int32Array(N);
    g._spParB = new Int32Array(N);
    g._spFrontA = new Int32Array(N);
    g._spFrontB = new Int32Array(N);
    g._spNext = new Int32Array(N);
    return g;
  }

  function nextStamp(g, markKey, stampKey) {
    if (g[stampKey] >= 0x7ffffffe) {
      g[markKey].fill(0);
      g[stampKey] = 0;
    }
    return ++g[stampKey];
  }

  // BFS rápida com reset esparso por carimbo; retorna { order, levelStart, dist, parent }
  // (order/levelStart são novos arrays pequenos apenas para os nós alcançados).
  function bfsBounded(g, src, maxDepth, mode) {
    ensureScratch(g);
    const m = MODES[mode];
    const mark = g._bfsMark, dist = g._bfsDist, parent = g._bfsParent, queue = g._bfsQueue;
    const stamp = nextStamp(g, '_bfsMark', '_bfsStamp');
    let head = 0, tail = 0;
    mark[src] = stamp;
    dist[src] = 0;
    parent[src] = -1;
    queue[tail++] = src;
    const levelStart = [0];
    let curLevel = 0;
    while (head < tail) {
      const u = queue[head++];
      const d = dist[u];
      if (d !== curLevel) { levelStart.push(head - 1); curLevel = d; }
      if (d >= maxDepth) continue;
      if (m & 1) for (let k = g.outOff[u], e = g.outOff[u + 1]; k < e; k++) {
        const v = g.outAdj[k];
        if (mark[v] !== stamp) {
          mark[v] = stamp; dist[v] = d + 1; parent[v] = u; queue[tail++] = v;
        }
      }
      if (m & 2) for (let k = g.inOff[u], e = g.inOff[u + 1]; k < e; k++) {
        const v = g.inAdj[k];
        if (mark[v] !== stamp) {
          mark[v] = stamp; dist[v] = d + 1; parent[v] = u; queue[tail++] = v;
        }
      }
    }
    levelStart.push(tail);
    return { order: queue.slice(0, tail), levelStart, dist, parent };
  }

  const hasInSet = (set, v) => {
    if (!set) return false;
    return typeof set.has === 'function' ? set.has(v) : Boolean(set[v]);
  };

  // Calcula a próxima profundidade para `src` em Modo Rede de forma incremental nível a nível:
  // retorna imediatamente no primeiro nível >= currentDepth + 1 que revele pelo menos 1 nó novo.
  function expandSourceDepth(g, inNetSet, src, currentDepth, mode, maxDepth = 8) {
    const startDepth = Math.max(1, currentDepth + 1);
    if (startDepth > maxDepth) return { depth: currentDepth, added: 0 };
    if (currentDepth === 0 && !hasInSet(inNetSet, src)) {
      const r1 = bfsBounded(g, src, 1, mode);
      let added = 1;
      for (let k = 1; k < r1.order.length; k++) {
        if (!hasInSet(inNetSet, r1.order[k])) added++;
      }
      return { depth: 1, added };
    }

    ensureScratch(g);
    const m = MODES[mode];
    const mark = g._bfsMark, queue = g._bfsQueue;
    const stamp = nextStamp(g, '_bfsMark', '_bfsStamp');
    let head = 0, tail = 0;
    mark[src] = stamp;
    queue[tail++] = src;

    for (let d = 1; d <= maxDepth && head < tail; d++) {
      const levelEnd = tail;
      let added = 0;
      while (head < levelEnd) {
        const u = queue[head++];
        if (m & 1) for (let k = g.outOff[u], e = g.outOff[u + 1]; k < e; k++) {
          const v = g.outAdj[k];
          if (mark[v] !== stamp) {
            mark[v] = stamp;
            queue[tail++] = v;
            if (d >= startDepth && !hasInSet(inNetSet, v)) added++;
          }
        }
        if (m & 2) for (let k = g.inOff[u], e = g.inOff[u + 1]; k < e; k++) {
          const v = g.inAdj[k];
          if (mark[v] !== stamp) {
            mark[v] = stamp;
            queue[tail++] = v;
            if (d >= startDepth && !hasInSet(inNetSet, v)) added++;
          }
        }
      }
      if (d >= startDepth && added > 0) return { depth: d, added };
      if (d >= startDepth && tail > 250000) break;
    }
    return { depth: currentDepth, added: 0 };
  }

  // Constrói o subgrafo união de múltiplas fontes [nodeIdx, depth].
  // Preserva toda a estrutura existente ao adicionar ou expandir qualquer nó.
  function buildNetwork(g, sources, mode, opts = {}) {
    const maxPerLevel = opts.maxPerLevel !== undefined ? opts.maxPerLevel : 3000;
    const deg = opts.deg || null;
    const includeCrossEdges = opts.includeCrossEdges !== false;
    const maxCrossEdges = opts.maxCrossEdges !== undefined ? opts.maxCrossEdges : 12000;

    ensureScratch(g);
    const N = g.N;
    const SH = 2 ** Math.ceil(Math.log2(N + 1));
    const netMark = g._netMark, netHop = g._netHop, treeMark = g._treeMark;
    const netStamp = nextStamp(g, '_netMark', '_netStamp');

    const nodes = [];
    const treePairs = [];
    const crossPairs = [];
    const sourceStats = [];
    const seenEdges = new Set();
    let truncated = false;

    const addNode = (v, hop) => {
      if (netMark[v] !== netStamp) {
        netMark[v] = netStamp;
        netHop[v] = hop;
        nodes.push(v);
      } else if (hop < netHop[v]) {
        netHop[v] = hop;
      }
    };

    const addTreeEdge = (u, v, hop) => {
      const key = u < v ? u * N + v : v * N + u;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      treePairs.push([u, v, hop]);
    };

    for (let sIdx = 0; sIdx < sources.length; sIdx++) {
      const [src, depth] = sources[sIdx];
      if (depth < 1) continue;
      const r = bfsBounded(g, src, depth, mode);
      const reachedLevels = r.levelStart.length - 2;
      const treeStamp = nextStamp(g, '_treeMark', '_treeStamp');
      treeMark[src] = treeStamp;
      addNode(src, 0);
      let shown = 0;

      for (let d = 1; d <= reachedLevels; d++) {
        const cand = [];
        for (let k = r.levelStart[d]; k < r.levelStart[d + 1]; k++) {
          const v = r.order[k];
          if (treeMark[r.parent[v]] === treeStamp) cand.push(v);
        }
        let take = cand.length;
        if (maxPerLevel > 0 && take > maxPerLevel) {
          truncated = true;
          if (deg) {
            const keys = new Float64Array(take);
            for (let i = 0; i < take; i++) keys[i] = deg[cand[i]] * SH + cand[i];
            keys.sort();
            for (let i = 0; i < maxPerLevel; i++) cand[i] = keys[take - 1 - i] % SH;
          }
          take = maxPerLevel;
        }
        for (let k = 0; k < take; k++) {
          const v = cand[k];
          treeMark[v] = treeStamp;
          addNode(v, d);
          addTreeEdge(r.parent[v], v, d);
          shown++;
        }
      }
      sourceStats.push({
        node: src,
        depth,
        reached: r.order.length - 1,
        shown
      });
    }

    if (includeCrossEdges) {
      outer: for (let i = 0; i < nodes.length; i++) {
        const u = nodes[i];
        const start = g.outOff[u], end = g.outOff[u + 1];
        const outLen = end - start;
        const step = outLen > 256 ? Math.floor(outLen / 256) : 1;
        let perNode = 0;
        for (let k = start; k < end; k += step) {
          const v = g.outAdj[k];
          if (v === u || netMark[v] !== netStamp) continue;
          const key = u < v ? u * N + v : v * N + u;
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          crossPairs.push([u, v]);
          if (crossPairs.length >= maxCrossEdges) {
            truncated = true;
            break outer;
          }
          if (++perNode >= 48) break;
        }
      }
    }

    const minHop = new Int16Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) minHop[i] = netHop[nodes[i]];

    return { nodes, minHop, treePairs, crossPairs, sourceStats, truncated };
  }

  // --- Layout incremental por forças para o Modo Rede (Barnes-Hut + molas) ---
  function createNetLayout() {
    return {
      coords: new Map(),
      nodes: new Int32Array(0),
      idxOf: new Map(),
      x: new Float32Array(0),
      y: new Float32Array(0),
      vx: new Float32Array(0),
      vy: new Float32Array(0),
      mass: new Float32Array(0),
      pin: new Float32Array(0),
      fx: new Float32Array(0),
      fy: new Float32Array(0),
      treeU: new Int32Array(0),
      treeV: new Int32Array(0),
      treeLen: new Float32Array(0),
      crossU: new Int32Array(0),
      crossV: new Int32Array(0),
      crossW: new Float32Array(0),
      rootIdx: -1,
      singleRoot: false,
      spread: 1.0,
      alpha: 0,
      L0: 0.08,
      _qCx: new Float32Array(0),
      _qCy: new Float32Array(0),
      _qMass: new Float32Array(0),
      _qHalf: new Float32Array(0),
      _qMx: new Float32Array(0),
      _qMy: new Float32Array(0),
      _qChild: new Int32Array(0),
      _qLeaf: new Int32Array(0),
      _qNext: new Int32Array(0),
      _qStack: new Int32Array(512)
    };
  }

  function ensureQuadPool(layout, minCap, K) {
    if (layout._qNext.length < K) layout._qNext = new Int32Array(K);
    if (layout._qCx.length >= minCap) return;
    const cap = Math.max(256, minCap);
    layout._qCx = new Float32Array(cap);
    layout._qCy = new Float32Array(cap);
    layout._qMass = new Float32Array(cap);
    layout._qHalf = new Float32Array(cap);
    layout._qMx = new Float32Array(cap);
    layout._qMy = new Float32Array(cap);
    layout._qChild = new Int32Array(cap * 4);
    layout._qLeaf = new Int32Array(cap);
  }

  function syncNetLayout(layout, netResult, opts = {}) {
    const comm = opts.comm || null;
    const sources = opts.sources || [];
    const reheat = opts.reheat !== false;

    if (!netResult || !netResult.nodes || !netResult.nodes.length) {
      layout.coords.clear();
      layout.nodes = new Int32Array(0);
      layout.idxOf = new Map();
      layout.x = new Float32Array(0);
      layout.y = new Float32Array(0);
      layout.vx = new Float32Array(0);
      layout.vy = new Float32Array(0);
      layout.mass = new Float32Array(0);
      layout.pin = new Float32Array(0);
      layout.fx = new Float32Array(0);
      layout.fy = new Float32Array(0);
      layout.treeU = new Int32Array(0);
      layout.treeV = new Int32Array(0);
      layout.treeLen = new Float32Array(0);
      layout.crossU = new Int32Array(0);
      layout.crossV = new Int32Array(0);
      layout.crossW = new Float32Array(0);
      layout.rootIdx = -1;
      layout.singleRoot = false;
      layout.alpha = 0;
      return layout;
    }

    const K = netResult.nodes.length;
    const nodes = new Int32Array(netResult.nodes);
    const idxOf = new Map();
    for (let k = 0; k < K; k++) idxOf.set(nodes[k], k);

    // Preserva coordenadas de nós que continuam na rede e remove nós descartados
    for (const key of layout.coords.keys()) {
      if (!idxOf.has(key)) layout.coords.delete(key);
    }

    const existed = new Uint8Array(K);
    let sumX = 0, sumY = 0, cntPlaced = 0, maxX = -1e9;
    for (let k = 0; k < K; k++) {
      const c = layout.coords.get(nodes[k]);
      if (c) {
        existed[k] = 1;
        sumX += c[0];
        sumY += c[1];
        cntPlaced++;
        if (c[0] > maxX) maxX = c[0];
      }
    }

    const locDeg = new Uint32Array(K);
    const tPairs = netResult.treePairs || [];
    const cPairs = netResult.crossPairs || [];
    const childrenOf = new Map();
    const placedNeighbors = new Map();

    const addNb = (a, b) => {
      let arr = placedNeighbors.get(a);
      if (!arr) { arr = []; placedNeighbors.set(a, arr); }
      arr.push(b);
    };

    for (let e = 0; e < tPairs.length; e++) {
      const u = tPairs[e][0], v = tPairs[e][1];
      const ku = idxOf.get(u), kv = idxOf.get(v);
      if (ku === undefined || kv === undefined) continue;
      locDeg[ku]++; locDeg[kv]++;
      addNb(u, v); addNb(v, u);
      if (!existed[kv]) {
        let kids = childrenOf.get(u);
        if (!kids) { kids = []; childrenOf.set(u, kids); }
        kids.push(v);
      }
    }
    for (let e = 0; e < cPairs.length; e++) {
      const u = cPairs[e][0], v = cPairs[e][1];
      const ku = idxOf.get(u), kv = idxOf.get(v);
      if (ku === undefined || kv === undefined) continue;
      locDeg[ku]++; locDeg[kv]++;
      addNb(u, v); addNb(v, u);
    }

    // Ordena novos filhos por comunidade para manter irmãos próximos angularmente
    for (const kids of childrenOf.values()) {
      kids.sort((a, b) => ((comm ? comm[a] - comm[b] : 0) || (a - b)));
    }

    const queue = [];
    for (const id of layout.coords.keys()) queue.push(id);

    // Posiciona fontes novas que ainda não estavam na rede
    const L0 = layout.L0;
    for (let s = 0; s < sources.length; s++) {
      const sid = sources[s];
      if (!idxOf.has(sid) || layout.coords.has(sid)) continue;
      const sx = cntPlaced === 0 ? 0 : maxX + 4 * L0 * layout.spread;
      const sy = cntPlaced === 0 ? 0 : sumY / cntPlaced;
      layout.coords.set(sid, [sx, sy]);
      sumX += sx; sumY += sy; cntPlaced++;
      if (sx > maxX) maxX = sx;
      queue.push(sid);
    }

    // Posiciona novos filhos em leque voltado para fora da estrutura existente
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head];
      const kids = childrenOf.get(p);
      if (!kids || !kids.length) continue;
      const pc = layout.coords.get(p);
      if (!pc) continue;
      const px = pc[0], py = pc[1];
      const cx = cntPlaced > 0 ? sumX / cntPlaced : 0;
      const cy = cntPlaced > 0 ? sumY / cntPlaced : 0;
      const dpc = Math.hypot(px - cx, py - cy);
      const fullCircle = dpc < 1e-4;
      const baseAng = fullCircle ? 0 : Math.atan2(py - cy, px - cx);
      const m = kids.length;
      const arc = fullCircle ? Math.PI * 2 : Math.min(Math.PI * 1.65, Math.PI * 0.45 + m * 0.12);

      for (let j = 0; j < m; j++) {
        const v = kids[j];
        if (layout.coords.has(v)) continue;
        const ang = fullCircle
          ? (Math.PI * 2 * j) / m
          : (m === 1 ? baseAng : baseAng - arc * 0.5 + (arc * j) / (m - 1));
        const rad = L0 * layout.spread * (0.95 + 0.22 * Math.sqrt(m)) * (1 + 0.10 * ((j % 3) - 1));
        let vx0 = px + Math.cos(ang) * rad;
        let vy0 = py + Math.sin(ang) * rad;

        const nbs = placedNeighbors.get(v);
        if (nbs && nbs.length >= 2) {
          let nx = 0, ny = 0, nc = 0;
          for (let q = 0; q < nbs.length; q++) {
            const nc0 = layout.coords.get(nbs[q]);
            if (nc0) { nx += nc0[0]; ny += nc0[1]; nc++; }
          }
          if (nc >= 2) {
            vx0 = 0.65 * vx0 + 0.35 * (nx / nc);
            vy0 = 0.65 * vy0 + 0.35 * (ny / nc);
          }
        }

        layout.coords.set(v, [vx0, vy0]);
        sumX += vx0; sumY += vy0; cntPlaced++;
        if (vx0 > maxX) maxX = vx0;
        queue.push(v);
      }
    }

    // Fallback defensivo caso algum nó tenha ficado desconectado
    for (let k = 0; k < K; k++) {
      const id = nodes[k];
      if (!layout.coords.has(id)) {
        const fx0 = (cntPlaced > 0 ? sumX / cntPlaced : 0) + L0 * Math.cos(k * 2.399963);
        const fy0 = (cntPlaced > 0 ? sumY / cntPlaced : 0) + L0 * Math.sin(k * 2.399963);
        layout.coords.set(id, [fx0, fy0]);
        sumX += fx0; sumY += fy0; cntPlaced++;
      }
    }

    const x = new Float32Array(K), y = new Float32Array(K);
    const vx = new Float32Array(K), vy = new Float32Array(K);
    const mass = new Float32Array(K), pin = new Float32Array(K);
    const srcSet = new Set(sources);

    layout.singleRoot = sources.length === 1 && idxOf.has(sources[0]);
    layout.rootIdx = layout.singleRoot ? idxOf.get(sources[0]) : -1;

    for (let k = 0; k < K; k++) {
      const id = nodes[k];
      const c = layout.coords.get(id);
      x[k] = c[0]; y[k] = c[1];
      mass[k] = 1.0 + 0.35 * Math.log(1 + locDeg[k]);
      if (srcSet.has(id)) pin[k] = sources.length === 1 ? 0.08 : (existed[k] ? 0.35 : 0.75);
      else pin[k] = 1.0;
    }

    const treeU = new Int32Array(tPairs.length);
    const treeV = new Int32Array(tPairs.length);
    const treeLen = new Float32Array(tPairs.length);
    let tw = 0;
    for (let e = 0; e < tPairs.length; e++) {
      const ku = idxOf.get(tPairs[e][0]), kv = idxOf.get(tPairs[e][1]);
      if (ku === undefined || kv === undefined) continue;
      treeU[tw] = ku; treeV[tw] = kv;
      treeLen[tw] = L0 * (1 + 0.20 * Math.log(1 + Math.max(locDeg[ku], locDeg[kv])));
      tw++;
    }

    const crossU = new Int32Array(cPairs.length);
    const crossV = new Int32Array(cPairs.length);
    const crossW = new Float32Array(cPairs.length);
    let cw = 0;
    for (let e = 0; e < cPairs.length; e++) {
      const ku = idxOf.get(cPairs[e][0]), kv = idxOf.get(cPairs[e][1]);
      if (ku === undefined || kv === undefined) continue;
      crossU[cw] = ku; crossV[cw] = kv;
      crossW[cw] = 0.22 / Math.sqrt(Math.max(1, locDeg[ku] * locDeg[kv]));
      cw++;
    }

    layout.nodes = nodes;
    layout.idxOf = idxOf;
    layout.x = x; layout.y = y;
    layout.vx = vx; layout.vy = vy;
    layout.mass = mass; layout.pin = pin;
    layout.fx = new Float32Array(K);
    layout.fy = new Float32Array(K);
    layout.treeU = tw === tPairs.length ? treeU : treeU.subarray(0, tw);
    layout.treeV = tw === tPairs.length ? treeV : treeV.subarray(0, tw);
    layout.treeLen = tw === tPairs.length ? treeLen : treeLen.subarray(0, tw);
    layout.crossU = cw === cPairs.length ? crossU : crossU.subarray(0, cw);
    layout.crossV = cw === cPairs.length ? crossV : crossV.subarray(0, cw);
    layout.crossW = cw === cPairs.length ? crossW : crossW.subarray(0, cw);
    if (reheat) layout.alpha = 0.9;
    return layout;
  }

  function stepNetLayout(layout, steps = 1) {
    const K = layout.nodes.length;
    if (K <= 1 || layout.alpha <= 0.004) return false;

    const x = layout.x, y = layout.y, vx = layout.vx, vy = layout.vy;
    const fx = layout.fx, fy = layout.fy, mass = layout.mass, pin = layout.pin;
    const tU = layout.treeU, tV = layout.treeV, tLen = layout.treeLen;
    const cU = layout.crossU, cV = layout.crossV, cW = layout.crossW;

    if (K > 400) ensureQuadPool(layout, K * 8 + 128, K);

    for (let st = 0; st < steps && layout.alpha > 0.004; st++) {
      const S = layout.L0 * layout.spread;
      const minD = S * 0.44, minD2 = minD * minD;
      const soft2 = S * S * 0.06;
      const kRep = S * S * 0.85;
      const kOverlap = S * 2.2;
      const kTree = 0.45;
      const kGrav = 0.03;

      fx.fill(0);
      fy.fill(0);

      if (K <= 400) {
        for (let i = 0; i < K; i++) {
          const xi = x[i], yi = y[i], mi = mass[i];
          for (let j = i + 1; j < K; j++) {
            let dx = xi - x[j], dy = yi - y[j];
            let d2 = dx * dx + dy * dy;
            if (d2 < 1e-12) {
              const a = (i * 2.399963 + j) % (Math.PI * 2);
              dx = Math.cos(a) * 1e-4; dy = Math.sin(a) * 1e-4; d2 = 1e-8;
            }
            let rep = (kRep * mi * mass[j]) / (d2 + soft2);
            if (d2 < minD2) {
              const d = Math.sqrt(d2);
              rep += (kOverlap * (minD - d)) / d;
            }
            const rx = dx * rep, ry = dy * rep;
            fx[i] += rx; fy[i] += ry;
            fx[j] -= rx; fy[j] -= ry;
          }
        }
      } else {
        // Barnes-Hut Quadtree em arrays planos sem closures internas (zero boxing V8)
        let x0 = x[0], x1 = x[0], y0 = y[0], y1 = y[0];
        for (let i = 1; i < K; i++) {
          if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
          if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i];
        }
        const half0 = Math.max((x1 - x0) * 0.5, (y1 - y0) * 0.5, S) * 1.05;
        let qCx = layout._qCx, qCy = layout._qCy, qMass = layout._qMass, qHalf = layout._qHalf;
        let qMx = layout._qMx, qMy = layout._qMy, qChild = layout._qChild, qLeaf = layout._qLeaf;
        const qNext = layout._qNext;

        let qCount = 1;
        qCx[0] = (x0 + x1) * 0.5; qCy[0] = (y0 + y1) * 0.5; qHalf[0] = half0;
        qMass[0] = 0; qMx[0] = 0; qMy[0] = 0; qLeaf[0] = -1;

        for (let pIdx = 0; pIdx < K; pIdx++) {
          const px = x[pIdx], py = y[pIdx], pm = mass[pIdx];
          let node = 0, depth = 0;
          while (true) {
            const prevM = qMass[node], newM = prevM + pm;
            qMx[node] = (qMx[node] * prevM + px * pm) / newM;
            qMy[node] = (qMy[node] * prevM + py * pm) / newM;
            qMass[node] = newM;

            const lf = qLeaf[node];
            if (lf === -1) {
              qLeaf[node] = pIdx;
              qNext[pIdx] = -1;
              break;
            }
            if (lf >= 0) {
              if (depth >= 10 || (Math.abs(px - x[lf]) < 1e-5 && Math.abs(py - y[lf]) < 1e-5)) {
                qNext[pIdx] = lf;
                qLeaf[node] = pIdx;
                break;
              }
              if (qCount + 4 >= qCx.length) {
                const oldCap = qCx.length, newCap = oldCap * 2;
                const nCx = new Float32Array(newCap); nCx.set(qCx); layout._qCx = qCx = nCx;
                const nCy = new Float32Array(newCap); nCy.set(qCy); layout._qCy = qCy = nCy;
                const nM = new Float32Array(newCap); nM.set(qMass); layout._qMass = qMass = nM;
                const nH = new Float32Array(newCap); nH.set(qHalf); layout._qHalf = qHalf = nH;
                const nMx = new Float32Array(newCap); nMx.set(qMx); layout._qMx = qMx = nMx;
                const nMy = new Float32Array(newCap); nMy.set(qMy); layout._qMy = qMy = nMy;
                const nCh = new Int32Array(newCap * 4); nCh.set(qChild); layout._qChild = qChild = nCh;
                const nLf = new Int32Array(newCap); nLf.set(qLeaf); layout._qLeaf = qLeaf = nLf;
              }
              const h2 = qHalf[node] * 0.5, cx = qCx[node], cy = qCy[node];
              const base4 = node * 4;
              for (let q = 0; q < 4; q++) {
                const id = qCount++;
                qCx[id] = cx + (q & 1 ? h2 : -h2);
                qCy[id] = cy + (q & 2 ? h2 : -h2);
                qHalf[id] = h2;
                qMass[id] = 0; qMx[id] = 0; qMy[id] = 0; qLeaf[id] = -1;
                qChild[base4 + q] = id;
              }
              qLeaf[node] = -2;

              let cur = lf;
              while (cur !== -1) {
                const nxt = qNext[cur];
                const ch = qChild[base4 + (x[cur] >= cx ? 1 : 0) + (y[cur] >= cy ? 2 : 0)];
                const cm = mass[cur], prevCm = qMass[ch], newCm = prevCm + cm;
                qMx[ch] = (qMx[ch] * prevCm + x[cur] * cm) / newCm;
                qMy[ch] = (qMy[ch] * prevCm + y[cur] * cm) / newCm;
                qMass[ch] = newCm;
                qNext[cur] = qLeaf[ch];
                qLeaf[ch] = cur;
                cur = nxt;
              }
            }
            node = qChild[node * 4 + (px >= qCx[node] ? 1 : 0) + (py >= qCy[node] ? 2 : 0)];
            depth++;
          }
        }

        const theta2 = 0.85;
        let stack = layout._qStack;
        for (let i = 0; i < K; i++) {
          const xi = x[i], yi = y[i], mi = mass[i];
          let sp = 0, fix = 0, fiy = 0;
          stack[sp++] = 0;
          while (sp > 0) {
            const node = stack[--sp];
            const nm = qMass[node];
            if (nm === 0) continue;
            const lf = qLeaf[node];
            if (lf >= 0) {
              let p = lf;
              while (p !== -1) {
                if (p !== i) {
                  let dx = xi - x[p], dy = yi - y[p], d2 = dx * dx + dy * dy;
                  if (d2 < 1e-12) {
                    const a = (i * 2.399963 + p) % (Math.PI * 2);
                    dx = Math.cos(a) * 1e-4; dy = Math.sin(a) * 1e-4; d2 = 1e-8;
                  }
                  let rep = (kRep * mi * mass[p]) / (d2 + soft2);
                  if (d2 < minD2) {
                    const d = Math.sqrt(d2);
                    rep += (kOverlap * (minD - d)) / d;
                  }
                  fix += dx * rep; fiy += dy * rep;
                }
                p = qNext[p];
              }
            } else {
              const dx = xi - qMx[node], dy = yi - qMy[node], d2 = dx * dx + dy * dy;
              const size = qHalf[node] * 2.0;
              if (size * size < theta2 * d2) {
                const rep = (kRep * mi * nm) / (d2 + soft2);
                fix += dx * rep; fiy += dy * rep;
              } else {
                const base4 = node * 4;
                if (sp + 4 >= stack.length) {
                  const ns = new Int32Array(stack.length * 2); ns.set(stack); layout._qStack = stack = ns;
                }
                for (let q = 0; q < 4; q++) {
                  const ch = qChild[base4 + q];
                  if (qMass[ch] > 0) stack[sp++] = ch;
                }
              }
            }
          }
          fx[i] += fix; fy[i] += fiy;
        }
      }

      // Molas das arestas da árvore
      for (let e = 0; e < tU.length; e++) {
        const u = tU[e], v = tV[e];
        const dx = x[v] - x[u], dy = y[v] - y[u];
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
        const rest = tLen[e] * layout.spread;
        const f = (kTree * (d - rest)) / d;
        const afx = dx * f, afy = dy * f;
        fx[u] += afx; fy[u] += afy;
        fx[v] -= afx; fy[v] -= afy;
      }

      // Atração de arestas cruzadas (agrupa irmãos relacionados)
      const cRest = S * 0.75, cRest2 = cRest * cRest;
      for (let e = 0; e < cU.length; e++) {
        const u = cU[e], v = cV[e];
        const dx = x[v] - x[u], dy = y[v] - y[u];
        const d2 = dx * dx + dy * dy;
        if (d2 <= cRest2) continue;
        const d = Math.sqrt(d2);
        const f = (cW[e] * (d - cRest)) / d;
        const afx = dx * f, afy = dy * f;
        fx[u] += afx; fy[u] += afy;
        fx[v] -= afx; fy[v] -= afy;
      }

      // Gravidade central branda + integração + amortecimento
      const maxStep = S * (0.85 * layout.alpha + 0.05), maxStep2 = maxStep * maxStep;
      for (let i = 0; i < K; i++) {
        const gx = fx[i] - kGrav * mass[i] * x[i];
        const gy = fy[i] - kGrav * mass[i] * y[i];
        let sx = gx * layout.alpha * pin[i];
        let sy = gy * layout.alpha * pin[i];
        const sm2 = sx * sx + sy * sy;
        if (sm2 > maxStep2) { const sc = maxStep / Math.sqrt(sm2); sx *= sc; sy *= sc; }
        vx[i] = 0.52 * vx[i] + 0.48 * sx;
        vy[i] = 0.52 * vy[i] + 0.48 * sy;
        x[i] += vx[i];
        y[i] += vy[i];
      }

      if (layout.singleRoot && layout.rootIdx >= 0) {
        const rx = 0.25 * x[layout.rootIdx], ry = 0.25 * y[layout.rootIdx];
        for (let i = 0; i < K; i++) { x[i] -= rx; y[i] -= ry; }
      }

      layout.alpha *= 0.965;
    }

    for (let k = 0; k < K; k++) {
      const c = layout.coords.get(layout.nodes[k]);
      if (c) { c[0] = x[k]; c[1] = y[k]; }
    }
    return layout.alpha > 0.004;
  }

  root.GraphAlgos = {
    buildCSR,
    bfs,
    bfsFast: bfsBounded,
    shortestPath,
    expandSourceDepth,
    buildNetwork,
    createNetLayout,
    syncNetLayout,
    stepNetLayout,
    outDegree,
    inDegree,
    hasEdge,
    forEachNeighbor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
