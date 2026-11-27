// Testes de graph.js (CSR, BFS por profundidade, menor caminho bidirecional, Modo Rede),
// comparados com uma BFS ingênua em grafos aleatórios. Rodar da raiz do projeto com Node ou jsc:
//   node frontend/test/graph.test.js
//   jsc frontend/graph.js frontend/test/graph.test.js
if (typeof GraphAlgos === 'undefined' && typeof require === 'function') {
  require('../graph.js');
}
const { buildCSR, bfs, bfsFast, shortestPath, expandSourceDepth, buildNetwork, createNetLayout, syncNetLayout, stepNetLayout } = GraphAlgos;
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

// Arestas com id desconhecido ou lacunas (< 0 no lookup) são ignoradas; suporte a lookup por função
{
  const lookup = new Int32Array([0, -1, 1, 2]);
  const g = buildCSR(new Uint32Array([10, 12, 10, 11, 11, 13, 12, 99, 5, 10]), 5, 3, lookup, 10);
  check(g.E === 1 && g.outAdj[0] === 1 && g.outOff[1] === 1, 'arestas com lacunas -1 ou ids fora do lookup devem ser ignoradas');

  const map = new Map([[100, 0], [500000000, 1], [900000000, 2]]);
  const fnLookup = id => { const v = map.get(id); return v === undefined ? -1 : v; };
  const gFn = buildCSR(new Uint32Array([100, 500000000, 500000000, 900000000, 100, 42]), 3, 3, fnLookup, 0);
  check(gFn.E === 2 && shortestPath(gFn, 0, 2, true).length === 2, 'buildCSR com função de lookup esparsa e shortestPath zero-alloc');
}

// Equivalência bfsFast vs bfs e reuso de carimbo em shortestPath
{
  const { edges, g } = makeGraph(30, 80, 50);
  for (const mode of ['out', 'in', 'both']) {
    const r0 = bfs(g, 0, 3, mode);
    const r1 = bfsFast(g, 0, 3, mode);
    check(r0.order.length === r1.order.length, `bfsFast deve alcançar mesma contagem (${mode})`);
    let same = true;
    for (const v of r1.order) if (r1.dist[v] !== r0.dist[v]) same = false;
    check(same, `bfsFast deve manter distâncias exatas (${mode})`);
  }
  // Múltiplas chamadas seguidas a shortestPath garantem reuso limpo de carimbo
  for (let k = 0; k < 5; k++) {
    const s = (k * 3) % 30, t = (k * 7 + 5) % 30;
    const ref = refDist(30, edges, s, 'out')[t];
    const r = shortestPath(g, s, t, true);
    check(r.length === ref, `shortestPath repetido (${s}->${t}) quer ${ref} obteve ${r.length}`);
  }
}

