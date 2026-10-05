const crypto = require("crypto");

// Senha temporaria aleatoria (16 caracteres, ~95 bits de entropia). Mostrada
// UMA vez a quem criou/resetou a conta e nunca guardada em claro -- so' o
// hash bcrypt vai pro banco. Substitui qualquer convencao de senha
// previsivel derivada do nome de usuario.
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function gerarSenhaTemporaria(tamanho = 16) {
  const bytes = crypto.randomBytes(tamanho);
  let senha = "";
  for (let i = 0; i < tamanho; i++) senha += ALFABETO[bytes[i] % ALFABETO.length];
  return senha;
}

module.exports = { gerarSenhaTemporaria };
