const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { autenticar, NOME_COOKIE, SEGREDO } = require("../middleware/auth");

const router = express.Router();

const DURACAO_PADRAO = "12h";
const DURACAO_LEMBRAR = "30d";
const MS_POR_DIA = 24 * 60 * 60 * 1000;

function opcoesCookie(lembrar) {
  return {
    httpOnly: true,
    // COOKIE_SECURE=true (padrao) exige HTTPS -- o navegador so' manda o
    // cookie de volta em https://panel.example.com. Em teste local direto
    // via http://localhost (sem passar pelo tunel), pode precisar de
    // COOKIE_SECURE=false no .env pra o cookie ser salvo.
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    maxAge: lembrar ? 30 * MS_POR_DIA : 0.5 * MS_POR_DIA,
    path: "/",
  };
}

// POST /api/auth/login -- { usuario, senha, lembrar }
router.post("/login", async (req, res) => {
  const { usuario, senha, lembrar } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ erro: "Usuário e senha são obrigatórios." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, usuario, senha_hash, nome, ativo, admin FROM usuarios WHERE usuario = $1",
      [usuario]
    );
    const linha = rows[0];
    // Mensagem generica tanto pra usuario inexistente quanto senha errada
    // -- nao da' pista se a conta existe ou nao.
    if (!linha || !linha.ativo) {
      return res.status(401).json({ erro: "Usuário ou senha inválidos." });
    }

    const confere = await bcrypt.compare(senha, linha.senha_hash);
    if (!confere) {
      return res.status(401).json({ erro: "Usuário ou senha inválidos." });
    }

    const token = jwt.sign(
      // "admin" aqui e' so' pra decidir o que MOSTRAR na tela (ex.: botao
      // de Administracao) -- a autorizacao de verdade nas rotas de
      // /api/usuarios confere direto no banco (ver exigirAdmin), nao
      // confia nesse claim sozinho.
      { sub: linha.id, usuario: linha.usuario, nome: linha.nome, admin: linha.admin },
      SEGREDO,
      { expiresIn: lembrar ? DURACAO_LEMBRAR : DURACAO_PADRAO }
    );
    res.cookie(NOME_COOKIE, token, opcoesCookie(lembrar));

    pool.query("UPDATE usuarios SET ultimo_login_em = now() WHERE id = $1", [linha.id]).catch((erro) => {
      // nao-critico -- nao vale falhar o login por causa disso.
      console.error("Falha ao atualizar ultimo_login_em:", erro);
    });

    res.json({ ok: true, nome: linha.nome || linha.usuario, admin: linha.admin });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao autenticar." });
  }
});

router.post("/logout", (_req, res) => {
  res.clearCookie(NOME_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// GET /api/auth/me -- usado pelo frontend pra saber se ja tem sessao
// valida antes de mostrar a tela de login ou o painel.
router.get("/me", autenticar, (req, res) => {
  res.json({ usuario: req.usuario.usuario, nome: req.usuario.nome, admin: !!req.usuario.admin });
});

module.exports = router;
