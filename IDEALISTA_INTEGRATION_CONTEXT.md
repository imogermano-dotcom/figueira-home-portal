# IDEALISTA_INTEGRATION_CONTEXT
## Contexto para implementação da secção "Mercado Idealista" no portal

> **Para o Claude Code:** Lê este ficheiro antes de tocar no código.

---

## ARQUITECTURA DO PORTAL

O portal é **HTML/CSS/JS vanilla** num único ficheiro: `portal/index.html` (~7700 linhas).  
**NÃO é React, NÃO é Next.js, NÃO há bundler.**

### Supabase
```js
// Já existe no topo do script (linha ~1620):
var DOORSTEP_URL = 'https://fykbogojkcqokvopnmkz.supabase.co'
var DOORSTEP_ANON = '...'
var sb = supabase.createClient(DOORSTEP_URL, DOORSTEP_ANON)
// "Doorstep" é o nome interno do projecto — é o Supabase DO PORTAL.
// As tabelas idealista_* estão NESTE MESMO projecto.
// Usar `sb` directamente. NÃO criar novo cliente Supabase.
```

### Autenticação e perfil
```js
var _profile = null        // { nome, email, role, is_admin, ego_responsavel }
var _currentUserId = null

// Verificar admin:
var isAdmin = _profile && (_profile.role === 'admin' || _profile.is_admin)
```

### Padrão de tabs
```js
// Array de tabs em showTab() (linha ~1708) — adicionar 'mercado':
function showTab(name) {
  ['search','kpi','conteudos','agendamento','biblioteca','old-leads','config','mercado'].forEach(...)
  // ...
  if (name === 'mercado') mercadoInit()
}
```

### Convenções de código
- Declarações com `var` (não `const`/`let` — manter consistência)
- Render via `innerHTML`
- Funções async com `await`
- Utilitário `esc(str)` já existe para escapar HTML

---

## O QUE ADICIONAR AO index.html

### 1. Botão de navegação (em #portal-nav, após #tab-old-leads)
```html
<button class="pnav-btn" id="tab-mercado" onclick="showTab('mercado')">🏠 Mercado</button>
```

### 2. Página (após #page-old-leads)
```html
<div class="portal-page" id="page-mercado">
  <main style="flex:1;padding:24px;max-width:1200px;margin:0 auto;width:100%">
    <!-- sub-tabs internos: Dashboard | Imóveis | Agências | Duplicados (admin) -->
    <div id="mercado-nav" style="display:flex;gap:8px;margin-bottom:20px;border-bottom:2px solid #e0e6f0;padding-bottom:0">
      <button class="pnav-btn active" id="mtab-dashboard" onclick="mercadoShowTab('dashboard')">📊 Dashboard</button>
      <button class="pnav-btn" id="mtab-imoveis" onclick="mercadoShowTab('imoveis')">🏘️ Imóveis</button>
      <button class="pnav-btn" id="mtab-agencias" onclick="mercadoShowTab('agencias')">🏢 Agências</button>
      <!-- só admin: -->
      <button class="pnav-btn" id="mtab-duplicados" style="display:none" onclick="mercadoShowTab('duplicados')">⚠️ Duplicados</button>
    </div>
    <div id="mercado-dashboard"></div>
    <div id="mercado-imoveis" style="display:none"></div>
    <div id="mercado-agencias" style="display:none"></div>
    <div id="mercado-duplicados" style="display:none"></div>
  </main>
</div>
```

---

## DADOS — ESTRUTURA DA BASE DE DADOS

Todas as tabelas têm RLS `FOR SELECT TO authenticated USING (true)`.  
Usar sempre `await sb.from('idealista_...')`.

### Tabela principal: `idealista_imoveis`
Campos chave:
```
property_code       -- PK (string, ex: "34918266")
url                 -- URL do Idealista
titulo              -- título do anúncio
operacao            -- 'sale' | 'rent'
property_type       -- 'flat' | 'house' | 'land' | 'garage' | 'commercial'
preco_atual         -- preço actual (number)
preco_inicial       -- preço na primeira ingestão
preco_m2_atual      -- €/m²
area_m2
quartos
wcs
piso
tem_elevador        -- boolean
tem_parking         -- boolean
agencia_nome_atual
agente_telefone_atual
morada
municipio
ativo               -- boolean (true = no mercado)
primeiro_visto_em   -- timestamp
retirado_em         -- timestamp | null
num_alteracoes_preco
thumbnail_url       -- expira! não fazer cache
```

### `idealista_agencias`
```
agencia_nome, agencia_url,
imoveis_ativos_total, imoveis_ativos_venda, imoveis_ativos_arrend,
preco_medio_venda, preco_medio_m2_venda, preco_medio_arrend,
area_media_m2, tempo_medio_mercado_dias, taxa_reducao_preco_pct,
imoveis_historico_total, primeira_angariacao_em
```

