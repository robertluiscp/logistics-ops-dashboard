const jwt = require("jsonwebtoken");
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });
const { pool } = require("../db");

const SEGREDO = process.env.SESSION_SECRET;
const NOME_COOKIE = "painel_token";

if (!SEGREDO) {
  // Sem isso, jwt.sign/verify ficariam com segredo `undefined` -- pior
  // caso, uma sessao "valida" que na verdade nunca foi assinada de
  // verdade. Falha alto e cedo em vez de rodar autenticacao quebrada.
  throw new Error("SESSION_SECRET não configurado no .env -- obrigatório pro login do painel.");
}

// Protege qualquer rota atras dela -- sem cookie valido, 401 antes de
// chegar no handler real. Ver server.js pra saber quais rotas passam por
// aqui (tudo que serve dado do painel, exceto /api/auth/* e /api/saude).
function autenticar(req, res, next) {
  const token = req.cookies && req.cookies[NOME_COOKIE];
  if (!token) {
    return res.status(401).json({ erro: "Não autenticado." });
  }
  try {
    req.usuario = jwt.verify(token, SEGREDO);
    next();
  } catch (erro) {
    res.status(401).json({ erro: "Sessão inválida ou expirada." });
  }
}

// Protege as rotas de administracao (gerenciar contas). Confere admin/ativo
// DIRETO NO BANCO em vez de confiar no que o JWT carrega -- promover/
// rebaixar/desativar alguem precisa valer imediatamente, nao so' depois
// que a sessao dessa pessoa expirar sozinha (ate 30 dias com "lembrar").
// Sempre roda depois de `autenticar`, entao req.usuario ja existe.
async function exigirAdmin(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT admin, ativo FROM usuarios WHERE id = $1", [req.usuario.sub]);
    if (!rows[0] || !rows[0].ativo || !rows[0].admin) {
      return res.status(403).json({ erro: "Acesso restrito a administradores." });
    }
    next();
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Falha ao verificar permissão." });
  }
}

module.exports = { autenticar, exigirAdmin, NOME_COOKIE, SEGREDO };
