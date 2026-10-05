const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Tickets de reclamação do SAC (tabela tickets_reclamacao, snapshot dos que
// ainda estão EM ABERTO -- alimentada por etl/run_tickets.py).
//   comum      -> clientes comuns (Client A, Client B, Client C...)
//   plataforma -> exclusivo Marketplace
// Prazo de tratamento já vem calculado do ETL (comum +24h; plataforma +12h
// se [PRIORITY], senão +48h). Aqui só devolvemos as linhas + campos derivados
// de tempo; os cards de contagem e o relógio regressivo são no front.
const TIPOS = new Set(["comum", "plataforma"]);

// GET /api/tickets?tipo=comum
router.get("/", async (req, res) => {
  const tipo = TIPOS.has(req.query.tipo) ? req.query.tipo : "comum";

  const sql = `
    SELECT
      id, tipo, work_order_no, waybill_no, canal,
      tipo_i_nome, tipo_ii_nome, eh_priority, descricao_problema,
      status_nome, estacao_aceitacao, regional_aceitacao,
      cliente_nome, responsavel_nome, is_last_mile,
      data_registro, horas_sla, prazo_limite,
      EXTRACT(EPOCH FROM (prazo_limite - now())) / 3600 AS horas_restantes,
      (prazo_limite >= now())                          AS dentro_do_prazo,
      (prazo_limite::date = CURRENT_DATE)              AS vence_hoje,
      (prazo_limite <  date_trunc('day', now()) + interval '12 hours') AS antes_meio_dia,
      atualizado_em
    FROM tickets_reclamacao
    WHERE tipo = $1
    ORDER BY prazo_limite ASC
  `;

  try {
    const { rows } = await pool.query(sql, [tipo]);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar tickets." });
  }
});

module.exports = router;
