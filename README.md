# Wikipedia Crawler

### Layout do grafo (Multinível espectral + ForceAtlas2/LinLog com repulsão FFT)
```
python3 layout.py   # 1a vez: Louvain (~7 min, ~6 GB RAM) -> comm_levels.npy
python3 layout.py   # 2a vez: layout livre em 3 estágios -> frontend/nodes.bin
```
Regrava `x/y`, grau e comunidade em `frontend/nodes.bin` (backup em `nodes.orig.bin`)
e gera `frontend/layout_preview.png`. Requer `python-igraph`, `numpy`, `scipy`, `matplotlib`.

### Frontend (visualizador do grafo)
Os `.bin` (gerados por `neo4jData2Bin.py`) podem ficar na raiz ou em `frontend/`.
```
cd frontend
python3 -m http.server 8000
```
Abra http://localhost:8000/ (não abra via `file://`).

- Hover: título, grau e comunidade.
- Clique: seleciona o nó e destaca vizinhos e arestas.
- **Modo Rede** (`🕸️ Rede`): selecione um artigo para ver sua vizinhança de profundidade 1;
  dê **duplo clique** em um nó já expandido para crescer mais um nível, ou em outro nó da
  rede para expandir +1 nível a partir dele mantendo toda a estrutura existente. O subgrafo é
  organizado e dispersado dinamicamente em tempo real por um layout de forças próprio
  (Barnes-Hut + molas), posicionando os nós apenas em relação entre si. Inclui controle de
  espaçamento, botão de reorganização, opacidade adaptativa de arestas e nós de alto contraste.
- Painel "Comunidades": filtra pelas 20 maiores.
- Busca: digite um título (índice rápido para artigos com grau >= 60; "Buscar em todos" varre todos os títulos, com navegação por teclado).
- Vizinhança: com um nó selecionado, ajuste a **profundidade** (1 a 5), o sentido dos links
  (saem / entram / ambos) e o máximo de nós desenhados. As contagens por nível são exatas;
  o desenho mostra os nós de maior grau de cada nível, ligados pela árvore da BFS.
- Menor caminho: botão "Caminho" (ou "Usar como origem/destino" no painel do nó). BFS bidirecional,
  seguindo o sentido dos links ou ignorando-o. Mostra, a cada passo, o sentido real do link.
- Os algoritmos estão em `frontend/graph.js`. Testes: `node frontend/test/graph.test.js`
  (ou `jsc frontend/graph.js frontend/test/graph.test.js`).
- "Máx. nós (top N por grau)" e "Grau Mínimo" (escala não-linear até 500): controlam diretamente
  quais nós são exibidos (padrão 200.000). Espalhamento e gravidade interna operam em 60 FPS na GPU
  via textura `RG32F` de centroides, com culling de frustum nos shaders e espinha dorsal estrutural.
- Memória: o navegador monta um índice de adjacência (~240 MB para 30M arestas) ao carregar.
- Renderização WebGL2 (3,58M nós / 30M arestas); `pyvis`/`Dash` não suportam essa escala.

### Test docker container for MongoDB
```
docker run --name wikipediaCrawler -p 27017:27017 -e MONGO_INITDB_ROOT_USERNAME=crawler -e MONGO_INITDB_ROOT_PASSWORD=testpass -d mongo:latest
```

### Test docker container for Neo4J
```
docker run -d --name wikipediaCrawlerNeo4j -p 7474:7474 -p 7687:7687 -v ./neo4j_data/data:/data -v ./neo4j_data/conf:/conf -e NEO4J_AUTH=neo4j/testpass -e NEO4J_server_memory_heap_initial__size=2G -e NEO4J_server_memory_heap_max__size=4G docker.io/library/neo4j
```
#### Loading dump for Neo4J
```
docker run --interactive --tty --rm \
    --user="$(id -u):$(id -g)" \
    --volume="$(pwd):/backups" \
    --volume="$(pwd)/neo4j_data/data:/data" \
    neo4j \
    neo4j-admin database load neo4j --from-path=/backups/ --overwrite-destination=true
```