### `idealista_imovel_agencias`
```
property_code, agencia_nome, agencia_url, agente_nome, agente_telefone,
preco, preco_m2, primeiro_visto_em, ultimo_visto_em, ativa
```

### `idealista_historico_preco`
```
property_code, preco_anterior, preco_novo, variacao_eur, variacao_pct,
direcao, agencia_nome, registado_em
```

### `idealista_historico_caracteristicas`
```
property_code, campo, valor_anterior, valor_novo, registado_em
```

### `idealista_duplicados`
```
id, score_total, fotos_comuns, hamming_dist_foto, motivos,
imovel_id_a, imovel_id_b,
confirmado (null=pendente, true=confirmado, false=rejeitado),
confirmado_por, confirmado_em
```

### `idealista_sync_log`
```
status, iniciado_em, total_scraped, novos, preco_alterado, retirados, custo_usd
```

---

## QUERIES PRONTAS

### Dashboard — KPIs
```js
async function mercadoLoadDashboard() {
  var [vendaRes, arrendRes, agenciasRes, syncRes] = await Promise.all([
    sb.from('idealista_imoveis').select('preco_atual,preco_m2_atual,area_m2,quartos').eq('operacao','sale').eq('ativo',true),
    sb.from('idealista_imoveis').select('preco_atual').eq('operacao','rent').eq('ativo',true),
    sb.from('idealista_agencias').select('agencia_nome,imoveis_ativos_total,preco_medio_venda,preco_medio_m2_venda').order('imoveis_ativos_total',{ascending:false}).limit(10),
    sb.from('idealista_sync_log').select('status,iniciado_em,total_scraped,novos,preco_alterado,retirados,custo_usd').order('iniciado_em',{ascending:false}).limit(1).single()
  ])
  // calcular preço médio dos dados de venda
  var venda = vendaRes.data || []
  var precoMedio = venda.length ? Math.round(venda.reduce(function(s,r){return s+(r.preco_atual||0)},0)/venda.length) : 0
  var m2Medio = venda.length ? Math.round(venda.reduce(function(s,r){return s+(r.preco_m2_atual||0)},0)/venda.length) : 0
  // ... render
}
```

### Listagem de imóveis (com filtros e paginação)
```js
async function mercadoLoadImoveis(filtros) {
  filtros = filtros || {}
  var operacao = filtros.operacao || null
  var tipo = filtros.tipo || null
  var precoMax = filtros.precoMax || null
  var pagina = filtros.pagina || 1
  var porPagina = 20

  var query = sb.from('idealista_imoveis')
    .select('property_code,url,titulo,operacao,property_type,preco_atual,preco_m2_atual,area_m2,quartos,wcs,piso,agencia_nome_atual,agente_telefone_atual,morada,municipio,ativo,primeiro_visto_em,retirado_em,preco_inicial,num_alteracoes_preco,thumbnail_url,tem_elevador,tem_parking', {count:'exact'})
    .eq('ativo', true)
    .order('primeiro_visto_em', {ascending:false})
    .range((pagina-1)*porPagina, pagina*porPagina-1)

  if (operacao) query = query.eq('operacao', operacao)
  if (tipo) query = query.eq('property_type', tipo)
  if (precoMax) query = query.lte('preco_atual', precoMax)

  return await query
}
```

### Ficha de imóvel
```js
async function mercadoLoadFicha(propertyCode) {
  var [imovel, agencias, historicoPreco, historicoCaract] = await Promise.all([
    sb.from('idealista_imoveis').select('*').eq('property_code', propertyCode).single(),
    sb.from('idealista_imovel_agencias').select('agencia_nome,agente_nome,agente_telefone,preco,preco_m2,primeiro_visto_em,ultimo_visto_em,ativa').eq('property_code', propertyCode).order('primeiro_visto_em',{ascending:true}),
    sb.from('idealista_historico_preco').select('preco_anterior,preco_novo,variacao_eur,variacao_pct,direcao,registado_em').eq('property_code', propertyCode).order('registado_em',{ascending:true}),
    sb.from('idealista_historico_caracteristicas').select('campo,valor_anterior,valor_novo,registado_em').eq('property_code', propertyCode).order('registado_em',{ascending:true})
  ])
  return { imovel: imovel.data, agencias: agencias.data, historicoPreco: historicoPreco.data, historicoCaract: historicoCaract.data }
}
```

