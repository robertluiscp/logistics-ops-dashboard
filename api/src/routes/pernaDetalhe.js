const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// GET /api/pernas/:id/pacotes -- pacotes de UMA perna (parada), lidos do
// proprio banco (tabela `pacotes`, gravada pelo ETL a cada ciclo). Cada
// pacote traz o status ja' decidido pelo ETL:
//   Recebido | Candidato a Expedido não chegou | Pacote Voando
//
// Numa edicao conectada a um sistema externo, esta rota pode ser trocada por
// uma consulta ao vivo a essa fonte (1 viagem por vez, sob demanda) sem
// mudar o contrato de resposta abaixo -- o frontend so' conhece este formato.
router.get("/:id/pacotes", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: pernas } = await pool.query(
      `SELECT p.shipment_no, p.tipo_perna,
              bo.nome AS base_origem_nome, bd.nome AS base_destino_nome
       FROM pernas p
       LEFT JOIN bases bo ON bo.codigo = p.base_origem_codigo
       LEFT JOIN bases bd ON bd.codigo = p.base_destino_codigo
       WHERE p.id = $1`,
      [id]
    );
    if (!pernas.length) return res.status(404).json({ erro: "Perna não encontrada." });
    const perna = pernas[0];

    const { rows } = await pool.query(
      `SELECT pa.bill_code, pa.next_station_codigo, pa.carregado_em, pa.latest_scan_time, pa.status,
              b.nome AS destino_nome
       FROM pacotes pa
       LEFT JOIN bases b ON b.codigo = pa.next_station_codigo
       WHERE pa.perna_id = $1
       ORDER BY pa.status, pa.bill_code
       LIMIT 20000`,
      [id]
    );

    const pacotes = rows.map((r) => ({
      bill_code: r.bill_code,
      pacote_codigo: null,
      destino_previsto: r.destino_nome || r.next_station_codigo || null,
      digitalizado_por: null,
      carregado_em: r.carregado_em,
      chegou_em: r.status === "Candidato a Expedido não chegou" ? null : r.latest_scan_time,
      status: r.status,
    }));

    res.json({
      perna: {
        shipment_no: perna.shipment_no,
        tipo_perna: perna.tipo_perna,
        base_origem_nome: perna.base_origem_nome,
        base_destino_nome: perna.base_destino_nome,
      },
      total_carregado: pacotes.filter((p) => p.status !== "Pacote Voando").length,
      total_descarregado: pacotes.filter((p) => p.status !== "Candidato a Expedido não chegou").length,
      pacotes,
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao buscar pacotes da perna." });
  }
});

module.exports = router;
