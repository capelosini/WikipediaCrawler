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


  root.GraphAlgos = {
    buildCSR,
    bfs,
    bfsFast: bfsBounded,
    shortestPath,
    outDegree,
    inDegree,
    hasEdge,
    forEachNeighbor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
