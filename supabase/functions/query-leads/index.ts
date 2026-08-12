import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const SB_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}
function jsonResp(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
async function claude(prompt: string, maxTokens = 800): Promise<string> {
  const MAX_RETRIES = 3
  let lastError: Error | null = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = 2000 * attempt
      await new Promise(r => setTimeout(r, delayMs))
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    })
    if (r.ok) return ((await r.json()).content?.[0]?.text ?? '')
    const body = await r.text()
    if (r.status === 529 || r.status === 503) {
      lastError = new Error(`overloaded:${r.status}`)
      continue
    }
    throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`)
  }
  throw lastError ?? new Error('overloaded:max_retries')
}

function isTaskMarker(texto: string): boolean {
  const TASK_MARKERS = new Set(['contactar', 'contacto', 'ligar', 'enviar email', 'email', 'reuniao', 'visita agendada'])
  return TASK_MARKERS.has(texto.toLowerCase().trim()) || texto.trim().length < 15
}

function isSystemEmail(texto: string): boolean {
  const t = texto.trimStart()
  return (
    /^Email enviado com os im/i.test(t) ||
    /^Email successfully sent with properties/i.test(t)
  )
}

function origemOrFilter(cat: string): string | null {
  const MAP: Record<string, string> = {
    'Meta':       'portal.eq.Página Web,sub_origem.ilike.%Facebook%',
    'Idealista':  'portal.ilike.%Idealista%,sub_origem.ilike.%Idealista%',
    'SuperCasa':  'portal.ilike.%SUPERCASA%,sub_origem.ilike.%SuperCasa%',
    'Kyero':      'portal.ilike.%Kyero%,sub_origem.ilike.%Kyero%',
    'GreenAcres': 'portal.ilike.%Green-Acres%,sub_origem.ilike.%Green%Acres%',
    'CasaSapo':   'portal.ilike.%Casa Sapo%,sub_origem.ilike.%Sapo%',
    'Imovirtual': 'portal.ilike.%Imovirtual%,sub_origem.ilike.%Imovirtual%',
    'OLX':        'sub_origem.ilike.%OLX%',
    'Placa':      'origem.eq.Placa/Autocolante',
    'Agencia':    'origem.eq.Loja/Agência',
    'WhatsApp':   'sub_origem.ilike.%whatsApp%,sub_origem.ilike.%whatsapp%',
    'Telefone':   'sub_origem.ilike.%Telefone%',
  }
  return MAP[cat] ?? null
}

interface BatchItem {
  ref: string; tipo: string; cliente: string; etapa: string
  notas: string; preco: number | null; preferencia: string | null
}
async function summariseBatch(
  batch: BatchItem[], question: string,
  summaryMap: Record<string, string>, hotMap: Record<string, boolean>,
  relevanteMap: Record<string, boolean>, enganoMap: Record<string, boolean>
) {
  const text = batch.map(b => {
    let line = `REF: ${b.ref} | TIPO: ${b.tipo} | CLIENTE: ${b.cliente} | ETAPA: ${b.etapa}`
    if (b.preco) line += ` | PRECO: €${b.preco.toLocaleString('pt-PT')}`
    if (b.preferencia) line += ` | PREFERENCIA: ${b.preferencia}`
    line += `\nNOTAS: ${b.notas}`
    return line
  }).join('\n===\n')
  const sp = `Contexto: agencia imobiliaria Figueira Home, Figueira da Foz, Portugal.\nTIPOS: "Venda"=comprador (quer comprar). "Angariacao"=proprietario (quer vender/arrendar).\nETAPAS: 1-Prospecto, 2-Lead, 3-Contacto, 4-Qualificacao, 5-Visita, 6-Proposta, 7-Negociacao, 8-Fecho.\n\nCada nota tem formato: [nota:DD/MM escrita:DD/MM] texto\n- "nota" = data do contacto conforme o consultor registou (pode ser data de callback futura planeada)\n- "escrita" = data em que a nota foi efectivamente inserida no sistema\nREGRA CRITICA: Para saber qual informacao e mais recente, SEMPRE usar a data "escrita", nunca a data "nota".\nQuando "escrita" de uma nota e posterior a "escrita" de outra, essa nota e mais recente e PREVALECE, mesmo que a "nota" seja anterior.\nExemplo correcto: [nota:30/04 escrita:23/04] info A | [nota:28/04 escrita:29/04] info B -> info B e MAIS RECENTE (escrita 29 > escrita 23).\n\nO utilizador perguntou: "${question}"\n\nPara cada oportunidade:\n- "summary": até 4 frases em português. Obrigatório incluir: (1) estado actual segundo a nota com "escrita" MAIS RECENTE; (2) próximo passo ou situação pendente. Incluir também se relevante: (3) contexto importante de notas anteriores que afecte a decisão ou urgência; (4) prazo específico ou data relevante. NUNCA omitir sinais de urgência imobiliária: inquílinos a sair / prazo de saída, imóvel a ficar disponível brevemente, separação/herança/execução, decisão iminente, proprietário precisa vender ou arrendar com prazo definido.\n- "hot": true se QUALQUER nota (não apenas a mais recente) contém sinais de interesse activo ou urgência real: interesse confirmado, visita marcada, inquílinos a sair ou prazo de saída conhecido, imóvel a ficar livre brevemente, separação/herança/execução hipotecária, proprietário precisa vender/arrendar num prazo próximo, comprador com deadline para mudança. false se a nota mais recente indica: já comprou/arrendou noutro lado, não interessa, sem resposta prolongada, espera indefinida sem prazo, ou é engano.\n- "engano": true se as notas indicam claramente que esta lead e invalida: engano, liguei sem querer, numero errado, nao e a pessoa, nao pediu informacao, spam, nao conhece a agencia, lead falsa. false em todos os outros casos.\n- "relevante": true se corresponde ao que o utilizador procura.\n\nResponde APENAS JSON, array com exactamente ${batch.length} items:\n[{"ref":"...","summary":"...","hot":true,"engano":false,"relevante":true}]\n\n${text}`
  try {
    const raw = await claude(sp, 2500)
    const m = raw.match(/\[[\s\S]*\]/)
    if (m) for (const it of JSON.parse(m[0])) {
      if (it.ref) {
        summaryMap[it.ref] = it.summary ?? ''
        hotMap[it.ref] = it.hot === true
        relevanteMap[it.ref] = it.relevante !== false
        enganoMap[it.ref] = it.engano === true
      }
    }
  } catch (e) { console.error('Summary batch error:', e) }
}

const OPP_SELECT = 'oportunidade_ref,tipo_oportunidade,responsavel,etapa_atual,estado_proposta,data_proposta,proposta,etapa_proposta,cliente_nome,cliente_telefone,cliente_email,imovel_ref,url,oportunidade_estado,titulo_imovel,imovel_natureza,imovel_freguesia,imovel_concelho,imovel_venda,imovel_arrendamento,preferencia_imovel,ego_data_criacao,ego_editado_em,visita_data,visita_cliente,visita_responsavel,origem,sub_origem,portal,pref_tipologia,pref_orcamento_max,pref_zona,pref_outros'

const DOMAIN_KNOWLEDGE = `
== CONTEXTO: AGENCIA IMOBILIARIA FIGUEIRA HOME (Figueira da Foz, Portugal) ==

TIPO DE OPORTUNIDADE:
  "Venda" = COMPRADOR. "Angariacao" = PROPRIETARIO/VENDEDOR. "Arrendamento" = arrendamento. null = todos.

ESTADOS VÁLIDOS (oportunidade_estado):
  APENAS três valores existem: "Ativa", "Perdida", "Ganha". O estado "Pendente" NÃO EXISTE.
  Padrão (quando não especificado): estado="Ativa".
  "pendentes" / "abertas" / "activas" / "em aberto" / "a trabalhar" → estado="Ativa" (padrão, não alterar).
  "perdidas" → estado="Perdida". "ganhas" / "fechadas" → estado="Ganha".
  NUNCA definir estado="Pendente" — este valor não existe na base de dados.

ETAPAS DO FUNIL:
  1-Prospecto, 2-Lead, 3-Contacto, 4-Qualificacao, 5-Visita, 6-Proposta, 7-Negociacao, 8-Fecho
  - "em visita" (agora) -> etapa_like="Visita" SO se pergunta sobre quem esta AGORA nessa etapa
  - "proposta activa" / "proposta aceite" / "propostas aceites" / "com proposta aceite" -> proposta_estado="Aceite"
  - "proposta em avaliação" / "proposta pendente" / "em avaliação" -> proposta_estado="Em avaliação"
  - "proposta rejeitada" / "rejeitada" -> proposta_estado="Rejeitado"
  - "com proposta" (genérico, sem estado específico) -> has_proposta=true
  - "perto de fechar" -> etapa_like="Fecho"
  ATENCAO: "visitaram [imovel]" NAO usa etapa_like.