### Agências
```js
async function mercadoLoadAgencias() {
  return await sb.from('idealista_agencias')
    .select('agencia_nome,agencia_url,imoveis_ativos_total,imoveis_ativos_venda,imoveis_ativos_arrend,preco_medio_venda,preco_medio_m2_venda,preco_medio_arrend,area_media_m2,tempo_medio_mercado_dias,taxa_reducao_preco_pct,imoveis_historico_total')
    .order('imoveis_ativos_total',{ascending:false})
}
```

### Duplicados (só admin)
```js
async function mercadoLoadDuplicados() {
  return await sb.from('idealista_duplicados')
    .select('id,score_total,fotos_comuns,hamming_dist_foto,motivos,imovel_id_a,imovel_id_b,confirmado')
    .is('confirmado', null)
    .order('score_total',{ascending:false})
}

async function mercadoValidarDuplicado(id, confirmado) {
  return await sb.from('idealista_duplicados')
    .update({confirmado: confirmado, confirmado_por: _profile.email, confirmado_em: new Date().toISOString()})
    .eq('id', id)
}
```

---

## CAMPOS CALCULADOS NO FRONTEND

```js
function mercadoDiasNoMercado(imovel) {
  var inicio = new Date(imovel.primeiro_visto_em)
  var fim = imovel.retirado_em ? new Date(imovel.retirado_em) : new Date()
  return Math.floor((fim - inicio) / (1000 * 60 * 60 * 24))
}

function mercadoVariacaoPreco(imovel) {
  if (!imovel.preco_inicial || !imovel.preco_atual) return null
  var diff = imovel.preco_atual - imovel.preco_inicial
  var pct = (diff / imovel.preco_inicial * 100).toFixed(1)
  return { eur: diff, pct: pct, direcao: diff < 0 ? 'descida' : diff > 0 ? 'subida' : 'igual' }
}

function mercadoTipologia(imovel) {
  if (!imovel.quartos) return mercadoTipoLabel[imovel.property_type] || imovel.property_type
  return 'T' + imovel.quartos
}

var mercadoTipoLabel = {
  flat: 'Apartamento', house: 'Moradia', land: 'Terreno',
  garage: 'Garagem', commercial: 'Comercial'
}

function mercadoFmtEur(n) {
  if (!n) return '—'
  return '€' + Math.round(n).toLocaleString('pt-PT')
}
```

---

## NAVEGAÇÃO INTERNA

O tab "Duplicados" só aparece para admins — mostrar após login:
```js
// Dentro de mercadoInit() ou após carregar _profile:
if (_profile && (_profile.role === 'admin' || _profile.is_admin)) {
  document.getElementById('mtab-duplicados').style.display = ''
}
```

---

## NOTA SOBRE THUMBNAILS

As URLs das fotos do Idealista **expiram**. Mostrar quando disponível, ter fallback:
```html
<img src="${esc(imovel.thumbnail_url||'')}" 
     onerror="this.src='';this.style.background='#e0e6f0'" 
     style="width:100%;height:160px;object-fit:cover;border-radius:8px">
```

---

## MÉTRICAS ACTUAIS (primeira ingestão — Junho 2026)
- 31 imóveis à venda · preço médio ~€380k · ~€2.409/m²
- 4 imóveis em arrendamento
- 27 agências · 1 duplicado pendente de validação

---

## PROMPT PARA O CLAUDE CODE

```
Lê o ficheiro IDEALISTA_INTEGRATION_CONTEXT.md e implementa a secção
"Mercado Idealista" no portal (ficheiro portal/index.html).

IMPORTANTE — arquitectura:
- O portal é HTML/CSS/JS vanilla num único ficheiro. NÃO é React.
- O Supabase está na variável global `sb` (já inicializada). NÃO criar novo cliente.
- Usar var (não const/let), innerHTML para render, funções async com await.
- O utilitário esc() já existe para escapar HTML.

Implementa por esta ordem:
1. Adicionar 'mercado' ao array de tabs em showTab() e chamar mercadoInit() nessa branch
2. Adicionar botão #tab-mercado ao #portal-nav (após #tab-old-leads)
3. Criar #page-mercado com sub-tabs: Dashboard | Imóveis | Agências | Duplicados (admin)
4. Implementar mercadoInit(), mercadoShowTab(), e as funções de load para cada sub-tab
5. Dashboard: 4 KPIs (venda, preço médio/m², arrendamento, agências) + tabela top agências + estado do último sync
6. Imóveis: listagem com filtros (operacao, tipo, preço máximo), paginação, card por imóvel com thumbnail
7. Agências: tabela ranking com quota de mercado calculada
8. Duplicados (só admin): lado-a-lado com botões Confirmar/Rejeitar

Todo o CSS e JS vai inline no index.html (não criar ficheiros separados).
Segue o design system já presente (cores #1a3c5e / #2d6a9f, border-radius 8px, etc.).
```
