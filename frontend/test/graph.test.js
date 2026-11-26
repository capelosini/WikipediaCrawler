// Testes de graph.js (CSR, BFS por profundidade, menor caminho bidirecional),
// comparados com uma BFS ingênua em grafos aleatórios. Rodar da raiz do projeto com o
// jsc que já vem no macOS (alias: jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc):
//   jsc frontend/graph.js frontend/test/graph.test.js
const { buildCSR, bfs, shortestPath } = GraphAlgos;
const out = typeof print === 'function' ? print : console.log;
let failures = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failures++; out('FALHOU: ' + msg); } };

// PRNG determinístico
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// Referência ingênua: BFS sobre listas de adjacência de arrays comuns
function refDist(N, edges, src, mode) {
  const adj = Array.from({ length: N }, () => []);
  for (const [a, b] of edges) {
    if (mode !== 'in') adj[a].push(b);
    if (mode !== 'out') adj[b].push(a);
  }
  const d = new Array(N).fill(-1);
  d[src] = 0;
  const q = [src];
  for (let h = 0; h < q.length; h++) for (const v of adj[q[h]]) if (d[v] < 0) { d[v] = d[q[h]] + 1; q.push(v); }
  return d;
}

function makeGraph(N, E, idOffset) {
  const edges = [];
  for (let e = 0; e < E; e++) edges.push([(rnd() * N) | 0, (rnd() * N) | 0]);
  // ids "do Neo4j": deslocados por idOffset; lookup mapeia id -> índice
  const lookup = new Uint32Array(N);
  for (let i = 0; i < N; i++) lookup[i] = i;
  const flat = new Uint32Array(E * 2);
  edges.forEach(([a, b], k) => { flat[k * 2] = a + idOffset; flat[k * 2 + 1] = b + idOffset; });
  return { edges, g: buildCSR(flat, E, N, lookup, idOffset) };
}

for (let trial = 0; trial < 200; trial++) {
  const N = 2 + ((rnd() * 40) | 0), E = (rnd() * N * 2.5) | 0;
  const { edges, g } = makeGraph(N, E, 1000);
  check(g.E === E, 'CSR deve conter todas as arestas');

  for (const mode of ['out', 'in', 'both']) {
    const src = (rnd() * N) | 0, depth = 1 + ((rnd() * 4) | 0);
    const ref = refDist(N, edges, src, mode);
    const r = bfs(g, src, depth, mode);
    let ok = true, reached = 0;
    for (let i = 0; i < N; i++) {
      const want = ref[i] >= 0 && ref[i] <= depth ? ref[i] : -1;
      if (r.dist[i] !== want) ok = false;
      if (want >= 0) reached++;
    }
    check(ok, `bfs dist (${mode}, depth ${depth}, trial ${trial})`);
    check(r.order.length === reached, 'bfs order deve ter todos os alcançados');
    // faixas por nível consistentes
    let levelsOk = r.levelStart[r.levelStart.length - 1] === r.order.length;
    for (let d = 0; d + 1 < r.levelStart.length; d++)
      for (let k = r.levelStart[d]; k < r.levelStart[d + 1]; k++) if (r.dist[r.order[k]] !== d) levelsOk = false;
    check(levelsOk, 'levelStart deve delimitar cada nível');
    // pai está no nível anterior
    let parOk = true;
    for (const v of r.order) if (v !== src && r.dist[r.parent[v]] !== r.dist[v] - 1) parOk = false;
    check(parOk, 'pai deve estar um nível acima');
  }

  for (const directed of [true, false]) {
    const s = (rnd() * N) | 0, t = (rnd() * N) | 0;
    const ref = refDist(N, edges, s, directed ? 'out' : 'both')[t];
    const r = shortestPath(g, s, t, directed);
    check(r.length === ref, `shortestPath comprimento (dirigido=${directed}) quer ${ref} obteve ${r.length}`);
    if (ref >= 0) {
      const p = r.path;
      let valid = p[0] === s && p[p.length - 1] === t && p.length === ref + 1;
      for (let k = 0; valid && k + 1 < p.length; k++) {
        const a = p[k], b = p[k + 1];
        const has = edges.some(([x, y]) => (x === a && y === b) || (!directed && x === b && y === a));
        if (!has) valid = false;
      }
      check(valid, 'shortestPath deve devolver um caminho válido');
    } else check(r.path === null, 'sem caminho => path null');
  }
}

// Arestas com id desconhecido são ignoradas
{
  const lookup = new Uint32Array([0, 1, 2]);
  const g = buildCSR(new Uint32Array([10, 11, 11, 99, 5, 10]), 3, 3, lookup, 10);
  check(g.E === 1, 'arestas com ids fora do lookup devem ser ignoradas');
}

out(failures ? `${failures} FALHA(S) em ${checks} verificações` : `OK: ${checks} verificações`);
if (failures && typeof quit === 'function') quit(1);