ANGARIAÇÕES NÃO FECHADAS / SEM CMI:
  "CMI assinado" é a etapa pré-fecho de uma angariação (Compromisso de Mediação Imobiliária já assinado).
  Quando pesquisam angariações "abertas", "ativas", "a trabalhar", "sem CMI", "não fechadas", "por trabalhar",
  "sem tarefa ou em atraso", "sem tarefa", "com tarefa atrasada", "pendentes" -> excluir_cmi=true
  Isto exclui registos com etapa_atual contendo "CMI" e estado "GANHA".
  REGRA: qualquer pesquisa de angariações que implique seguimento activo -> sempre excluir_cmi=true

PESQUISA POR CONTACTO (telefone, nome de cliente, email):
  - numero de telefone (ex: "930551805", "930 551 805", "+351930551805") -> contacto_tel="930551805" (so digitos, sem espacos nem prefixo)
  - nome do cliente (ex: "leads do cliente Maria", "oportunidades do cliente Joao Silva") -> contacto_nome="Joao Silva"
  - email (ex: "oportunidades do joao@email.com") -> contacto_email="joao@email.com"
  IMPORTANTE: pesquisa por contacto mostra TODAS as oportunidades (ativas e inativas) associadas a esse contacto.
  ATENÇÃO: "do cliente X" usa contacto_nome. "da consultora X" / "do consultor X" / "da X" quando X é consultor → usa responsavel_like (ver secção abaixo).

PESQUISA POR IMOVEL ESPECIFICO (ex: FH2397):
  - SEMPRE usar imovel_ref_eq="FH2397"
  - "visitaram"/"viram": imovel_ref_eq + tem_visita=true
  - NAO usar etapa_like para pesquisas por imovel
  - "do ultimo mes"/"dos ultimos 30 dias": imovel_ref_eq + ativo_dias_max=30

FILTRO POR CONSULTOR/RESPONSAVEL:
  INCLUSAO: "do consultor X" / "da X" -> responsavel_like="X"
  EXCLUSAO: "exceto X" / "excluindo X" / "de todos menos X" -> responsavel_exclude=["X"]
  "exceto X e Y" -> responsavel_exclude=["X", "Y"]
  REGRA: quando há exclusão, NÃO definir responsavel_like (fica null).
  Exemplos:
    "todos os consultores exceto Alexsandra Ferreira" -> responsavel_exclude=["Alexsandra Ferreira"]
    "exceto Alexsandra Ferreira e Alexandra Santos" -> responsavel_exclude=["Alexsandra Ferreira", "Alexandra Santos"]

CONSULTORES DA AGÊNCIA (lista completa dos responsáveis/consultores):
  Alexandra Santos, Alexsandra Ferreira, Ana Daniel, João Marques,
  Lidia Sousa, Lina Galvão, Maria José Boia, Miguel Germano, Sandra Silva, Sofia Monteiro

  REGRA CRÍTICA DE DISAMBIGUAÇÃO:
  Se o nome na pergunta corresponde (mesmo que parcialmente) a um consultor da lista acima:
    → usar responsavel_like com o NOME COMPLETO do consultor
    → NUNCA usar contacto_nome para nomes de consultores
  Se o nome NÃO corresponde a nenhum consultor → pode ser contacto_nome (cliente).
  ATENÇÃO TIPO: quando "angariação" (ou "angariações") aparece como descrição do PAPEL do consultor
  (ex: "angariação consultora Ana Daniel", "oportunidades de angariação da Ana Daniel", "angariações da Sofia"),
  NÃO definir tipo — usar responsavel_like="Nome Completo", tipo=null.
  O "angariação" descreve o papel/especialidade da consultora, não o tipo de oportunidade.
  Exemplos:
    "oportunidades da Ana Daniel" → responsavel_like="Ana Daniel"
    "oportunidades da Sandra" → responsavel_like="Sandra Silva"
    "leads da Lina" → responsavel_like="Lina Galvão"
    "do João" → responsavel_like="João Marques"
    "da Sofia" → responsavel_like="Sofia Monteiro"
    "da Alexandra" → responsavel_like="Alexandra Santos"
    "da Alexsandra" → responsavel_like="Alexsandra Ferreira"
    "do Miguel" → responsavel_like="Miguel Germano"
    "da Maria José" → responsavel_like="Maria José Boia"
    "da Lidia" → responsavel_like="Lidia Sousa"
    "oportunidades do João Silva" (João Silva não é consultor) → contacto_nome="João Silva"

ORIGENS (de onde veio a lead):
  - "Meta"/"Facebook"/"Instagram"/"figueirahome.com" -> origem_cat="Meta"
  - "Idealista" -> origem_cat="Idealista"
  - "SuperCasa" -> origem_cat="SuperCasa"
  - "Kyero" -> origem_cat="Kyero"
  - "Green-Acres"/"GreenAcres" -> origem_cat="GreenAcres"
  - "Casa Sapo"/"Sapo" -> origem_cat="CasaSapo"
  - "Imovirtual" -> origem_cat="Imovirtual"
  - "OLX" -> origem_cat="OLX"
  - "placa"/"placa de rua" -> origem_cat="Placa"
  - "loja"/"agencia"/"montra" -> origem_cat="Agencia"
  - "WhatsApp" -> origem_cat="WhatsApp"
  - "telefone"/"chamada" -> origem_cat="Telefone"
  Sub-origens: sub_origem_like="texto" (OldLeads, Casafari, Prospeção eGO, Antigo cliente, Recomendação, etc.)
  Origens gerais: origem_exact="Internet"/"Recomendação"/"Outros"

TAREFAS POR DATA:
  Hoje é {HOJE}.
  - "tarefas para hoje" -> tarefa_due_from="{HOJE}", tarefa_due_to="{HOJE}"
  - "tarefas para amanhã" -> tarefa_due_from="{AMANHA}", tarefa_due_to="{AMANHA}"
  - "tarefas desta semana" -> tarefa_due_from="{HOJE}", tarefa_due_to="{HOJE+6}"
  - "tarefas atrasadas" -> tarefa_atrasada=true

VISITAS POR AVALIAR: visita_por_avaliar=true (+ visita_dias_max=N se com limite de dias)

CATEGORIAS DE PRECO: "acessivel" -> preco_maximo=200000; "alto valor" -> preco_minimo=300000; "luxo" -> preco_minimo=500000

TIPOLOGIAS (pesquisa em notas, NÃO em preferências de comprador): "T0".."T5" -> nota_like="T2"; "moradias" -> nota_like="moradia"; "apartamentos" -> nota_like="apartamento"
  ATENÇÃO: "clientes para apartamentos" / "compradores de apartamentos" usa comprador_tipologia (ver PREFERÊNCIAS DO COMPRADOR abaixo), NUNCA nota_like.

ZONAS (via nota_like): Buarcos, Tavarede, Brenha, Vila Verde, Marinha das Ondas, etc.
OBRAS: nota_like=["obras","remodelar","reabilit","renovar"]

DATAS — REGRA FUNDAMENTAL:
  Hoje é {HOJE}.
  Existem DOIS tipos de data:
  A) ego_data_criacao = data em que a oportunidade FOI CRIADA no eGO (quando entrou o lead pela 1ª vez). Pode ser de meses/anos atras.
  B) nota_data_iso = data da ULTIMA NOTA/ACTIVIDADE (quando houve contacto recente com o cliente).

  ACTIVIDADE RECENTE — usar editado_dias (tipo B, baseado em notas). PADRAO para frases genéricas:
  - "oportunidades dos últimos N dias" / "leads dos últimos N dias" -> editado_dias=N
  - "oportunidades dos últimos 3 dias" -> editado_dias=3
  - "dos últimos N dias" / "nos últimos N dias" (sem "criadas"/"novas") -> editado_dias=N
  - "com actividade hoje" / "editadas hoje" -> editado_hoje=true
  - "activas esta semana" / "desta semana" / "editadas esta semana" -> editado_dias=7
  - "deste mês" / "editadas este mês" -> editado_dias=30
  - "com actividade nos últimos N dias" -> editado_dias=N
  - "ontem" (sem "criadas") -> editado_dias=1

  NOVAS LEADS — usar criado_dias (tipo A, ego_data_criacao). So quando há EXPLICITAMENTE "criadas"/"novas":
  - "criadas hoje" / "novas hoje" -> criado_hoje=true
  - "criadas esta semana" / "novas esta semana" -> criado_dias=7
  - "criadas este mês" / "novas este mês" -> criado_dias=30
  - "criadas nos últimos N dias" / "novas nos últimos N dias" -> criado_dias=N
  - "criadas ontem" / "novas ontem" -> criado_dias=1

  AMBOS (criado OU editado):
  - "criadas ou editadas esta semana" -> criado_ou_editado_dias=7
  - "criadas ou editadas nos últimos N dias" -> criado_ou_editado_dias=N

  REGRA CRÍTICA: "oportunidades dos últimos N dias" SEM a palavra "criadas" ou "novas" -> editado_dias=N (não criado_dias!).

