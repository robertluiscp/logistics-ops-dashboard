const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Os 3 indicadores de "taxa de expedição no prazo" importados do LMS
// (tabela taxas_expedicao, alimentada por etl/run_taxas.py a cada 3h,
// self-heal dos últimos 3 dias operacionais).
//   sc_hub  -- SC despachou rumo ao HUB no prazo (por SC)
//   sc_sc   -- SC despachou pra frente no prazo (por SC, + detalhes)
//   hub_pdd -- HUB despachou pro ponto de entrega no prazo (por par SC->DC)
const TIPOS = new Set(["sc_hub", "sc_sc", "hub_pdd"]);
const META_PADRAO = 0.9;

function tipoValido(t) {
  return TIPOS.has(t) ? t : "sc_hub";
}

// ---------------------------------------------------------------------------
// GET /api/taxas-expedicao?tipo=sc_hub&de=2026-08-01&ate=2026-09-10
// Linhas cruas do indicador, mais recente primeiro. Sem intervalo -> 30 dias.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const tipo = tipoValido(req.query.tipo);
  const ate = req.query.ate || null;
  const de = req.query.de || null;

  const sql = `
    SELECT data::text AS data, tipo, regional_codigo, regional_nome,
           sc_codigo, sc_nome, dc_codigo, dc_nome,
           qtd_total, qtd_no_prazo, qtd_fora_prazo, taxa,
           qtd_sem_viagem, qtd_sem_rota, qtd_sem_chegada, qtd_destino_errado,
           bilhetes_op_habil, qtd_sem_shift, qtd_anomalia, qtd_falta_cod_2seg,
           atualizado_em
    FROM taxas_expedicao
    WHERE tipo = $1
      AND data >= COALESCE($2::date, now()::date - interval '30 days')
      AND data <= COALESCE($3::date, now()::date)
    ORDER BY data DESC, sc_nome, dc_nome
  `;

  try {
    const { rows } = await pool.query(sql, [tipo, de, ate]);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar taxa de expedição." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/taxas-expedicao/consolidado?tipo=sc_hub&granularidade=dia
//
// Visão "mais completa que o LMS": uma matriz SC x período com a taxa
// AGREGADA (soma no_prazo / soma total, ponderada por volume -- não média
// de médias) de cada bucket, + a série diária pro gráfico de tendência.
//
// granularidade: "mes" (últimos 6) | "semana" (últimas 8) | "dia" (últimos 15)
// ---------------------------------------------------------------------------
// qtd = quantos buckets (colunas) a matriz mostra pra cada granularidade.
const GRAN = { mes: 6, semana: 8, dia: 15 };
// Sempre puxa a mesma janela ampla do banco (cobre "mês atual" mesmo no
// fim do mês e os 6 meses da visão mensal). `serie_diaria` vai com ~45 dias
// pros KPIs ("mês atual"/"últimos 7 dias") ficarem certos; o gráfico em si
// recorta os últimos 15 dias no front (foco na atualidade). A matriz mostra
// os últimos `GRAN[gran]` buckets.
const DIAS_JANELA = 210;
const DIAS_SERIE_GRAFICO = 45;

function chaveBucket(dataIso, gran) {
  const d = new Date(dataIso + "T00:00:00Z");
  if (gran === "mes") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (gran === "semana") {
    // semana ISO (segunda a domingo)
    const alvo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dia = (alvo.getUTCDay() + 6) % 7; // 0 = segunda
    alvo.setUTCDate(alvo.getUTCDate() - dia + 3); // quinta da mesma semana
    const primeiraQuinta = new Date(Date.UTC(alvo.getUTCFullYear(), 0, 4));
    const semana =
      1 + Math.round(((alvo - primeiraQuinta) / 86400000 - 3 + ((primeiraQuinta.getUTCDay() + 6) % 7)) / 7);
    return `${alvo.getUTCFullYear()}-W${String(semana).padStart(2, "0")}`;
  }
  return dataIso; // dia
}

function rotuloBucket(chave, gran) {
  if (gran === "mes") {
    const [ano, mes] = chave.split("-");
    const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
  }
  if (gran === "semana") {
    return chave.replace("-W", " S");
  }
  const [, mes, dia] = chave.split("-");
  return `${dia}/${mes}`;
}

router.get("/consolidado", async (req, res) => {
  const tipo = tipoValido(req.query.tipo);
  const gran = GRAN[req.query.granularidade] ? req.query.granularidade : "dia";
  const qtdColunas = GRAN[gran];

  try {
    const { rows } = await pool.query(
      `SELECT data::text AS data, sc_codigo, sc_nome, dc_codigo, dc_nome,
              qtd_total, qtd_no_prazo
       FROM taxas_expedicao
       WHERE tipo = $1 AND data >= now()::date - ($2 || ' days')::interval
       ORDER BY data`,
      [tipo, DIAS_JANELA]
    );

    const ehPar = tipo === "hub_pdd";
    const idLinha = (r) => (ehPar ? `${r.sc_codigo}␟${r.dc_codigo}` : r.sc_codigo);

    // buckets presentes, ordenados no tempo, limitados aos N mais recentes
    const bucketsVistos = new Map(); // chave -> data mais recente vista
    for (const r of rows) {
      const c = chaveBucket(r.data, gran);
      if (!bucketsVistos.has(c) || r.data > bucketsVistos.get(c)) bucketsVistos.set(c, r.data);
    }
    const colunas = [...bucketsVistos.keys()]
      .sort()
      .slice(-qtdColunas)
      .map((chave) => ({ chave, rotulo: rotuloBucket(chave, gran) }));
    const colunasSet = new Set(colunas.map((c) => c.chave));

    // acumula por linha x bucket e por linha (geral) e por bucket (rodapé)
    const linhas = new Map();
    const rodape = {}; // chave bucket -> {total, no_prazo}
    const serieDiaria = {}; // data -> {total, no_prazo}

    for (const r of rows) {
      const cB = chaveBucket(r.data, gran);
      const total = r.qtd_total || 0;
      const noPrazo = r.qtd_no_prazo || 0;

      // série diária (sempre, independente da granularidade)
      (serieDiaria[r.data] ||= { total: 0, no_prazo: 0 });
      serieDiaria[r.data].total += total;
      serieDiaria[r.data].no_prazo += noPrazo;

      if (!colunasSet.has(cB)) continue;

      const id = idLinha(r);
      let L = linhas.get(id);
      if (!L) {
        L = {
          sc_codigo: r.sc_codigo, sc_nome: r.sc_nome,
          dc_codigo: ehPar ? r.dc_codigo : null, dc_nome: ehPar ? r.dc_nome : null,
          celulas: {}, geral: { total: 0, no_prazo: 0 },
        };
        linhas.set(id, L);
      }
      (L.celulas[cB] ||= { total: 0, no_prazo: 0 });
      L.celulas[cB].total += total;
      L.celulas[cB].no_prazo += noPrazo;
      L.geral.total += total;
      L.geral.no_prazo += noPrazo;

      (rodape[cB] ||= { total: 0, no_prazo: 0 });
      rodape[cB].total += total;
      rodape[cB].no_prazo += noPrazo;
    }

    const comTaxa = (o) => ({
      ...o,
      taxa: o.total > 0 ? o.no_prazo / o.total : null,
    });

    const linhasArr = [...linhas.values()]
      .map((L) => ({
        sc_codigo: L.sc_codigo, sc_nome: L.sc_nome,
        dc_codigo: L.dc_codigo, dc_nome: L.dc_nome,
        celulas: Object.fromEntries(Object.entries(L.celulas).map(([k, v]) => [k, comTaxa(v)])),
        geral: comTaxa(L.geral),
      }))
      .sort((a, b) =>
        (a.sc_nome || "").localeCompare(b.sc_nome || "") ||
        (a.dc_nome || "").localeCompare(b.dc_nome || "")
      );

    const rodapeGeral = { total: 0, no_prazo: 0 };
    for (const v of Object.values(rodape)) {
      rodapeGeral.total += v.total;
      rodapeGeral.no_prazo += v.no_prazo;
    }

    const serie = Object.entries(serieDiaria)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([data, v]) => ({ data, ...comTaxa(v) }))
      .slice(-DIAS_SERIE_GRAFICO);

    res.json({
      tipo,
      granularidade: gran,
      meta: META_PADRAO,
      colunas,
      linhas: linhasArr,
      rodape: {
        celulas: Object.fromEntries(colunas.map((c) => [c.chave, comTaxa(rodape[c.chave] || { total: 0, no_prazo: 0 })])),
        geral: comTaxa(rodapeGeral),
      },
      serie_diaria: serie,
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consolidar taxa de expedição." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/taxas-expedicao/execucoes?limit=10
// Log do run_taxas.py (execucoes_taxas) -- dá visibilidade de falha parcial
// no painel. Antes disso (2026-09-11) uma falha num relatório específico
// ficava invisível até alguém notar um buraco no gráfico: a scheduled task
// não tem saída capturada em lugar nenhum, só o run.py tinha esse log
// (execucoes_etl).
// ---------------------------------------------------------------------------
router.get("/execucoes", async (req, res) => {
  const limit = Number(req.query.limit) || 10;

  try {
    const { rows } = await pool.query(
      `SELECT id, iniciado_em, finalizado_em, status, dias_alvo,
              linhas_gravadas, falhas, duracao_segundos, erro_mensagem
       FROM execucoes_taxas
       ORDER BY iniciado_em DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar execuções da taxa de expedição." });
  }
});

module.exports = router;
