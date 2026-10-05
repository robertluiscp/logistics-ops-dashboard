const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// GET /api/pacotes?status=Candidato a Expedido não chegou&shipment_no=DKGX...
router.get("/", async (req, res) => {
  const { status, shipment_no, limit = 2000 } = req.query;

  const condicoes = [];
  const valores = [];

  if (status) {
    valores.push(status);
    condicoes.push(`pac.status = $${valores.length}`);
  }
  if (shipment_no) {
    valores.push(shipment_no);
    condicoes.push(`pac.shipment_no = $${valores.length}`);
  }

  const whereSql = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
  valores.push(Number(limit));

  const sql = `
    SELECT
      pac.bill_code, pac.shipment_no, p.tipo_perna,
      bo.nome AS base_origem_nome, bd.nome AS base_destino_nome,
      pac.status, pac.candidato_desde, pac.xlsx_exportado_em,
      pac.is_abnormal, pac.motivo_confirmado_lms, pac.registrado_em_lms,
      br.nome AS base_registro_lms_nome, pac.responsavel,
      p.prazo_limite,
      pac.atualizado_em
    FROM pacotes pac
    LEFT JOIN pernas p ON p.id = pac.perna_id
    LEFT JOIN bases bo ON bo.codigo = pac.network_code_esperado
    LEFT JOIN bases bd ON bd.codigo = pac.next_station_codigo
    LEFT JOIN bases br ON br.codigo = pac.base_registro_lms_codigo
    ${whereSql}
    ORDER BY pac.candidato_desde ASC NULLS LAST, pac.atualizado_em DESC
    LIMIT $${valores.length}
  `;

  try {
    const { rows } = await pool.query(sql, valores);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar pacotes." });
  }
});

module.exports = router;