// NetLayout: dispersão por forças, agrupamento de irmãos, expansão incremental e Barnes-Hut
{
  // 1. Estrela (1 centro + 24 folhas): dispersão sem sobreposição e centro próximo de (0,0)
  const starEdges = [];
  for (let i = 1; i <= 24; i++) starEdges.push([0, i]);
  const starLk = new Int32Array(25);
  for (let i = 0; i < 25; i++) starLk[i] = i;
  const gStar = buildCSR(new Uint32Array(starEdges.flat()), starEdges.length, 25, starLk, 0);
  const net1 = buildNetwork(gStar, [[0, 1]], 'both');
  const lay1 = createNetLayout();
  syncNetLayout(lay1, net1, { sources: [0] });
  stepNetLayout(lay1, 80);

  let finite1 = true, minPair = 1e9;
  for (let i = 0; i < lay1.nodes.length; i++) {
    if (!Number.isFinite(lay1.x[i]) || !Number.isFinite(lay1.y[i])) finite1 = false;
    for (let j = i + 1; j < lay1.nodes.length; j++) {
      const d = Math.hypot(lay1.x[i] - lay1.x[j], lay1.y[i] - lay1.y[j]);
      if (d < minPair) minPair = d;
    }
  }
  const rIdx = lay1.idxOf.get(0);
  const rootDist = Math.hypot(lay1.x[rIdx], lay1.y[rIdx]);
  check(finite1 && rootDist < 0.05 && minPair > 0.015,
    `estrela dispersa sem sobreposicao (rootDist=${rootDist.toFixed(4)}, minPair=${minPair.toFixed(4)})`);

  // 2. Agrupamento tópico: {1,2,3} ligados entre si devem ficar mais perto entre si do que de {4,5,6}
  const clusEdges = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 2], [2, 3], [1, 3]];
  const clusLk = new Int32Array([0, 1, 2, 3, 4, 5, 6]);
  const gClus = buildCSR(new Uint32Array(clusEdges.flat()), clusEdges.length, 7, clusLk, 0);
  const netClus = buildNetwork(gClus, [[0, 1]], 'both', { includeCrossEdges: true });
  const layClus = createNetLayout();
  syncNetLayout(layClus, netClus, { sources: [0] });
  stepNetLayout(layClus, 120);
  const distBetween = (a, b) => {
    const ia = layClus.idxOf.get(a), ib = layClus.idxOf.get(b);
    return Math.hypot(layClus.x[ia] - layClus.x[ib], layClus.y[ia] - layClus.y[ib]);
  };
  const intra = (distBetween(1, 2) + distBetween(2, 3) + distBetween(1, 3)) / 3;
  let interSum = 0, interCnt = 0;
  for (const a of [1, 2, 3]) for (const b of [4, 5, 6]) { interSum += distBetween(a, b); interCnt++; }
  const inter = interSum / interCnt;
  check(intra < inter, `irmaos ligados devem agrupar (intra=${intra.toFixed(4)} < inter=${inter.toFixed(4)})`);

  // 3. Expansão incremental preserva coordenadas existentes e projeta novos filhos para fora
  const expEdges = [[0, 1], [0, 2], [0, 3], [0, 4], [4, 7], [4, 8], [4, 9]];
  const expLk = new Int32Array(10);
  for (let i = 0; i < 10; i++) expLk[i] = i;
  const gExp = buildCSR(new Uint32Array(expEdges.flat()), expEdges.length, 10, expLk, 0);
  const netA = buildNetwork(gExp, [[0, 1]], 'both');
  const layExp = createNetLayout();
  syncNetLayout(layExp, netA, { sources: [0] });
  stepNetLayout(layExp, 60);
  const snap = new Map();
  for (const id of netA.nodes) {
    const k = layExp.idxOf.get(id);
    snap.set(id, [layExp.x[k], layExp.y[k]]);
  }
  const netB = buildNetwork(gExp, [[0, 1], [4, 1]], 'both');
  syncNetLayout(layExp, netB, { sources: [0, 4] });
  let preserved = true;
  for (const [id, [ox, oy]] of snap.entries()) {
    const k = layExp.idxOf.get(id);
    if (Math.abs(layExp.x[k] - ox) > 1e-6 || Math.abs(layExp.y[k] - oy) > 1e-6) preserved = false;
  }
  const k0 = layExp.idxOf.get(0), k4 = layExp.idxOf.get(4);
  const d4 = Math.hypot(layExp.x[k4] - layExp.x[k0], layExp.y[k4] - layExp.y[k0]);
  let outwardOk = true;
  for (const child of [7, 8, 9]) {
    const kc = layExp.idxOf.get(child);
    const dc = Math.hypot(layExp.x[kc] - layExp.x[k0], layExp.y[kc] - layExp.y[k0]);
    if (!(dc > d4 * 0.9)) outwardOk = false;
  }
  stepNetLayout(layExp, 50);
  let expFinite = true;
  for (let i = 0; i < layExp.nodes.length; i++) if (!Number.isFinite(layExp.x[i]) || !Number.isFinite(layExp.y[i])) expFinite = false;
  check(preserved && outwardOk && expFinite, 'expansao incremental preserva nos anteriores e projeta filhos para fora');

  // 4. Rede grande (K=650) exercitando caminho Barnes-Hut Quadtree
  const bigEdges = [];
  for (let i = 1; i < 650; i++) bigEdges.push([i < 25 ? 0 : (i % 24) + 1, i]);
  const bigLk = new Int32Array(650);
  for (let i = 0; i < 650; i++) bigLk[i] = i;
  const gBig = buildCSR(new Uint32Array(bigEdges.flat()), bigEdges.length, 650, bigLk, 0);
  const netBig = buildNetwork(gBig, [[0, 2]], 'both');
  const layBig = createNetLayout();
  syncNetLayout(layBig, netBig, { sources: [0] });
  const a0 = layBig.alpha;
  stepNetLayout(layBig, 30);
  let bigOk = layBig.nodes.length === 650 && layBig.alpha < a0;
  for (let i = 0; i < layBig.nodes.length; i++) {
    if (!Number.isFinite(layBig.x[i]) || !Number.isFinite(layBig.y[i]) || Math.abs(layBig.x[i]) > 20 || Math.abs(layBig.y[i]) > 20) bigOk = false;
  }
  check(bigOk, 'Barnes-Hut K=650 converge com coordenadas finitas e limitadas');
}