QUALIDADE: "qualidade das leads" -> mostrar_qualidade=true

PREFERÊNCIAS DO COMPRADOR (pref_*):
  Campos extraídos por IA das notas das oportunidades de Venda.
  - "clientes que querem moradia" -> comprador_tipologia="moradia"
  - "clientes que querem T2" -> comprador_tipologia="T2"
  - "compradores até 200k" -> comprador_orcamento_max=200000
  - "compradores acima de 150k" -> comprador_orcamento_min=150000
  - "clientes que querem Quiaios" -> comprador_zona="Quiaios"
  - "clientes que querem jardim" / "com garagem" / "com vista mar" / "com piscina" / "com suite" -> comprador_outros="jardim" (ou "garagem", "vista mar", etc.)
  - Combinações: "moradia T3 com jardim e garagem" -> comprador_tipologia="T3", comprador_outros="jardim"
  - NOTA: comprador_outros pesquisa em pref_outros (lista de características: jardim, garagem, vista mar, piscina, suite, varanda, r/c, novo, etc.)
  REGRA CRÍTICA: "clientes para [tipologia]" / "compradores de [tipologia]" / "clientes que procuram [tipologia]" → SEMPRE usar comprador_tipologia, NUNCA nota_like:
    - "clientes para apartamentos" → comprador_tipologia="apartamento"
    - "clientes para moradias" → comprador_tipologia="moradia"
    - "compradores de T2" → comprador_tipologia="T2"
    - "clientes para apartamentos ate 300000€" → comprador_tipologia="apartamento", comprador_orcamento_max=300000

REGRAS:
  1. Para imoveis (FH...) usar imovel_ref_eq.
  2. nota_like pode ser string ou array (OR).
  3. etapa_like so para quem esta AGORA nessa etapa.
  4. estado padrao e "Ativa". Os únicos estados válidos são "Ativa", "Perdida", "Ganha".
  5. "casas" e generico, NAO restringir tipologia.
  6. ativo_dias_max so usar COM imovel_ref_eq.
  7. origem_cat tem prioridade sobre sub_origem_like e origem_exact.
  8. Para "tarefas agendadas"/"agenda"/"para ligar" usar tarefa_due_from/to.
  9. responsavel_exclude é SEMPRE um array: ["Nome"].
  10. Angariações com seguimento activo -> sempre excluir_cmi=true.
  11. "dos últimos N dias" genérico -> editado_dias=N. Só "criadas"/"novas" usa criado_dias.
  12. SEM CONTACTO (intervalo de dias sem nota):
      "mais de N dias sem contacto" / "inativo há mais de N dias" / "sem nota há mais de N dias" -> sem_contacto_min_dias=N
      "menos de N dias sem contacto" (limite superior) -> sem_contacto_max_dias=N
      "entre N e M dias sem contacto" / "mais de N e menos de M dias" / "há mais de N dias e menos de M dias" -> sem_contacto_min_dias=N, sem_contacto_max_dias=M
      Exemplos:
        "angariações com mais de 180 dias sem contacto" -> sem_contacto_min_dias=180
        "mais de 180 dias e menos de 360 dias sem contacto" -> sem_contacto_min_dias=180, sem_contacto_max_dias=360
        "oportunidades sem contacto há mais de 30 dias" -> sem_contacto_min_dias=30
        "leads inativas há mais de 60 dias" -> sem_contacto_min_dias=60
      NOTA: este filtro usa a data da última nota (nota_data_iso). É o INVERSO de editado_dias. NÃO usar editado_dias quando o utilizador pede "sem contacto há mais de N dias".
