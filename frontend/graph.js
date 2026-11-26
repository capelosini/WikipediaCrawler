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
  // lookup[id - minId] = índice do nó (0..N-1). Arestas com id desconhecido são ignoradas.
  function buildCSR(edges, E, N, lookup, minId) {
    const outOff = new Uint32Array(N + 1), inOff = new Uint32Array(N + 1);
    const L = lookup.length;
    let valid = 0;
    for (let e = 0; e < E; e++) {
      const a = edges[e * 2] - minId, b = edges[e * 2 + 1] - minId;
      if (a >= L || b >= L || a < 0 || b < 0) continue;
      outOff[lookup[a] + 1]++;
      inOff[lookup[b] + 1]++;
      valid++;
    }
    for (let i = 0; i < N; i++) { outOff[i + 1] += outOff[i]; inOff[i + 1] += inOff[i]; }
    const outAdj = new Uint32Array(valid), inAdj = new Uint32Array(valid);
    const oc = outOff.slice(0, N), ic = inOff.slice(0, N);
    for (let e = 0; e < E; e++) {
      const a = edges[e * 2] - minId, b = edges[e * 2 + 1] - minId;
      if (a >= L || b >= L || a < 0 || b < 0) continue;
      const s = lookup[a], t = lookup[b];
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

  // Menor caminho (em número de links) entre s e t por BFS bidirecional.
  // directed = true : segue o sentido dos links (s -> ... -> t).
  // directed = false: ignora o sentido dos links.
  // Retorna { path: number[] | null, visited, length } onde path inclui s e t.
  function shortestPath(g, s, t, directed) {
    if (s === t) return { path: [s], visited: 1, length: 0 };
    const N = g.N;
    const fMode = directed ? 'out' : 'both', bMode = directed ? 'in' : 'both';
    const UNSEEN = -2;
    const parF = new Int32Array(N).fill(UNSEEN), parB = new Int32Array(N).fill(UNSEEN);
    parF[s] = -1; parB[t] = -1;
    let frontF = [s], frontB = [t], visited = 2;

    while (frontF.length && frontB.length) {
      // expande sempre o lado com menos nós na fronteira
      const fwd = frontF.length <= frontB.length;
      const front = fwd ? frontF : frontB;
      const par = fwd ? parF : parB, other = fwd ? parB : parF, mode = fwd ? fMode : bMode;
      const next = [];
      let meet = -1;
      for (let x = 0; x < front.length && meet < 0; x++) {
        const u = front[x];
        const visit = v => {
          if (par[v] !== UNSEEN) return;
          par[v] = u; visited++;
          if (other[v] !== UNSEEN) { if (meet < 0) meet = v; } else next.push(v);
        };
        forEachNeighbor(g, u, mode, visit);
      }
      if (meet >= 0) {
        const path = [];
        for (let v = meet; v !== -1; v = parF[v]) path.push(v);
        path.reverse();
        for (let v = parB[meet]; v !== -1; v = parB[v]) path.push(v);
        return { path, visited, length: path.length - 1 };
      }
      if (fwd) frontF = next; else frontB = next;
    }
    return { path: null, visited, length: -1 };
  }

  root.GraphAlgos = { buildCSR, bfs, shortestPath, outDegree, inDegree, hasEdge, forEachNeighbor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
