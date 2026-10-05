const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { autenticar } = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// /api/auth fica de fora do autenticar -- e' ele que emite/confere a
// sessao. Tudo mais que devolve dado do painel exige cookie valido desde
// 2026-08-31 -- antes disso quem segurava isso era so' o Cloudflare
// Access na borda; agora que o Access saiu, essa e' a UNICA barreira.
app.use("/api/auth", require("./routes/auth"));

app.use("/api/pernas", autenticar, require("./routes/pernas"));
app.use("/api/pernas", autenticar, require("./routes/pernaDetalhe"));
app.use("/api/pacotes", autenticar, require("./routes/pacotes"));
app.use("/api/candidatos", autenticar, require("./routes/candidatos"));
app.use("/api/bases", autenticar, require("./routes/bases"));
app.use("/api/execucoes", autenticar, require("./routes/execucoes"));
app.use("/api/taxas-expedicao", autenticar, require("./routes/taxasExpedicao"));
app.use("/api/tickets", autenticar, require("./routes/tickets"));
app.use("/api/dropoff", autenticar, require("./routes/dropoff"));
// /api/usuarios exige admin de verdade -- checado dentro do proprio
// router (exigirAdmin), autenticar aqui so' garante que req.usuario existe.
app.use("/api/usuarios", autenticar, require("./routes/usuarios"));

// Cache-busting do frontend (2026-08-31) -- sem isso, quem ja' tinha o
// painel aberto (ou com cache do navegador) podia continuar rodando
// app.js/estilo.css desatualizados depois de um deploy, sem nenhum aviso
// -- ja' causou confusao real (usuario achou que o login tinha quebrado,
// era so' cache velho, so' um hard reload resolvia). A versao vem do
// mtime real de cada arquivo, entao so' muda quando o arquivo muda de
// verdade (nao a cada restart da API). index.html em si NUNCA fica em
// cache -- assim o navegador sempre pega a <script>/<link> com a versao
// mais nova na proxima navegacao/reload normal, sem precisar de
// Ctrl+Shift+R manual. Precisa vir ANTES do express.static abaixo, senao
// ele serviria o index.html cru (com os placeholders {{V_JS}}/{{V_CSS}}
// sem substituir) pra "/".
const PASTA_FRONTEND = path.resolve(__dirname, "../../frontend");

function versaoDoArquivo(caminhoRelativo) {
  try {
    const stat = fs.statSync(path.join(PASTA_FRONTEND, caminhoRelativo));
    return stat.mtimeMs.toString(36); // curto, so' precisa mudar quando o arquivo muda
  } catch {
    return "0";
  }
}

app.get(["/", "/index.html"], (_req, res) => {
  let html;
  try {
    html = fs.readFileSync(path.join(PASTA_FRONTEND, "index.html"), "utf-8");
  } catch (erro) {
    console.error(erro);
    return res.status(500).send("Falha ao carregar o painel.");
  }
  html = html
    .replace("{{V_JS}}", versaoDoArquivo("js/app.js"))
    .replace("{{V_CSS}}", versaoDoArquivo("css/estilo.css"));
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("html").send(html);
});

app.use(express.static(PASTA_FRONTEND));

app.get("/api/saude", (_req, res) => res.json({ ok: true, agora: new Date().toISOString() }));

const PORTA = process.env.API_PORT || 3001;
app.listen(PORTA, () => {
  console.log(`API do Painel de Operação de Transporte rodando em http://localhost:${PORTA}`);
});