`

async function fetchAllOpps(
  sb: ReturnType<typeof createClient>,
  filters: Record<string, unknown>,
  tipoFiltro: string | null,
  estadoFiltro: string,
  applyRespFilters: (q: ReturnType<typeof sb.from>) => ReturnType<typeof sb.from>
): Promise<string[]> {
  const allRefs: string[] = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    let q = sb.from('oportunidades').select('oportunidade_ref').eq('oportunidade_estado', estadoFiltro)
    if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro)
    q = applyRespFilters(q)
    const { data } = await (q as ReturnType<typeof sb.from>)
      .order('ego_editado_em', { ascending: true, nullsFirst: true })
      .range(offset, offset + PAGE - 1)
    if (!data?.length) break
    for (const o of data) allRefs.push(o.oportunidade_ref as string)
    if (data.length < PAGE) break
    offset += PAGE
    if (allRefs.length > 10000) break
  }
  return allRefs
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!ANTHROPIC_KEY) return jsonResp({ error: 'ANTHROPIC_API_KEY nao configurado' }, 500, cors)
    if (!SB_KEY) return jsonResp({ error: 'SUPABASE_SERVICE_ROLE_KEY nao disponivel' }, 500, cors)

    const body = await req.json()

    // mode=campaign_quality — query v_qualidade_campanha directly, no AI needed
    const mode: string = body.mode ?? ''
    if (mode === 'campaign_quality') {
      const sb = createClient(SB_URL, SB_KEY)
      const { data, error } = await sb.from('v_qualidade_campanha').select('*')
      if (error) return jsonResp({ error: error.message }, 500, cors)
      const rows = (data ?? []) as Record<string, unknown>[]
      const totalLeads = rows.reduce((s, r) => s + ((r.total_leads as number) ?? 0), 0)
      const totalVisitas = rows.reduce((s, r) => s + ((r.visitas as number) ?? 0), 0)
      const totalVendas = rows.reduce((s, r) => s + ((r.vendas as number) ?? 0), 0)
      return jsonResp({
        campanhas: rows,
        summary: {
          total_campanhas: rows.length,
          total_leads: totalLeads,
          total_visitas: totalVisitas,
          total_vendas: totalVendas,
          media_leads_visita: totalVisitas > 0 ? Math.round(totalLeads / totalVisitas * 10) / 10 : null,
          media_leads_venda: totalVendas > 0 ? Math.round(totalLeads / totalVendas * 10) / 10 : null,
          media_global_pct_nao_atende: rows[0]?.media_global_pct_nao_atende ?? null,
          media_global_pct_sem_interesse: rows[0]?.media_global_pct_sem_interesse ?? null,
          campanhas_alerta_nao_atende: rows.filter(r => r.alerta_nao_atende).length,
          campanhas_alerta_sem_interesse: rows.filter(r => r.alerta_sem_interesse).length,
        }
      }, 200, cors)
    }

    const question: string = body.question ?? ''
    if (!question) return jsonResp({ error: 'question obrigatorio' }, 400, cors)
    const forceResponsavel: string | null = body.force_responsavel ?? null
    const offset: number = typeof body.offset === 'number' ? Math.max(0, Math.floor(body.offset)) : 0
    const rawExport: boolean = body.raw_export === true

    const sb = createClient(SB_URL, SB_KEY)
    const hoje = new Date().toISOString().slice(0, 10)

    const amanha = new Date(); amanha.setDate(amanha.getDate() + 1)
    const amanhaStr = amanha.toISOString().slice(0, 10)
    const hoje6 = new Date(); hoje6.setDate(hoje6.getDate() + 6)
    const hoje6Str = hoje6.toISOString().slice(0, 10)
    const hoje7Str = new Date(new Date().setDate(new Date().getDate() + 7)).toISOString().slice(0, 10)

    const domainWithDates = DOMAIN_KNOWLEDGE
      .replace(/\{HOJE\}/g, hoje)
      .replace(/\{AMANHA\}/g, amanhaStr)
      .replace(/\{HOJE\+7\}/g, hoje7Str)
      .replace(/\{HOJE\+6\}/g, hoje6Str)
      .replace(/\{HOJE\+1\}/g, amanhaStr)

    const parsePrompt = `${domainWithDates}\n\nPergunta do utilizador: "${question}"\n\nResponde APENAS com JSON valido (sem texto adicional):\n{\n  "tipo": null, "estado": null, "has_proposta": null, "proposta_estado": null, "etapa_like": null,\n  "responsavel_like": null, "responsavel_exclude": null,\n  "nota_like": null, "imovel_ref_eq": null,\n  "tem_visita": null, "visita_por_avaliar": null, "visita_dias_max": null,\n  "ativo_dias_max": null, "preco_minimo": null, "preco_maximo": null,\n  "sem_tarefa": null, "tarefa_atrasada": null, "sem_tarefa_ou_atrasada": null,\n  "tarefa_due_from": null, "tarefa_due_to": null,\n  "criado_hoje": null, "editado_hoje": null, "criado_ou_editado_hoje": null,\n  "criado_dias": null, "editado_dias": null, "criado_ou_editado_dias": null,\n  "origem_cat": null, "sub_origem_like": null, "origem_exact": null,\n  "mostrar_qualidade": null,\n  "contacto_tel": null, "contacto_nome": null, "contacto_email": null,\n  "comprador_tipologia": null, "comprador_orcamento_max": null, "comprador_orcamento_min": null, "comprador_zona": null, "comprador_outros": null,\n  "excluir_cmi": null,\n  "sem_contacto_min_dias": null,\n  "sem_contacto_max_dias": null,\n  "description": "descricao curta do que foi pesquisado"\n}`

    let filters: Record<string, unknown> = {}
    try {
      const raw = await claude(parsePrompt, 600)
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) filters = JSON.parse(m[0])
    } catch (e) {
      const msg = String(e)
      if (msg.includes('overloaded')) {
        return jsonResp({ error: 'A IA está temporariamente sobrecarregada. Tenta de novo em alguns segundos.' }, 503, cors)
      }
      return jsonResp({ error: `Erro ao interpretar: ${e}` }, 500, cors)
    }

    if (forceResponsavel) {
      // Não filtrar por responsável — mostrar resultados de toda a equipa,
      // mas tagear is_own e redactar dados do cliente para não-próprios
      filters.responsavel_exclude = null
    }

    const responsavelExclude: string[] = (() => {
      const re = filters.responsavel_exclude
      if (!re) return []
      if (Array.isArray(re)) return re as string[]
      if (typeof re === 'string' && re.trim()) return [re.trim()]
      return []
    })()

    const excluirCMI = filters.excluir_cmi === true

    function matchesWordBoundary(responsavel: string, name: string): boolean {
      const r = responsavel.toLowerCase()
      const n = name.toLowerCase()
      return r === n || r.startsWith(n + ' ') || r.includes(' ' + n + ' ') || r.endsWith(' ' + n)
    }

    // deno-lint-ignore no-explicit-any
    function applyRespFilters(q: any): any {
      if (filters.responsavel_like) {
        const name = filters.responsavel_like as string
        q = q.ilike('responsavel', `%${name}%`)
      }
      for (const name of responsavelExclude) q = q.not('responsavel', 'ilike', `%${name}%`)
      if (excluirCMI) q = q.not('etapa_atual', 'ilike', '%CMI%').neq('oportunidade_estado', 'Ganha')
      return q
    }

    const hasRespFilter = !!(filters.responsavel_like) || responsavelExclude.length > 0
    const needsWordBoundary = !!(filters.responsavel_like) && !forceResponsavel

    // Tagger de propriedade: adiciona is_own e redacta dados do cliente para não-próprios
    // deno-lint-ignore no-explicit-any
    function tagOwnership(rs: any[]): any[] {
      if (!forceResponsavel) return rs
      return rs.map(r => {
        const isOwn = r.responsavel === forceResponsavel
        if (!isOwn) return { ...r, is_own: false, cliente_nome: null, cliente_telefone: null, cliente_email: null }
        return { ...r, is_own: true }
      })
    }

    const contactoTel = (filters.contacto_tel as string) || null
    const contactoNome = (filters.contacto_nome as string) || null
    const contactoEmail = (filters.contacto_email as string) || null
    const isPesquisaContacto = !!(contactoTel || contactoNome || contactoEmail)

    if (isPesquisaContacto) {
      let q = sb.from('oportunidades').select(OPP_SELECT)
      if (contactoTel) { const telLimpo = contactoTel.replace(/\D/g, ''); q = q.ilike('cliente_telefone', `%${telLimpo}%`) }
      else if (contactoEmail) q = q.ilike('cliente_email', `%${contactoEmail}%`)
      else if (contactoNome) q = q.ilike('cliente_nome', `%${contactoNome}%`)
      if (filters.tipo) {
        const tipoMapC: Record<string, string> = { 'Angariacao': 'Angariação', 'Venda': 'Venda', 'Arrendamento': 'Arrendamento' }
        q = q.eq('tipo_oportunidade', tipoMapC[filters.tipo as string] ?? filters.tipo as string)
      }
      const { data: contactoOpps } = await q.order('ego_data_criacao', { ascending: false }).limit(100)
      if (!contactoOpps?.length) return jsonResp({ results: [], total: 0, description: filters.description ?? '', has_more: false }, 200, cors)

      const refs = contactoOpps.map(o => o.oportunidade_ref as string)
      const { data: todasNotas } = await sb.from('notas').select('oportunidade_ref,nota_texto,nota_data_iso,criado_em').in('oportunidade_ref', refs).order('nota_data_iso', { ascending: false, nullsFirst: false }).order('criado_em', { ascending: false }).limit(500)
      const notasMap: Record<string, string[]> = {}; const ultimoContactoMap: Record<string, string> = {}
      for (const n of todasNotas ?? []) {
        const ref = n.oportunidade_ref as string; if (!notasMap[ref]) notasMap[ref] = []
        const texto = (n.nota_texto as string | null)?.trim() ?? null
        if (!texto || isTaskMarker(texto) || isSystemEmail(texto)) continue
        const notaDataISO = n.nota_data_iso as string | null; const criadoEM = n.criado_em as string | null
        const criadoDateShort = criadoEM ? criadoEM.slice(5, 10).replace('-', '/') : null
        let dataLabel = ''
        if (notaDataISO && criadoDateShort) dataLabel = `[nota:${notaDataISO.slice(5).replace('-', '/')} escrita:${criadoDateShort}]`
        else if (notaDataISO) dataLabel = `[nota:${notaDataISO.slice(5).replace('-', '/')}]`
        else if (criadoDateShort) dataLabel = `[escrita:${criadoDateShort}]`
        const textoComData = dataLabel ? `${dataLabel} ${texto}` : texto
        if (notasMap[ref].length < 5 && !notasMap[ref].some(t => t.includes(texto.slice(0, 40)))) notasMap[ref].push(textoComData)
        if (!ultimoContactoMap[ref] && notaDataISO) ultimoContactoMap[ref] = notaDataISO
      }
      const { data: tarefas } = await sb.from('tarefas').select('oportunidade_ref,tarefa_titulo,tarefa_due_iso,tarefa_status').in('oportunidade_ref', refs).eq('tarefa_status', 'pendente').order('tarefa_due_iso', { ascending: true }).limit(100)
      const tarefasMap: Record<string, { titulo: string; due: string; atrasada: boolean; dias_atraso: number }> = {}
      for (const t of tarefas ?? []) {
        const ref = t.oportunidade_ref as string; if (tarefasMap[ref]) continue
        const due = t.tarefa_due_iso as string; const diasAtraso = due ? Math.floor((new Date(hoje).getTime() - new Date(due).getTime()) / 86400000) : 0
        tarefasMap[ref] = { titulo: t.tarefa_titulo as string, due, atrasada: due ? due < hoje : false, dias_atraso: diasAtraso > 0 ? diasAtraso : 0 }
      }
      const comNotas = contactoOpps.filter(o => (notasMap[o.oportunidade_ref as string] ?? []).length > 0)
      const summaryMap: Record<string, string> = {}; const hotMap: Record<string, boolean> = {}; const relevanteMap: Record<string, boolean> = {}; const enganoMap: Record<string, boolean> = {}
      if (!rawExport) {
        for (let i = 0; i < comNotas.length; i += 12) {
          await summariseBatch(comNotas.slice(i, i + 12).map(o => ({ ref: o.oportunidade_ref as string, tipo: o.tipo_oportunidade as string, cliente: (o.cliente_nome as string) ?? '', etapa: (o.etapa_atual as string) ?? '', notas: (notasMap[o.oportunidade_ref as string] ?? []).join(' | '), preco: (o.imovel_venda as number) || (o.imovel_arrendamento as number) || null, preferencia: (o.preferencia_imovel as string) || null })), question, summaryMap, hotMap, relevanteMap, enganoMap)
        }
      }
      function origemLabelC(o: Record<string, unknown>): string | null {
        const portal = (o.portal as string | null)?.trim(); const subOrigem = (o.sub_origem as string | null)?.trim(); const origem = (o.origem as string | null)?.trim()
        if (portal && portal !== 'null') return portal
        if (subOrigem && subOrigem !== 'null') { if (subOrigem.includes('Idealista')) return 'Idealista'; if (subOrigem.includes('SuperCasa') || subOrigem.includes('SUPERCASA')) return 'SuperCasa'; if (subOrigem.includes('Facebook') || subOrigem.includes('Instagram') || subOrigem.includes('figueirahome')) return 'Meta'; return subOrigem }
        if (origem && origem !== 'null') return origem; return null
      }
      const results = contactoOpps.map(o => { const ref = o.oportunidade_ref as string; return { ...o, summary: summaryMap[ref] ?? null, hot: hotMap[ref] ?? false, engano: enganoMap[ref] ?? false, relevante: relevanteMap[ref] ?? true, notas_preview: (notasMap[ref] ?? []).slice(0, 2), ultimo_contacto: ultimoContactoMap[ref] ?? null, tarefa: tarefasMap[ref] ?? null, origem_label: origemLabelC(o) } })
      results.sort((a, b) => { if (a.hot !== b.hot) return b.hot ? 1 : -1; return (b.ultimo_contacto ?? '0000-00-00').localeCompare(a.ultimo_contacto ?? '0000-00-00') })
      const taggedC = tagOwnership(results)
      return jsonResp({ results: taggedC, total: taggedC.length, description: filters.description ?? '', mostrar_qualidade: false, quality_stats: null, origem_cat: null, pesquisa_contacto: { tel: contactoTel, nome: contactoNome, email: contactoEmail }, has_more: false }, 200, cors)
    }

    const tarefaDueFrom = (filters.tarefa_due_from as string) || null
    const tarefaDueTo = (filters.tarefa_due_to as string) || null
    const isPesquisaTarefas = !!(tarefaDueFrom || tarefaDueTo)

    if (isPesquisaTarefas) {
      let tq = sb.from('tarefas').select('oportunidade_ref,tarefa_titulo,tarefa_due_iso,tarefa_status,tipo_oportunidade,cliente_nome,url').eq('tarefa_status', 'pendente')
      if (tarefaDueFrom) tq = tq.gte('tarefa_due_iso', tarefaDueFrom)
      if (tarefaDueTo)   tq = tq.lte('tarefa_due_iso', tarefaDueTo)
      const { data: tarefasData } = await tq.order('tarefa_due_iso', { ascending: true }).limit(300)
      if (!tarefasData?.length) return jsonResp({ results: [], total: 0, description: filters.description ?? '', is_tarefas: true, has_more: false }, 200, cors)

      const tarefasPorRef: Record<string, { titulo: string; due: string; atrasada: boolean; dias_atraso: number }> = {}; const refsOrdemTarefa: string[] = []
      for (const t of tarefasData) {
        const ref = t.oportunidade_ref as string
        if (!tarefasPorRef[ref]) {
          refsOrdemTarefa.push(ref); const due = t.tarefa_due_iso as string; const diasAtraso = due ? Math.floor((new Date(hoje).getTime() - new Date(due).getTime()) / 86400000) : 0
          tarefasPorRef[ref] = { titulo: t.tarefa_titulo as string, due, atrasada: due ? due < hoje : false, dias_atraso: diasAtraso > 0 ? diasAtraso : 0 }
        }
      }
      let refsFinais = refsOrdemTarefa
      const tipoMapT: Record<string, string> = { 'Angariacao': 'Angariação', 'Venda': 'Venda', 'Arrendamento': 'Arrendamento' }
      const tipoFiltroT = filters.tipo ? (tipoMapT[filters.tipo as string] ?? filters.tipo as string) : null
      if (hasRespFilter || tipoFiltroT || excluirCMI) {
        let fq = sb.from('oportunidades').select('oportunidade_ref,responsavel').in('oportunidade_ref', refsFinais.slice(0, 1000))
        fq = applyRespFilters(fq); if (tipoFiltroT) fq = fq.eq('tipo_oportunidade', tipoFiltroT)
        const { data: filtradas } = await fq.limit(300)
        let filtSet = new Set((filtradas ?? []).map(o => o.oportunidade_ref as string))
        if (needsWordBoundary && filtradas) {
          const name = filters.responsavel_like as string
          filtSet = new Set((filtradas as Array<{oportunidade_ref: string; responsavel: string | null}>)
            .filter(o => o.responsavel != null && matchesWordBoundary(o.responsavel, name))
            .map(o => o.oportunidade_ref))
        }
        refsFinais = refsFinais.filter(r => filtSet.has(r))
      }
      if (!refsFinais.length) return jsonResp({ results: [], total: 0, description: filters.description ?? '', is_tarefas: true, has_more: false }, 200, cors)

      const PAGE_SIZE_T = rawExport ? Math.min(refsFinais.length, 500) : 25
      const totalTarefas = refsFinais.length
      const hasMorT = !rawExport && totalTarefas > offset + PAGE_SIZE_T
      refsFinais = refsFinais.slice(offset, offset + PAGE_SIZE_T)

      const oppsData: Record<string, unknown>[] = []
      for (let i = 0; i < refsFinais.length; i += 100) {
        const { data: chunkOpps } = await sb.from('oportunidades').select(OPP_SELECT).in('oportunidade_ref', refsFinais.slice(i, i + 100))
        if (chunkOpps) oppsData.push(...chunkOpps)
      }
      const oppMap: Record<string, Record<string, unknown>> = {}; for (const o of oppsData) oppMap[o.oportunidade_ref as string] = o
      const { data: todasNotas } = await sb.from('notas').select('oportunidade_ref,nota_texto,nota_data_iso,criado_em').in('oportunidade_ref', refsFinais).order('nota_data_iso', { ascending: false, nullsFirst: false }).order('criado_em', { ascending: false }).limit(500)
      const notasMap: Record<string, string[]> = {}; const ultimoContactoMap: Record<string, string> = {}
      for (const n of todasNotas ?? []) {
        const ref = n.oportunidade_ref as string; if (!notasMap[ref]) notasMap[ref] = []
        const texto = (n.nota_texto as string | null)?.trim() ?? null
        if (!texto || isTaskMarker(texto) || isSystemEmail(texto)) continue
        const notaDataISO = n.nota_data_iso as string | null; const criadoEM = n.criado_em as string | null; const criadoDateShort = criadoEM ? criadoEM.slice(5, 10).replace('-', '/') : null
        let dataLabel = ''; if (notaDataISO && criadoDateShort) dataLabel = `[nota:${notaDataISO.slice(5).replace('-', '/')} escrita:${criadoDateShort}]`; else if (notaDataISO) dataLabel = `[nota:${notaDataISO.slice(5).replace('-', '/')}]`; else if (criadoDateShort) dataLabel = `[escrita:${criadoDateShort}]`
        const textoComData = dataLabel ? `${dataLabel} ${texto}` : texto
        if (notasMap[ref].length < 5 && !notasMap[ref].some(t => t.includes(texto.slice(0, 40)))) notasMap[ref].push(textoComData)
        if (!ultimoContactoMap[ref] && notaDataISO) ultimoContactoMap[ref] = notaDataISO
      }
      const comNotas = refsFinais.filter(ref => (notasMap[ref] ?? []).length > 0)
      const summaryMap: Record<string, string> = {}; const hotMap: Record<string, boolean> = {}; const relevanteMap: Record<string, boolean> = {}; const enganoMap: Record<string, boolean> = {}
      if (!rawExport) {
        for (let i = 0; i < comNotas.length; i += 12) { await summariseBatch(comNotas.slice(i, i + 12).map(ref => { const o = oppMap[ref] ?? {}; return { ref, tipo: (o.tipo_oportunidade as string) ?? '', cliente: (o.cliente_nome as string) ?? '', etapa: (o.etapa_atual as string) ?? '', notas: (notasMap[ref] ?? []).join(' | '), preco: (o.imovel_venda as number) || (o.imovel_arrendamento as number) || null, preferencia: (o.preferencia_imovel as string) || null } }), question, summaryMap, hotMap, relevanteMap, enganoMap) }
      }
      const resultsRawT = refsFinais.map(ref => { const o = oppMap[ref] ?? {}; return { ...o, oportunidade_ref: ref, summary: summaryMap[ref] ?? null, hot: hotMap[ref] ?? false, engano: enganoMap[ref] ?? false, relevante: relevanteMap[ref] ?? true, notas_preview: (notasMap[ref] ?? []).slice(0, 2), ultimo_contacto: ultimoContactoMap[ref] ?? null, tarefa: tarefasPorRef[ref] ?? null, origem_label: null } })
      const results = tagOwnership(resultsRawT)
      return jsonResp({ results, total: results.length, description: filters.description ?? '', is_tarefas: true, mostrar_qualidade: false, quality_stats: null, origem_cat: null, has_more: hasMorT }, 200, cors)
    }

    const mostrarQualidade = filters.mostrar_qualidade === true
    const tipoMap: Record<string, string> = { 'Angariacao': 'Angariação', 'Venda': 'Venda', 'Arrendamento': 'Arrendamento' }
    const tipoFiltro = filters.tipo ? (tipoMap[filters.tipo as string] ?? filters.tipo as string) : null
    const estadoRaw = (filters.estado as string) || 'Ativa'
    const estadoFiltro = estadoRaw === 'Pendente' ? 'Ativa' : estadoRaw
    const usaFiltroPorTarefa = filters.sem_tarefa === true || filters.tarefa_atrasada === true || filters.sem_tarefa_ou_atrasada === true
    const precoMinimo = filters.preco_minimo ? Number(filters.preco_minimo) : null
    const precoMaximo = filters.preco_maximo ? Number(filters.preco_maximo) : null
    const usaFiltroPorPreco = precoMinimo !== null || precoMaximo !== null
    const imovelRefEq = (filters.imovel_ref_eq as string) || null
    const temVisita = filters.tem_visita === true
    const visitaPorAvaliar = filters.visita_por_avaliar === true
    const visitaDiasMax = filters.visita_dias_max ? Number(filters.visita_dias_max) : null
    const ativoDiasMax = filters.ativo_dias_max ? Number(filters.ativo_dias_max) : null
    const criadoHoje = filters.criado_hoje === true; const editadoHoje = filters.editado_hoje === true; const criadoOuEditadoHoje = filters.criado_ou_editado_hoje === true
    const criadoDias = filters.criado_dias ? Number(filters.criado_dias) : null; const editadoDias = filters.editado_dias ? Number(filters.editado_dias) : null; const criadoOuEditadoDias = filters.criado_ou_editado_dias ? Number(filters.criado_ou_editado_dias) : null
    const usaFiltroPorData = criadoHoje || editadoHoje || criadoOuEditadoHoje || criadoDias !== null || editadoDias !== null || criadoOuEditadoDias !== null
    const semContactoMinDias = filters.sem_contacto_min_dias ? Number(filters.sem_contacto_min_dias) : null
    const semContactoMaxDias = filters.sem_contacto_max_dias ? Number(filters.sem_contacto_max_dias) : null
    const origemCat = (filters.origem_cat as string) || null; const subOrigemLike = (filters.sub_origem_like as string) || null; const origemExact = (filters.origem_exact as string) || null
    const compradorTipologia = (filters.comprador_tipologia as string) || null
    const compradorOrcamentoMax = filters.comprador_orcamento_max ? Number(filters.comprador_orcamento_max) : null
    const compradorOrcamentoMin = filters.comprador_orcamento_min ? Number(filters.comprador_orcamento_min) : null
    const compradorZona = (filters.comprador_zona as string) || null
    const compradorOutros = (filters.comprador_outros as string) || null
    const usaFiltroPorPreferencia = !!(compradorTipologia || compradorOrcamentoMax !== null || compradorOrcamentoMin !== null || compradorZona || compradorOutros)
    const propostaEstado = (filters.proposta_estado as string) || null

    // deno-lint-ignore no-explicit-any
    async function queryRefsWithResp(q: any): Promise<string[]> {
      const { data } = await q.limit(3000)
      if (!data?.length) return []
      if (needsWordBoundary) {
        const name = filters.responsavel_like as string
        return (data as Array<{oportunidade_ref: string; responsavel: string | null}>)
          .filter(o => o.responsavel != null && matchesWordBoundary(o.responsavel, name))
          .map(o => o.oportunidade_ref)
      }
      return (data as Array<{oportunidade_ref: string}>).map(o => o.oportunidade_ref)
    }

    let refsFromNotaLike: Set<string> | null = null
    if (filters.nota_like) {
      const terms: string[] = Array.isArray(filters.nota_like) ? (filters.nota_like as string[]) : [filters.nota_like as string]
      const allRefs = new Set<string>()
      for (const term of terms) { const { data: nm } = await sb.from('notas').select('oportunidade_ref').ilike('nota_texto', `%${term}%`).limit(600); if (nm) for (const n of nm) allRefs.add(n.oportunidade_ref as string) }
      refsFromNotaLike = allRefs
      if (!refsFromNotaLike.size) return jsonResp({ results: [], total: 0, description: filters.description ?? '', has_more: false }, 200, cors)
    }

    let refsFromOrigem: Set<string> | null = null
    if (origemCat || subOrigemLike || origemExact) {
      let q = sb.from('oportunidades').select('oportunidade_ref,responsavel').limit(5000)
      let hasOrigemFilter = false
      if (origemCat) { const orFilter = origemOrFilter(origemCat); if (orFilter) { q = q.or(orFilter); hasOrigemFilter = true } }
      else if (subOrigemLike) { q = q.ilike('sub_origem', `%${subOrigemLike}%`); hasOrigemFilter = true }
      else if (origemExact) { q = q.eq('origem', origemExact); hasOrigemFilter = true }
      if (hasOrigemFilter) {
        if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro); q = applyRespFilters(q)
        const { data: origemData } = await q
        let origemRefs = (origemData ?? []) as Array<{oportunidade_ref: string; responsavel: string | null}>
        if (needsWordBoundary) {
          const name = filters.responsavel_like as string
          origemRefs = origemRefs.filter(o => o.responsavel != null && matchesWordBoundary(o.responsavel, name))
        }
        refsFromOrigem = new Set(origemRefs.map(o => o.oportunidade_ref))
        if (!refsFromOrigem.size) return jsonResp({ results: [], total: 0, description: filters.description ?? '', has_more: false }, 200, cors)
      }
    }

    let refsComQualquerTarefa: Set<string> | null = null; let refsComTarefaAtrasada: Set<string> | null = null; let refsComTarefaFutura: Set<string> | null = null
    if (usaFiltroPorTarefa) {
      const { data: todasTarefas } = await sb.from('tarefas').select('oportunidade_ref,tarefa_due_iso').eq('tarefa_status', 'pendente').limit(5000)
      refsComQualquerTarefa = new Set(); refsComTarefaAtrasada = new Set()
      for (const t of todasTarefas ?? []) { const ref = t.oportunidade_ref as string; const due = t.tarefa_due_iso as string | null; refsComQualquerTarefa.add(ref); if (due && due < hoje) refsComTarefaAtrasada.add(ref) }
      refsComTarefaFutura = new Set([...refsComQualquerTarefa].filter(r => !refsComTarefaAtrasada!.has(r)))
    }

    let refsOrdenados: string[]

    if (visitaPorAvaliar) {
      let q = sb.from('oportunidades').select('oportunidade_ref,visita_data,responsavel').eq('oportunidade_estado', estadoFiltro).not('visita_data', 'is', null).is('visita_pontos_positivos', null).is('visita_sobre_negocio', null).is('visita_observacoes', null)
      if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro); q = applyRespFilters(q)
      const { data: visitasOpps } = await q.order('visita_data', { ascending: false }).limit(200)
      let filtered = (visitasOpps ?? []) as Array<{oportunidade_ref: string; visita_data: string; responsavel: string | null}>
      if (needsWordBoundary) { const name = filters.responsavel_like as string; filtered = filtered.filter(o => o.responsavel != null && matchesWordBoundary(o.responsavel, name)) }
      if (visitaDiasMax) { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - visitaDiasMax); const cutoffStr = cutoff.toISOString().slice(0, 10); filtered = filtered.filter(o => o.visita_data >= cutoffStr) }
      refsOrdenados = filtered.map(o => o.oportunidade_ref)
    } else if (imovelRefEq) {
      let q = sb.from('oportunidades').select('oportunidade_ref,ego_data_criacao,responsavel').eq('imovel_ref', imovelRefEq).eq('oportunidade_estado', estadoFiltro)
      if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro); q = applyRespFilters(q); if (temVisita) q = q.not('visita_data', 'is', null)
      const { data: imovelOpps } = await q.limit(300)
      let filteredImovel = (imovelOpps ?? []) as Array<{oportunidade_ref: string; ego_data_criacao: string | null; responsavel: string | null}>
      if (needsWordBoundary) { const name = filters.responsavel_like as string; filteredImovel = filteredImovel.filter(o => o.responsavel != null && matchesWordBoundary(o.responsavel, name)) }
      let allImovelRefs = filteredImovel.map(o => o.oportunidade_ref)
      if (ativoDiasMax !== null && allImovelRefs.length > 0) {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - ativoDiasMax); const cutoffStr = cutoff.toISOString().slice(0, 10)
        const refsNewlyCreated = new Set<string>(filteredImovel.filter(o => { const criado = o.ego_data_criacao; return criado && criado >= cutoffStr }).map(o => o.oportunidade_ref))
        const { data: notasRecentesRaw } = await sb.from('notas').select('oportunidade_ref,nota_texto').in('oportunidade_ref', allImovelRefs).gte('nota_data_iso', cutoffStr).not('nota_data_iso', 'is', null).not('nota_texto', 'ilike', 'Email enviado com os im%').not('nota_texto', 'ilike', 'Email successfully sent with properties%').limit(500)
        const refsFromNotas = new Set<string>((notasRecentesRaw ?? []).filter((n: Record<string, unknown>) => !isTaskMarker((n.nota_texto as string) ?? '')).map((n: Record<string, unknown>) => n.oportunidade_ref as string))
        allImovelRefs = allImovelRefs.filter(r => new Set([...refsNewlyCreated, ...refsFromNotas]).has(r))
      }
      refsOrdenados = allImovelRefs
      if (refsFromNotaLike) refsOrdenados = refsOrdenados.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) refsOrdenados = refsOrdenados.filter(r => refsFromOrigem!.has(r))
    } else if (usaFiltroPorPreferencia) {
      let q = sb.from('oportunidades').select('oportunidade_ref,responsavel').eq('oportunidade_estado', estadoFiltro).eq('tipo_oportunidade', 'Venda')
      q = applyRespFilters(q)
      if (compradorTipologia) q = q.ilike('pref_tipologia', `%${compradorTipologia}%`)
      if (compradorOrcamentoMax !== null) q = q.lte('pref_orcamento_max', compradorOrcamentoMax)
      if (compradorOrcamentoMin !== null) q = q.gte('pref_orcamento_max', compradorOrcamentoMin)
      if (compradorZona) q = q.ilike('pref_zona', `%${compradorZona}%`)
      if (compradorOutros) q = q.ilike('pref_outros', `%${compradorOutros}%`)
      let refs = await queryRefsWithResp(q.order('pref_orcamento_max', { ascending: false, nullsFirst: false }))
      if (refsFromNotaLike) refs = refs.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) refs = refs.filter(r => refsFromOrigem!.has(r))
      refsOrdenados = refs
    } else if (semContactoMinDias !== null || semContactoMaxDias !== null) {
      const allRefsArrInit = await fetchAllOpps(sb, filters, tipoFiltro, estadoFiltro, applyRespFilters)
      let allRefsArr = allRefsArrInit
      if (needsWordBoundary && allRefsArr.length > 0) {
        const name = filters.responsavel_like as string
        const filtered: string[] = []
        for (let i = 0; i < allRefsArr.length; i += 500) {
          const chunk = allRefsArr.slice(i, i + 500)
          const { data: respData } = await sb.from('oportunidades').select('oportunidade_ref,responsavel').in('oportunidade_ref', chunk)
          for (const o of respData ?? []) {
            if (o.responsavel && matchesWordBoundary(o.responsavel as string, name)) filtered.push(o.oportunidade_ref as string)
          }
        }
        allRefsArr = filtered
      }
      if (semContactoMinDias !== null) {
        const cutoffMinStr = new Date(Date.now() - semContactoMinDias * 86400000).toISOString().slice(0, 10)
        const refsWithRecentContact = new Set<string>()
        for (let i = 0; i < allRefsArr.length; i += 500) {
          const chunk = allRefsArr.slice(i, i + 500)
          const { data: chunkNotas } = await sb.from('notas').select('oportunidade_ref').in('oportunidade_ref', chunk).gte('nota_data_iso', cutoffMinStr).not('nota_texto', 'ilike', 'Email enviado com os im%').not('nota_texto', 'ilike', 'Email successfully sent with properties%').limit(5000)
          if (chunkNotas) for (const n of chunkNotas) refsWithRecentContact.add(n.oportunidade_ref as string)
        }
        allRefsArr = allRefsArr.filter(r => !refsWithRecentContact.has(r))
      }
      if (semContactoMaxDias !== null) {
        const cutoffMaxStr = new Date(Date.now() - semContactoMaxDias * 86400000).toISOString().slice(0, 10)
        const refsWithContactWithinMax = new Set<string>()
        for (let i = 0; i < allRefsArr.length; i += 500) {
          const chunk = allRefsArr.slice(i, i + 500)
          const { data: chunkNotas } = await sb.from('notas').select('oportunidade_ref').in('oportunidade_ref', chunk).gte('nota_data_iso', cutoffMaxStr).not('nota_texto', 'ilike', 'Email enviado com os im%').not('nota_texto', 'ilike', 'Email successfully sent with properties%').limit(5000)
          if (chunkNotas) for (const n of chunkNotas) refsWithContactWithinMax.add(n.oportunidade_ref as string)
        }
        allRefsArr = allRefsArr.filter(r => refsWithContactWithinMax.has(r))
      }
      if (refsFromNotaLike) allRefsArr = allRefsArr.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) allRefsArr = allRefsArr.filter(r => refsFromOrigem!.has(r))
      refsOrdenados = allRefsArr
    } else if (usaFiltroPorTarefa || usaFiltroPorPreco) {
      let q = sb.from('oportunidades').select('oportunidade_ref,responsavel').eq('oportunidade_estado', estadoFiltro)
      if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro); q = applyRespFilters(q)
      if (precoMinimo !== null) q = q.gte('imovel_venda', precoMinimo); if (precoMaximo !== null) q = q.lte('imovel_venda', precoMaximo)
      let refs = await queryRefsWithResp(q)
      if (refsFromNotaLike) refs = refs.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) refs = refs.filter(r => refsFromOrigem!.has(r))
      if (usaFiltroPorTarefa) {
        if (filters.sem_tarefa === true) refs = refs.filter(r => !refsComQualquerTarefa!.has(r))
        else if (filters.tarefa_atrasada === true) refs = refs.filter(r => refsComTarefaAtrasada!.has(r))
        else if (filters.sem_tarefa_ou_atrasada === true) refs = refs.filter(r => !refsComTarefaFutura!.has(r))
      }
      refsOrdenados = refs
    } else if (refsFromOrigem && !usaFiltroPorData) {
      const { data: origemOrdered } = await sb.from('oportunidades').select('oportunidade_ref,ego_data_criacao').eq('oportunidade_estado', estadoFiltro).in('oportunidade_ref', [...refsFromOrigem].slice(0, 1000)).order('ego_data_criacao', { ascending: false }).limit(3000)
      refsOrdenados = (origemOrdered ?? []).map((o: Record<string, unknown>) => o.oportunidade_ref as string)
      if (refsFromNotaLike) refsOrdenados = refsOrdenados.filter(r => refsFromNotaLike!.has(r))
    } else if (refsFromNotaLike) {
      refsOrdenados = [...refsFromNotaLike].slice(0, 3000)
      if (refsFromOrigem) refsOrdenados = refsOrdenados.filter(r => refsFromOrigem!.has(r))
    } else if (usaFiltroPorData) {
      const refsSet = new Set<string>()
      const mkCutoff = (days: number): string => { const c = new Date(); c.setDate(c.getDate() - days); return c.toISOString().slice(0, 10) }
      const doCriado = criadoOuEditadoHoje || criadoHoje || criadoOuEditadoDias !== null || criadoDias !== null
      if (doCriado) {
        const cutoffStr = criadoOuEditadoDias !== null ? mkCutoff(criadoOuEditadoDias) : criadoDias !== null ? mkCutoff(criadoDias) : hoje
        let q = sb.from('oportunidades').select('oportunidade_ref,responsavel').eq('oportunidade_estado', estadoFiltro).gte('ego_data_criacao', cutoffStr)
        if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro); q = applyRespFilters(q)
        const refs = await queryRefsWithResp(q.limit(500))
        for (const r of refs) refsSet.add(r)
      }
      const doEditado = criadoOuEditadoHoje || editadoHoje || criadoOuEditadoDias !== null || editadoDias !== null
      if (doEditado) {
        const cutoffStr = criadoOuEditadoDias !== null ? mkCutoff(criadoOuEditadoDias) : editadoDias !== null ? mkCutoff(editadoDias) : hoje
        const cutoffTs = cutoffStr + 'T00:00:00.000Z'
        const { data: notasUser } = await sb.from('notas').select('oportunidade_ref').gte('criado_em', cutoffTs).not('nota_texto', 'ilike', 'Email enviado com os im%').not('nota_texto', 'ilike', 'Email successfully sent with properties%').limit(2000)
        for (const n of notasUser ?? []) refsSet.add(n.oportunidade_ref as string)
      }
      if (refsSet.size > 0) {
        let fq = sb.from('oportunidades').select('oportunidade_ref,responsavel').in('oportunidade_ref', [...refsSet].slice(0, 1000)).eq('oportunidade_estado', estadoFiltro)
        if (tipoFiltro) fq = fq.eq('tipo_oportunidade', tipoFiltro); fq = applyRespFilters(fq)
        const filtered = await queryRefsWithResp(fq.limit(500))
        refsSet.clear(); for (const r of filtered) refsSet.add(r)
      }
      refsOrdenados = [...refsSet]
      if (refsFromNotaLike) refsOrdenados = refsOrdenados.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) refsOrdenados = refsOrdenados.filter(r => refsFromOrigem!.has(r))
    } else if (tipoFiltro !== null || hasRespFilter || excluirCMI) {
      let q = sb.from('oportunidades').select('oportunidade_ref,responsavel').eq('oportunidade_estado', estadoFiltro)
      if (tipoFiltro) q = q.eq('tipo_oportunidade', tipoFiltro); q = applyRespFilters(q)
      if (propostaEstado) q = q.eq('estado_proposta', propostaEstado)
      else if (filters.has_proposta === true) q = q.not('estado_proposta', 'is', null)
      let refs = await queryRefsWithResp(q.order('ego_editado_em', { ascending: false, nullsFirst: false }))
      if (refsFromNotaLike) refs = refs.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) refs = refs.filter(r => refsFromOrigem!.has(r))
      refsOrdenados = refs
    } else if (propostaEstado || filters.has_proposta === true) {
      let q = sb.from('oportunidades').select('oportunidade_ref,responsavel').eq('oportunidade_estado', estadoFiltro)
      q = applyRespFilters(q)
      if (propostaEstado) q = q.eq('estado_proposta', propostaEstado)
      else q = q.not('estado_proposta', 'is', null)
      let refs = await queryRefsWithResp(q.order('ego_editado_em', { ascending: false, nullsFirst: false }))
      if (refsFromNotaLike) refs = refs.filter(r => refsFromNotaLike!.has(r))
      if (refsFromOrigem) refs = refs.filter(r => refsFromOrigem!.has(r))
      refsOrdenados = refs
    } else {
      const { data: notasRecentes } = await sb.from('notas').select('oportunidade_ref,nota_data_iso').not('nota_data_iso', 'is', null).order('nota_data_iso', { ascending: false }).limit(1500)
      refsOrdenados = []; const seenRefs = new Set<string>()
      for (const n of notasRecentes ?? []) { const ref = n.oportunidade_ref as string; if (!seenRefs.has(ref)) { seenRefs.add(ref); refsOrdenados.push(ref) } }
    }

    if (!refsOrdenados.length) return jsonResp({ results: [], total: 0, description: filters.description ?? '', has_more: false }, 200, cors)

    const PAGE_SIZE = rawExport ? Math.min(refsOrdenados.length, 500) : (mostrarQualidade ? 100 : 25)
    const totalRefs = refsOrdenados.length
    const hasMore = !rawExport && totalRefs > offset + PAGE_SIZE
    refsOrdenados = refsOrdenados.slice(offset, offset + PAGE_SIZE + (rawExport ? 0 : 5))

    const oppsResult: Record<string, unknown>[] = []
    for (let i = 0; i < refsOrdenados.length && oppsResult.length < PAGE_SIZE; i += 100) {
      const chunk = refsOrdenados.slice(i, i + 100)
      let q = sb.from('oportunidades').select(OPP_SELECT).in('oportunidade_ref', chunk)
      if (propostaEstado) q = q.eq('estado_proposta', propostaEstado)
      else if (filters.has_proposta === true) q = q.not('estado_proposta', 'is', null)
      if (filters.etapa_like) q = q.ilike('etapa_atual', `%${filters.etapa_like as string}%`)
      const { data: chunk_opps } = await q
      if (chunk_opps?.length) { for (const opp of chunk_opps) { if (oppsResult.length >= PAGE_SIZE) break; oppsResult.push(opp) } }
    }
    if (!oppsResult.length) return jsonResp({ results: [], total: 0, description: filters.description ?? '', has_more: false }, 200, cors)

    const refs = oppsResult.map(o => o.oportunidade_ref as string)
    const { data: todasNotas } = await sb.from('notas').select('oportunidade_ref,nota_texto,nota_data_iso,criado_em').in('oportunidade_ref', refs).order('nota_data_iso', { ascending: false, nullsFirst: false }).order('criado_em', { ascending: false }).limit(1000)
    const notasMap: Record<string, string[]> = {}; const ultimoContactoMap: Record<string, string> = {}
    for (const n of todasNotas ?? []) {
      const ref = n.oportunidade_ref as string; if (!notasMap[ref]) notasMap[ref] = []
      const texto = (n.nota_texto as string | null)?.trim() ?? null
      if (!texto || isTaskMarker(texto) || isSystemEmail(texto)) continue
      const notaDataISO = n.nota_data_iso as string | null; const criadoEM = n.criado_em as string | null; const criadoDateShort = criadoEM ? criadoEM.slice(5, 10).replace('-', '/') : null
      let dataLabel: string
      if (notaDataISO && criadoDateShort) { dataLabel = `[nota:${notaDataISO.slice(5).replace('-', '/')} escrita:${criadoDateShort}]` }
      else if (notaDataISO) { dataLabel = `[nota:${notaDataISO.slice(5).replace('-', '/')}]` }
      else if (criadoDateShort) { dataLabel = `[escrita:${criadoDateShort}]` }
      else { dataLabel = '' }
      const textoComData = dataLabel ? `${dataLabel} ${texto}` : texto
      if (notasMap[ref].length < 5 && !notasMap[ref].some(t => t.includes(texto.slice(0, 40)))) notasMap[ref].push(textoComData)
      if (!ultimoContactoMap[ref] && notaDataISO) ultimoContactoMap[ref] = notaDataISO
    }
    const { data: tarefas } = await sb.from('tarefas').select('oportunidade_ref,tarefa_titulo,tarefa_due_iso,tarefa_status').in('oportunidade_ref', refs).eq('tarefa_status', 'pendente').order('tarefa_due_iso', { ascending: true }).limit(200)
    const tarefasMap: Record<string, { titulo: string; due: string; atrasada: boolean; dias_atraso: number }> = {}
    for (const t of tarefas ?? []) {
      const ref = t.oportunidade_ref as string; if (tarefasMap[ref]) continue
      const due = t.tarefa_due_iso as string; const diasAtraso = due ? Math.floor((new Date(hoje).getTime() - new Date(due).getTime()) / 86400000) : 0
      tarefasMap[ref] = { titulo: t.tarefa_titulo as string, due, atrasada: due ? due < hoje : false, dias_atraso: diasAtraso > 0 ? diasAtraso : 0 }
    }
    const comNotas = oppsResult.filter(o => (notasMap[o.oportunidade_ref as string] ?? []).length > 0)
    const summaryMap: Record<string, string> = {}; const hotMap: Record<string, boolean> = {}; const relevanteMap: Record<string, boolean> = {}; const enganoMap: Record<string, boolean> = {}
    if (!rawExport) {
      for (let i = 0; i < comNotas.length; i += 12) {
        await summariseBatch(comNotas.slice(i, i + 12).map(o => ({ ref: o.oportunidade_ref as string, tipo: o.tipo_oportunidade as string, cliente: (o.cliente_nome as string) ?? '', etapa: (o.etapa_atual as string) ?? '', notas: (notasMap[o.oportunidade_ref as string] ?? []).join(' | '), preco: (o.imovel_venda as number) || (o.imovel_arrendamento as number) || null, preferencia: (o.preferencia_imovel as string) || null })), question, summaryMap, hotMap, relevanteMap, enganoMap)
      }
    }
    function origemLabel(o: Record<string, unknown>): string | null {
      const portal = (o.portal as string | null)?.trim(); const subOrigem = (o.sub_origem as string | null)?.trim(); const origem = (o.origem as string | null)?.trim()
      if (portal && portal !== 'null') return portal
      if (subOrigem && subOrigem !== 'null') { if (subOrigem.includes('Idealista')) return 'Idealista'; if (subOrigem.includes('SuperCasa') || subOrigem.includes('SUPERCASA')) return 'SuperCasa'; if (subOrigem.includes('Facebook') || subOrigem.includes('Instagram') || subOrigem.includes('figueirahome')) return 'Meta'; if (subOrigem.includes('Green-Acres') || subOrigem.includes('GreenAcres')) return 'Green-Acres'; if (subOrigem.includes('Imovirtual') || subOrigem.includes('ImoVirtual')) return 'Imovirtual'; if (subOrigem.includes('Casa Sapo') || subOrigem.includes('Sapo')) return 'Casa Sapo'; if (subOrigem.includes('Kyero')) return 'Kyero'; if (subOrigem.includes('OLX')) return 'OLX'; return subOrigem }
      if (origem && origem !== 'null') return origem; return null
    }
    const resultsRaw = oppsResult.map(o => { const ref = o.oportunidade_ref as string; return { ...o, summary: summaryMap[ref] ?? null, hot: hotMap[ref] ?? false, engano: enganoMap[ref] ?? false, relevante: relevanteMap[ref] ?? true, notas_preview: (notasMap[ref] ?? []).slice(0, 2), ultimo_contacto: ultimoContactoMap[ref] ?? null, tarefa: tarefasMap[ref] ?? null, origem_label: origemLabel(o) } })
    const results = tagOwnership(resultsRaw)
    if (!rawExport) results.sort((a, b) => { if (a.engano !== b.engano) return a.engano ? 1 : -1; if (a.hot !== b.hot) return b.hot ? 1 : -1; return (b.ultimo_contacto ?? '0000-00-00').localeCompare(a.ultimo_contacto ?? '0000-00-00') })
    const hotCount = results.filter(r => r.hot && !r.engano).length; const enganoCount = results.filter(r => r.engano).length; const coldCount = results.length - hotCount - enganoCount
    const quality_stats = { total: results.length, total_analisado: comNotas.length, hot: hotCount, cold: coldCount, engano: enganoCount, sem_notas: results.length - results.filter(r => (notasMap[r.oportunidade_ref as string] ?? []).length > 0).length, quality_pct: results.length > 0 ? Math.round((hotCount / results.length) * 100) : 0, engano_pct: results.length > 0 ? Math.round((enganoCount / results.length) * 100) : 0 }
    return jsonResp({ results, total: results.length, description: filters.description ?? '', mostrar_qualidade: mostrarQualidade, quality_stats, origem_cat: origemCat, has_more: hasMore, total_refs: totalRefs, offset }, 200, cors)
  } catch (err) {
    console.error('Unhandled error:', err)
    return jsonResp({ error: String(err) }, 500, cors)
  }
})
