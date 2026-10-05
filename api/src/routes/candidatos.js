const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// GET /api/candidatos -- fila de "Expedido não chegou".
//
// Filtro de janela (2026-09-09): so' mostra candidatos com ate' 3 dias
// (2 dias de janela de rastreio do ETL + 1 de folga) -- sem isso, um
// candidato cujo shipment_no saiu da janela de extracao (troncal.py/
// secundaria.py so' pegam ate' 2 dias atras) nunca mais era reconferido e
// ficava "preso" pra sempre, mesmo ja tendo chegado ha muito tempo na
// vida real. Chegou a acumular 27137 linhas (97,8% com mais de 3 dias,
// algumas de 13 dias atras) e travava a aba inteira. Ver
// etl/reconciliar_candidatos_antigos.py pra' limpeza do que ja' tinha
// acumulado -- esse filtro aqui so' evita reacumular.
//
// Ordenacao (2026-09-09): "dentro do prazo" primeiro (mais urgente = vence
// primeiro), "fora do prazo" depois -- antes era so' prazo_limite ASC, que
// colocava os JA' vencidos ha mais tempo no topo, escondendo os que ainda
// da' tempo de agir.
router.get("/", async (_req, res) => {
  const sql = `
    SELECT
      pac.bill_code, pac.shipment_no, p.tipo_perna,
      bo.nome AS base_origem_nome, bd.nome AS base_destino_nome,
      pac.candidato_desde, p.hora_deslacre, p.prazo_limite,
      EXTRACT(EPOCH FROM (p.prazo_limite - now())) / 3600 AS horas_restantes,
      (p.prazo_limite >= now()) AS dentro_do_prazo,
      pac.status
    FROM pacotes pac
    JOIN pernas p ON p.id = pac.perna_id
    LEFT JOIN bases bo ON bo.codigo = pac.network_code_esperado
    LEFT JOIN bases bd ON bd.codigo = pac.next_station_codigo
    WHERE pac.status = 'Candidato a Expedido não chegou'
      AND pac.candidato_desde >= now() - interval '3 days'
    ORDER BY (p.prazo_limite < now()) ASC NULLS LAST, p.prazo_limite ASC NULLS LAST
  `;

  try {
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar candidatos." });
  }
});

module.exports = router;
