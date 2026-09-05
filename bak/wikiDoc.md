# Documentação de Parâmetros: MediaWiki API (`action=query`)

O endpoint `action=query` é o principal módulo de leitura da API da Wikipédia (MediaWiki). Ele permite buscar metadados, conteúdos, histórico e listas de páginas em lote.

---

## 1. Parâmetros Principais de Alvo (Targeting)

Estes parâmetros especificam quais páginas serão consultadas na requisição. É necessário fornecer pelo menos um alvo (ou usar um `generator`).

| Parâmetro | Tipo | Descrição | Exemplo |
| :--- | :--- | :--- | :--- |
| `titles` | Lista (`\|`) | Títulos das páginas desejadas (máx. 50 por chamada). | `titles=Brasil\|Guerra\|Filosofia` |
| `pageids` | Lista (`\|`) | Identificadores numéricos únicos das páginas. | `pageids=15286\|5353` |
| `revids` | Lista (`\|`) | Identificadores específicos de revisões do histórico. | `revids=123456\|654321` |

---

## 2. Seleção de Módulos de Dados

Definem o tipo de informação que será extraída para o grupo de páginas selecionado.

| Parâmetro | Tipo | Descrição | Módulos Principais |
| :--- | :--- | :--- | :--- |
| `prop` | Lista (`\|`) | Obtém propriedades e dados de páginas específicas. | `info`, `revisions`, `categories`, `extracts`, `pageviews`, `links`, `images` |
| `list` | String | Obtém catálogos/listas globais de páginas segundo critérios. | `allpages`, `search`, `categorymembers`, `recentchanges` |
| `meta` | Lista (`\|`) | Obtém metadados do próprio site ou do usuário ativo. | `siteinfo`, `userinfo`, `tokens` |
| `generator` | String | Usa uma listagem como entrada automática para as `prop`. | `allpages`, `search`, `categorymembers` |

---

## 3. Modificadores Globais da Consulta

| Parâmetro | Tipo | Padrão | Descrição |
| :--- | :--- | :--- | :--- |
| `redirects` | Booleano (`1`/`0`) | `0` | Segue automaticamente redirecionamentos de páginas até o destino final. |
| `converttitles` | Booleano (`1`/`0`) | `0` | Converte títulos para a variante de idioma padrão se aplicável. |
| `indexpageids` | Booleano (`1`/`0`) | `0` | Inclui um array ordenado de IDs no JSON para facilitar iterações. |
| `export` | Booleano (`1`/`0`) | `0` | Exporta a estrutura XML de importação/exportação do MediaWiki. |
| `iwurl` | Booleano (`1`/`0`) | `0` | Retorna a URL completa se o título for um atalho interwiki. |

---

## 4. Sub-parâmetros de Módulos `prop` Frequentes

Cada propriedade ativada no parâmetro `prop` aceita seus próprios sub-parâmetros de configuração.

### 4.1 `prop=info`
* **`inprop`**: Atributos adicionais da página.
  * *Valores comuns:* `url` (inclui `fullurl`), `protection`, `readable`, `displaytitle`.
  * *Exemplo:* `inprop=url|protection`

### 4.2 `prop=revisions`
* **`rvprop`**: Atributos da revisão a retornar.
  * *Valores comuns:* `content` (texto bruto), `timestamp`, `user`, `ids`, `size`, `comment`.
* **`rvslots`**: Slot de conteúdo a consultar (obrigatório para `rvprop=content`).
  * *Valor:* `main`
* **`rvlimit`**: Número de revisões por página (Padrão: `1`, Máx: `500`).
* **`rvdir`**: Direção cronológica (`older` para mais recente primeiro, `newer` para oposto).

### 4.3 `prop=extracts`
* **`exintro`**: Se igual a `1`, traz apenas o texto do cabeçalho/introdução.
* **`explaintext`**: Se igual a `1`, remove tags HTML e entrega texto limpo.
* **`exsentences`**: Limita o retorno por quantidade de frases (`1` a `10`).
* **`exchars`**: Limita o retorno por número de caracteres.
* **`exlimit`**: Limite de extratos por requisição (máx: `20`).

### 4.4 `prop=categories`
* **`clprop`**: Metadados das categorias atreladas (`sortkey`, `timestamp`, `hidden`).
* **`cllimit`**: Limite de categorias retornadas por artigo (máx: `500`).
* **`clcategories`**: Filtra apenas categorias específicas passadas por parâmetro.

### 4.5 `prop=pageviews`
* **`pvipdays`**: Número de dias retroativos para histórico de acessos (entre `1` e `60`).

---

## 5. Sub-parâmetros de Módulos `list` Frequentes

### 5.1 `list=allpages`
* **`apfrom`**: Título alfabético inicial.
* **`apto`**: Título alfabético final.
* **`apprefix`**: Filtra páginas que começam com o texto especificado.
* **`apnamespace`**: Domínio de busca (`0` = apenas artigos).
* **`apfilterredir`**: Filtra redirecionamentos (`all`, `redirects`, `nonredirects`).
* **`aplimit`**: Número de resultados por lote (máx: `500`).
* **`apcontinue`**: Token de controle para paginação contínua.

### 5.2 `list=search`
* **`srsearch`**: Termos da pesquisa textual.
* **`srnamespace`**: Filtro de domínios para a busca.
* **`srlimit`**: Limite de resultados de busca (máx: `500`).
* **`sroffset`**: Posição inicial para paginação na busca.

---

## 6. Regras para o uso de Geradores (`generator`)

Ao transformar uma `list` em `generator`, os sub-parâmetros do módulo recebem o prefixo **`g`**:

* `list=allpages` com `apfrom=Brasil` $\rightarrow$ `generator=allpages` com **`gapfrom=Brasil`**
* `aplimit=50` $\rightarrow$ **`gaplimit=50`**
* `apcontinue=...` $\rightarrow$ **`gapcontinue=...`**

---

## 7. Formato e Paginação

| Parâmetro | Valores Permatidos | Descrição |
| :--- | :--- | :--- |
| `format` | `json`, `xml`, `php` | Define a serialização do arquivo final. |
| `formatversion` | `1`, `2` | A versão `2` formata a resposta com listas JSON padrão em vez de objetos mapeados por ID. |
| `continue` | `-||` ou Token | Gerencia a paginação global das requisições. |

---

## Exemplo de Requisição Completa em cURL

```bash
curl -A "MeuBot/1.0 (contato@exemplo.com)" -X GET \
  "[https://pt.wikipedia.org/w/api.php](https://pt.wikipedia.org/w/api.php)?\
action=query\
&generator=allpages\
&gapnamespace=0\
&gaplimit=5\
&gapfilterredir=nonredirects\
&prop=info|categories|extracts\
&inprop=url\
&explaintext=1\
&exintro=1\
&redirects=1\
&format=json\
&formatversion=2"

