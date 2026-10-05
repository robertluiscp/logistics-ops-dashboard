/**
 * Cria (ou reseta a senha de) uma conta de acesso ao painel.
 *
 * A senha e' sempre uma temporaria ALEATORIA, impressa uma unica vez no
 * terminal -- no banco fica so' o hash bcrypt. Use `--admin` pra criar o
 * primeiro administrador.
 *
 * Uso:
 *   node scripts/criar_usuario.js <usuario> ["Nome Completo"] [--admin]
 *
 * Rodar de dentro de api/ (usa o mesmo .env/pool que a API).
 */
const bcrypt = require("bcryptjs");
const { pool } = require("../src/db");
const { gerarSenhaTemporaria } = require("../src/senhaTemporaria");

async function main() {
  const args = process.argv.slice(2);
  const admin = args.includes("--admin");
  const [usuario, nome] = args.filter((a) => a !== "--admin");

  if (!usuario || !/^[A-Za-z0-9._-]{3,32}$/.test(usuario)) {
    console.error('Uso: node scripts/criar_usuario.js <usuario (3-32: letras, numeros, . _ -)> ["Nome Completo"] [--admin]');
    process.exitCode = 1;
    return;
  }

  const senha = gerarSenhaTemporaria();
  const hash = await bcrypt.hash(senha, 12);

  const { rows } = await pool.query(
    `INSERT INTO usuarios (usuario, senha_hash, nome, ativo, admin)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (usuario) DO UPDATE
       SET senha_hash = EXCLUDED.senha_hash,
           nome = COALESCE(EXCLUDED.nome, usuarios.nome),
           ativo = true,
           admin = usuarios.admin OR EXCLUDED.admin
     RETURNING id, usuario, nome, admin`,
    [usuario, hash, nome || null, admin]
  );

  console.log(
    `OK -- conta pronta: id=${rows[0].id}, usuario=${rows[0].usuario}, ` +
      `nome=${rows[0].nome || "(sem nome)"}, admin=${rows[0].admin}\n` +
      `Senha temporaria (mostrada so' agora): ${senha}`
  );
}

main()
  .catch((erro) => {
    console.error("Falha ao criar usuário:", erro);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
