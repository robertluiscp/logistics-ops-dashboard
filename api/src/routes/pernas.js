const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// GET /api/pernas?tipo=troncal|secundaria&etapa=Concluído&limit=500
//
// Default de 1000 usado ate 2026-08-31 truncava silenciosamente a lista --
// Secundaria sozinha ja tinha 3567 pernas (limit cortava ~72% sem nenhum
// aviso na tela, ORDER BY atualizado_em DESC escondia justamente as mais
// antigas). Subido pra 50000 (bem acima de qualquer volume real hoje) ate
// existir paginacao de verdade -- ver docs/ENGINEERING_NOTES.md.
router.get("/", async (req, res) => {
  const { tipo, etapa, estado, limit = 50000 } = req.query;

  const condicoes = [];
  const valores = [];

  if (tipo) {
    valores.push(tipo);
    condicoes.push(`p.tipo_perna = $${valores.length}`);
  }
  if (etapa) {
    valores.push(etapa);
    condicoes.push(`p.etapa = $${valores.length}`);
  }
  if (estado) {
    valores.push(estado);
    condicoes.push(`(bo.provincia = $${valores.length} OR bd.provincia = $${valores.length})`);
  }

  const whereSql = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
  valores.push(Number(limit));

  const sql = `
    SELECT
      p.id, p.shipment_no, p.tipo_perna, p.shipment_name,
      bo.codigo AS base_origem_codigo, bo.nome AS base_origem_nome,
      bd.codigo AS base_destino_codigo, bd.nome AS base_destino_nome,
      p.placa, p.modelo_veiculo, p.transportador, p.motorista, p.mileage,
      p.hora_lacre, p.hora_deslacre,
      p.planejado_partida, p.planejado_chegada, p.partida_real, p.chegada_real,
      p.etapa, p.prazo_limite,
      -- Direto da fonte de dados (only_loaded/only_unloaded do resumo por viagem,
      -- capturado a partir de 2026-09-14) -- mesmas colunas "Carregado mas
      -- nao descarregado" / "Descarregado mas nao carregado" que a tela
      -- "Registros de carga e descarga" do LMS mostra.
      p.carregado_nao_descarregado, p.descarregado_nao_carregado,
      -- Perna ja' chegou (etapa Concluido) mas nunca recebeu o bipe de
      -- Deslacre do Veiculo -- achado em 2026-09-14 investigando com o
      -- usuario (30% das pernas Secundarias concluidas num dia tinham
      -- esse gap). Sem deslacre nao da' pra saber quando a janela de 6h
      -- comecou, entao prazo_limite fica NULL e nenhum candidato e' gerado
      -- pra essa perna -- o pacote continua sendo processado normalmente
      -- (carga/processado acima), so' o relogio de prazo que nao existe.
      (p.etapa = 'Concluído' AND p.hora_deslacre IS NULL) AS sem_deslacre,
      -- "Pacote Voando" fica fora da Carga -- ele nao foi carregado por
      -- essa perna (chegou sem estar no manifesto), entao nao conta como
      -- carga esperada, so aparece na coluna propria abaixo.
      --
      -- Carga/Processado: prefere a contagem PRECISA (join com pacotes,
      -- so' existe pra Em Descarregamento) quando disponivel; cai pra
      -- contagem AGREGADA (p.carga_total/p.qtd_processada, preenchida pra
      -- qualquer etapa exceto Planejado/Cancelado) quando nao ha' pacote
      -- nenhum vinculado. Checa se existe QUALQUER pacote (nao so' se o
      -- valor filtrado e' zero) -- senao uma perna com qtd_processada
      -- precisa genuinamente 0 cairia pro agregado por engano. Ver
      -- docs/ENGINEERING_NOTES.md.
      CASE WHEN COUNT(pac.bill_code) > 0
        THEN COUNT(pac.bill_code) FILTER (WHERE pac.status != 'Pacote Voando')::int
        ELSE p.carga_total
      END AS carga_total,
      CASE WHEN COUNT(pac.bill_code) > 0
        THEN COUNT(pac.bill_code) FILTER (WHERE pac.status = 'Recebido')::int
        ELSE p.qtd_processada
      END AS qtd_processada,
      COUNT(pac.bill_code) FILTER (WHERE pac.status = 'Candidato a Expedido não chegou')::int AS qtd_candidatos,
      COUNT(pac.bill_code) FILTER (WHERE pac.status = 'Pacote Voando')::int AS qtd_voando,
      p.atualizado_em
    FROM pernas p
    LEFT JOIN bases bo ON bo.codigo = p.base_origem_codigo
    LEFT JOIN bases bd ON bd.codigo = p.base_destino_codigo
    LEFT JOIN pacotes pac ON pac.perna_id = p.id
    ${whereSql}
    GROUP BY p.id, bo.codigo, bo.nome, bd.codigo, bd.nome
    ORDER BY p.atualizado_em DESC
    LIMIT $${valores.length}
  `;

  try {
    const { rows } = await pool.query(sql, valores);
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar pernas." });
  }
});

module.exports = router;
