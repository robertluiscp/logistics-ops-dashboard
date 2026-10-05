const express = require("express");
const { pool } = require("../db");

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT codigo, nome, tipo, modelo_negocio, provincia, tipo_funcao FROM bases ORDER BY nome"
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao consultar bases." });
  }
});

module.exports = router;
