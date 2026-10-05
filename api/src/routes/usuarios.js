const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { exigirAdmin } = require("../middleware/auth");
const { gerarSenhaTemporaria } = require("../senhaTemporaria");

const router = express.Router();

// Tudo aqui exige admin de verdade (exigirAdmin confere direto no banco,
// nao so' o claim do token) -- ver middleware/auth.js e
// docs/ENGINEERING_NOTES.md.
router.use(exigirAdmin);

router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, usuario, nome, ativo, admin, criado_em, ultimo_login_em FROM usuarios ORDER BY criado_em DESC"
    );
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao listar usuários." });
  }
});

// POST / -- cria conta nova com senha temporaria ALEATORIA (nao aceita senha
// customizada por aqui). A senha e' devolvida uma unica vez na resposta pra
// quem criou repassar pra pessoa; no banco fica so' o hash bcrypt.
router.post("/", async (req, res) => {
  const numero = String((req.body && req.body.usuario) || "").trim();
  const nome = (req.body && req.body.nome) || null;

  if (!/^[A-Za-z0-9._-]{3,32}$/.test(numero)) {
    return res.status(400).json({ erro: "Usuário inválido -- use 3 a 32 caracteres (letras, números, . _ -)." });
  }

  const senha = gerarSenhaTemporaria();
  const hash = await bcrypt.hash(senha, 12);

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (usuario, senha_hash, nome, ativo)
       VALUES ($1, $2, $3, true)
       RETURNING id, usuario, nome, ativo, admin, criado_em, ultimo_login_em`,
      [numero, hash, nome]
    );
    res.status(201).json({ ...rows[0], senha_temporaria: senha });
  } catch (erro) {
    if (erro.code === "23505") {
      return res.status(409).json({ erro: "Já existe uma conta com esse número de funcionário." });
    }
    console.error(erro);
    res.status(500).json({ erro: "Falha ao criar usuário." });
  }
});

// PATCH /:id -- ativo / admin / nome. Um admin nao pode remover o proprio
// acesso por aqui (evita se trancar fora sem querer -- ainda da' pra
// consertar via CLI/banco se precisar de verdade).
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { ativo, admin, nome } = req.body || {};

  if (String(req.usuario.sub) === String(id) && (ativo === false || admin === false)) {
    return res.status(400).json({ erro: "Você não pode remover seu próprio acesso de administrador por aqui." });
  }

  const campos = [];
  const valores = [];
  if (typeof ativo === "boolean") { valores.push(ativo); campos.push(`ativo = $${valores.length}`); }
  if (typeof admin === "boolean") { valores.push(admin); campos.push(`admin = $${valores.length}`); }
  if (typeof nome === "string") { valores.push(nome); campos.push(`nome = $${valores.length}`); }
  if (!campos.length) return res.status(400).json({ erro: "Nada para atualizar." });

  valores.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE usuarios SET ${campos.join(", ")} WHERE id = $${valores.length}
       RETURNING id, usuario, nome, ativo, admin, criado_em, ultimo_login_em`,
      valores
    );
    if (!rows[0]) return res.status(404).json({ erro: "Usuário não encontrado." });
    res.json(rows[0]);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao atualizar usuário." });
  }
});

// DELETE /:id -- remove a conta de verdade (nao e' so' desativar). Um
// admin nao pode se auto-excluir por aqui, mesma logica do PATCH acima --
// evita ficar sem nenhum admin no sistema por acidente.
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (String(req.usuario.sub) === String(id)) {
    return res.status(400).json({ erro: "Você não pode excluir sua própria conta por aqui." });
  }

  try {
    const { rows } = await pool.query(
      "DELETE FROM usuarios WHERE id = $1 RETURNING usuario",
      [id]
    );
    if (!rows[0]) return res.status(404).json({ erro: "Usuário não encontrado." });
    res.json({ ok: true, usuario: rows[0].usuario });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao excluir usuário." });
  }
});

// POST /:id/resetar-senha -- gera uma NOVA senha temporaria aleatoria, grava
// so' o hash e devolve a senha em claro uma unica vez.
router.post("/:id/resetar-senha", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query("SELECT usuario FROM usuarios WHERE id = $1", [id]);
    if (!rows[0]) return res.status(404).json({ erro: "Usuário não encontrado." });

    const senha = gerarSenhaTemporaria();
    const hash = await bcrypt.hash(senha, 12);
    await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hash, id]);
    res.json({ ok: true, senha_temporaria: senha });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao resetar senha." });
  }
});

module.exports = router;
