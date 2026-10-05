const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Dropoff (Pudo) & C2C (2026-09-11).
//   pudo -- tudo bipado nos pontos de coleta parceiros. Volume altíssimo
//           (~15-30 mil/dia) -- só janela rolante de ~15 dias na tabela,
//           então aqui devolvemos AGREGADOS (não a lista bruta inteira,
//           inviável pro navegador) + uma lista limitada dos mais recentes.
//   c2c  -- pedidos individual-pra-individual, volume baixo. Lista bruta
//           normal (igual candidatos/tickets), com o prazo final já
//           calculado no ETL via abrangencia_prazos.
const JANELA_PADRAO_DIAS = 15;

// ---------------------------------------------------------------------------
// GET /api/dropoff/pudo/resumo?de=&ate=
// ---------------------------------------------------------------------------
router.get("/pudo/resumo", async (req, res) => {
  const de = req.query.de || null;
  const ate = req.query.ate || null;
  const params = [de, ate];
  const filtro = `enter_time >= COALESCE($1::date, now() - interval '${JANELA_PADRAO_DIAS} days')
                  AND enter_time < COALESCE($2::date, now()::date) + interval '1 day'`;

  try {
    const [total, porDia, porCidade, porOrigem, porPudo, porStatus, porCliente, tempoColeta] = await Promise.all([
      // "pontos" = bases (pick_network_name); "dropoffs" = pontos físicos de
      // coleta de verdade, identificados pelo "Nome do site" (station_name).
      pool.query(
        `SELECT count(*)::int AS total,
                count(DISTINCT pick_network_name)::int AS pontos,
                count(DISTINCT station_name)::int AS dropoffs
         FROM pudo_coletas WHERE ${filtro}`,
        params
      ),
      pool.query(`SELECT enter_time::date AS dia, count(*)::int AS qtd FROM pudo_coletas WHERE ${filtro} GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT COALESCE(city,'—') AS city, count(*)::int AS qtd FROM pudo_coletas WHERE ${filtro} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, params),
      pool.query(`SELECT COALESCE(order_source_name,'—') AS origem, count(*)::int AS qtd FROM pudo_coletas WHERE ${filtro} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, params),
      // "Quantidade de pacotes por Pudo" -- por Nome do Site (station_name),
      // não pela base (pick_network_name pode ter vários sites dentro dela).
      pool.query(`SELECT COALESCE(station_name,'—') AS site, count(*)::int AS qtd FROM pudo_coletas WHERE ${filtro} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, params),
      // "Funil de status" (2026-09-17) -- traduz o order_type_export (vem
      // em chinês do LMS) pra PT direto na query, já existia essa coluna
      // gravada mas nunca tinha virado UI.
      pool.query(
        `SELECT CASE order_type_export
                  WHEN '已揽收' THEN 'Coletado'
                  WHEN '已入库待揽收' THEN 'Aguardando coleta'
                  WHEN '待支付' THEN 'Aguardando pagamento'
                  WHEN '待打印' THEN 'Aguardando impressão'
                  ELSE COALESCE(NULLIF(order_type_export, ''), '—')
                END AS status,
                count(*)::int AS qtd
         FROM pudo_coletas WHERE ${filtro} GROUP BY 1 ORDER BY 2 DESC`,
        params
      ),
      // "Top clientes" (2026-09-17) -- so' o codigo existe no dado (sem nome
      // amigavel do cliente gravado), mas ja' identifica concentracao.
      pool.query(
        `SELECT COALESCE(customer_code,'—') AS cliente, count(*)::int AS qtd
         FROM pudo_coletas WHERE ${filtro} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
        params
      ),
      // "Tempo médio até coleta" (2026-09-17) -- gap entre a confirmação do
      // pedido (input_time) e a entrada de fato no ponto Pudo (enter_time).
      // Filtra os poucos registros com enter_time < input_time (~8 de 260mil
      // no teste, provável correção/re-scan) -- não é tempo negativo de
      // verdade, entraria como ruído na média.
      pool.query(
        `SELECT avg(EXTRACT(EPOCH FROM (enter_time - input_time)) / 3600.0) AS horas_medias
         FROM pudo_coletas
         WHERE ${filtro} AND input_time IS NOT NULL AND enter_time >= input_time`,
        params
      ),
    ]);
    res.json({
      total: total.rows[0],
      por_dia: porDia.rows,
      por_cidade: porCidade.rows,
      por_origem: porOrigem.rows,
      por_pudo: porPudo.rows,
      por_status: porStatus.rows,
      por_cliente: porCliente.rows,
      tempo_medio_coleta_horas: tempoColeta.rows[0].horas_medias !== null ? Number(tempoColeta.rows[0].horas_medias) : null,
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar resumo do Pudo." });
  }
});

// GET /api/dropoff/pudo?limit=500 -- últimos N bipados, pra tabela de detalhe
router.get("/pudo", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  try {
    const { rows } = await pool.query(
      `SELECT order_no, billcode, order_source_name, mail_name, input_time, enter_time,
              pick_agent_name, pick_network_name, station_name, province, city,
              order_type_export, goods_name, customer_code
       FROM pudo_coletas
       ORDER BY enter_time DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar Pudo." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dropoff/c2c?de=&ate=
// Volume baixo -- lista bruta (mesmo padrão de /api/candidatos e /api/tickets).
// ---------------------------------------------------------------------------
router.get("/c2c", async (req, res) => {
  const de = req.query.de || null;
  const ate = req.query.ate || null;

  const sql = `
    SELECT
      id, order_id, waybill_no, order_source_code, order_source_name, pick_network_name,
      origin_name, origin_province, dispatch_network_name,
      destination_name, destination_province,
      package_number, goods_type_name, waybill_weight,
      input_time, collect_time, is_sign, is_sign_name, sign_time,
      latest_scan_type_name, latest_scan_network_name, latest_scan_time,
      prazo_dias, prazo_limite, abrangencia_encontrada,
      EXTRACT(EPOCH FROM (prazo_limite - now())) / 3600 AS horas_restantes,
      (prazo_limite IS NOT NULL AND prazo_limite >= now()) AS dentro_do_prazo,
      atualizado_em
    FROM c2c_pedidos
    WHERE input_time >= COALESCE($1::date, now() - interval '${JANELA_PADRAO_DIAS} days')
      AND input_time < COALESCE($2::date, now()::date) + interval '1 day'
    ORDER BY input_time DESC
  `;

  try {
    const { rows } = await pool.query(sql, [de, ate]);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar C2C." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dropoff/c2c/ranking-pudo?de=&ate=
// Ranking de "qual Pudo fez esse C2C". Tentativa 1 (2026-09-17, descartada)
// cruzava c2c_pedidos.numero_encomenda_interna com pudo_coletas.order_no --
// funcionava mal porque as janelas rolantes de C2C e Pudo tem alcances
// diferentes, deixando muito pedido "sem correspondencia".
// Tentativa 2 (2026-09-17, correta -- pedido direto do usuario): nao
// precisa cruzar nada -- o PROPRIO relatorio do Pudo ja diz a origem de
// cada pacote que ele coletou ("Origem do Pedido"/order_source_name). Os
// 4 valores que so' existem quando o pedido foi feito diretamente pelo
// Pudo (site oficial, app, web, H5 -- nao marketplaces externos, que sao os
// outros ~95% do volume do Pudo) identificam exatamente os C2C feitos
// pelo Pudo, e o station_name da MESMA linha ja diz qual Pudo foi. Filtra
// por enter_time (mesmo campo que o resto da aba Pudo usa), nao input_time
// do C2C -- esse relatorio NUNCA usa c2c_pedidos.
// ---------------------------------------------------------------------------
const ORIGENS_C2C_NO_PUDO = ["Official Site", "Partner App", "Partner Web", "Official H5"];

router.get("/c2c/ranking-pudo", async (req, res) => {
  const de = req.query.de || null;
  const ate = req.query.ate || null;

  try {
    const { rows: ranking } = await pool.query(
      `SELECT station_name, count(*)::int AS qtd
       FROM pudo_coletas
       WHERE order_source_name = ANY($3::text[])
         AND enter_time >= COALESCE($1::date, now() - interval '${JANELA_PADRAO_DIAS} days')
         AND enter_time < COALESCE($2::date, now()::date) + interval '1 day'
       GROUP BY station_name
       ORDER BY qtd DESC
       LIMIT 20`,
      [de, ate, ORIGENS_C2C_NO_PUDO]
    );
    const total = ranking.reduce((soma, r) => soma + r.qtd, 0);
    res.json({ total, ranking });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar ranking de C2C por Pudo." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dropoff/pudo/mensal e /api/dropoff/c2c/mensal -- referencia de
// "outros meses" (2026-09-15), separado da janela rolante de 30 dias.
// Vem das tabelas pudo_mensal/c2c_mensal, preenchidas por run_mensal.py
// (mes atual + mes passado por enquanto -- ver comentario la' sobre por
// que nao da' pra confiar em meses mais antigos via API ao vivo).
// ---------------------------------------------------------------------------
router.get("/pudo/mensal", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT mes, total_pacotes, total_dropoffs, bases_ativas, atualizado_em FROM pudo_mensal ORDER BY mes"
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar agregados mensais do Pudo." });
  }
});

router.get("/c2c/mensal", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT mes, total_pedidos, atualizado_em FROM c2c_mensal ORDER BY mes"
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar agregados mensais do C2C." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dropoff/c2c/hoje -- hoje/ontem SEMPRE (independente do filtro de
// data escolhido pro resto da tela, 2026-09-14) -- alimenta o card "pedidos
// hoje"/"evolução" e o gauge "Meta x Realizado" (meta fixa por dia, ver
// app.js). Calculado no banco (input_time::date, tz da sessao ja' e'
// America/Sao_Paulo) em vez de bucketing no cliente.
// ---------------------------------------------------------------------------
router.get("/c2c/hoje", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        count(*) FILTER (WHERE input_time::date = CURRENT_DATE)::int AS hoje,
        count(*) FILTER (WHERE input_time::date = CURRENT_DATE - 1)::int AS ontem
      FROM c2c_pedidos
    `);
    res.json(rows[0]);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar C2C de hoje." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dropoff/execucoes?relatorio=pudo|c2c&limit=10
// Mesmo padrão de /api/taxas-expedicao/execucoes -- visibilidade de falha
// parcial no painel.
// ---------------------------------------------------------------------------
router.get("/execucoes", async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const relatorio = ["pudo", "c2c"].includes(req.query.relatorio) ? req.query.relatorio : null;

  try {
    const { rows } = await pool.query(
      `SELECT id, relatorio, iniciado_em, finalizado_em, status, linhas_gravadas, erro_mensagem, duracao_segundos
       FROM execucoes_dropoff
       WHERE ($1::text IS NULL OR relatorio = $1)
       ORDER BY iniciado_em DESC
       LIMIT $2`,
      [relatorio, limit]
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar execuções do Dropoff/C2C." });
  }
});

module.exports = router;
