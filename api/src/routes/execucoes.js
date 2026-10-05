const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// GET /api/execucoes?limit=20 -- historico do ciclo automatico (execucoes_etl),
// mais recente primeiro. Existe pra dar pra ver no proprio painel se o
// Task Scheduler esta rodando saudavel, sem precisar abrir terminal.
router.get("/", async (req, res) => {
  const { limit = 20 } = req.query;

  const sql = `
    SELECT id, iniciado_em, finalizado_em, duracao_segundos, status, erro_mensagem,
           pernas_total, pacotes_total, pacotes_voando, candidatos_total,
           candidatos_perto_prazo, xlsx_gerado
    FROM execucoes_etl
    ORDER BY iniciado_em DESC
    LIMIT $1
  `;

  try {
    const { rows } = await pool.query(sql, [Number(limit)]);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar execuções." });
  }
});

module.exports = router;