// Modo Rede: buildNetwork e expandSourceDepth
{
  // Grafo em cadeia com ramo: 0 -> 1 -> 2 -> 3, 2 -> 4 -> 5, e ponte 1 <-> 4
  const edges = [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5], [1, 4]];
  const lookup = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const flat = new Uint32Array(edges.flat());
  const g = buildCSR(flat, edges.length, 6, lookup, 0);

  // 1. Selecionar nó 0 com profundidade 1: {0, 1}
  const n1 = buildNetwork(g, [[0, 1]], 'both');
  const s1 = new Set(n1.nodes);
  check(s1.size === 2 && s1.has(0) && s1.has(1), 'Modo Rede prof 1 a partir de 0 deve ter {0,1}');
  check(n1.treePairs.length === 1, 'Modo Rede prof 1 deve ter 1 aresta de árvore');

  // 2. Duplo clique no mesmo nó (0 -> prof 2): {0, 1, 2, 4} mantendo {0, 1}
  const exp0 = expandSourceDepth(g, s1, 0, 1, 'both');
  check(exp0.depth === 2 && exp0.added === 2, 'expandSourceDepth em 0 deve ir para prof 2 e revelar 2 nós');
  const n2 = buildNetwork(g, [[0, exp0.depth]], 'both');
  const s2 = new Set(n2.nodes);
  check(s2.size === 4 && s2.has(0) && s2.has(1) && s2.has(2) && s2.has(4), 'Modo Rede prof 2 de 0 deve ter {0,1,2,4}');
  check(n2.crossPairs.length >= 1, 'deve detectar aresta cruzada (2-4 ou 1-4) dentro da rede');

  // 3. Duplo clique em outro nó (2 -> prof 1) mantém {0,1,2,4} e adiciona {3}
  const exp2 = expandSourceDepth(g, s2, 2, 0, 'both');
  check(exp2.depth === 1 && exp2.added === 1, 'expandSourceDepth em 2 deve ir para prof 1 e adicionar nó 3');
  const n3 = buildNetwork(g, [[0, 2], [2, exp2.depth]], 'both');
  const s3 = new Set(n3.nodes);
  check(s3.size === 5 && s3.has(0) && s3.has(1) && s3.has(2) && s3.has(3) && s3.has(4), 'estrutura anterior preservada + nó 3');

  // 4. Nó interior cujos vizinhos prof 1 já estão todos na rede avança para prof 2 se houver nós novos
  // Em s3, vizinhos de 4 são {1, 2, 5}: 5 ainda não está, então vai para prof 1.
  // Testemos nó 1 cuja vizinhança prof 1 é {0, 2, 4} (todos já em s3) e prof 2 inclui {3, 5}:
  const exp1 = expandSourceDepth(g, s3, 1, 0, 'both');
  check(exp1.depth === 2 && exp1.added >= 1, 'nó interior com prof 1 já coberta deve avançar para prof 2 para revelar novos nós');

  // 5. Componente exaurido retorna added: 0
  const nAll = buildNetwork(g, [[0, 4]], 'both');
  const sAll = new Set(nAll.nodes);
  check(sAll.size === 6, 'rede completa deve conter todos os 6 nós');
  const expExhausted = expandSourceDepth(g, sAll, 1, 1, 'both');
  check(expExhausted.depth === 1 && expExhausted.added === 0, 'componente totalmente coberto deve retornar added=0');

  // 6. Direção 'out' e 'in' respeitadas
  const nOut = buildNetwork(g, [[2, 1]], 'out');
  const sOut = new Set(nOut.nodes);
  check(sOut.size === 3 && sOut.has(2) && sOut.has(3) && sOut.has(4) && !sOut.has(1), 'mode=out de 2 só segue 2->3 e 2->4');
  const nIn = buildNetwork(g, [[2, 1]], 'in');
  const sIn = new Set(nIn.nodes);
  check(sIn.size === 2 && sIn.has(2) && sIn.has(1), 'mode=in de 2 só segue 1->2');

  // 7. Limite maxPerLevel com prioridade por grau
  const deg = new Float32Array([1, 10, 5, 2, 20, 1]);
  const nCap = buildNetwork(g, [[0, 2]], 'out', { maxPerLevel: 1, deg });
  const sCap = new Set(nCap.nodes);
  check(nCap.truncated === true && sCap.has(0) && sCap.has(1) && sCap.has(4) && !sCap.has(2), 'maxPerLevel=1 deve priorizar nó de maior grau (4 sobre 2)');
}

out(failures ? `${failures} FALHA(S) em ${checks} verificações` : `OK: ${checks} verificações`);
if (failures && typeof quit === 'function') quit(1);
