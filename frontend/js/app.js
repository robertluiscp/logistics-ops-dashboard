const API = "/api";
const INTERVALO_ATUALIZACAO_MS = 60_000;
const INTERVALO_RELOGIO_MS = 1_000;

const ETAPA_ZH = {
  "Planejado": "计划中",
  "Carregando": "装货中",
  "Em Trânsito": "运输中",
  "Em Descarregamento": "卸货中",
  "Concluído": "已完成",
  "Cancelado": "已取消",
};

let relatorioAtivo = "troncal";
let etapaAtiva = "";
let estadoAtivo = "";
let comCargaAtivo = false;
let semDeslacreAtivo = false;
let tabelaPernas = null;
let tabelaCandidatos = null;
let candidatosCache = [];

function titulo(pt, zh) {
  // titleDownload -- o Tabulator usa o `title` (HTML, pra tela) direto na
  // exportacao se nao houver isso, saindo com a tag <span> crua no
  // cabecalho do .xlsx (visto na pratica em 2026-08-30). titleDownload e'
  // a opcao propria do Tabulator pra um titulo diferente so' pro arquivo
  // exportado -- aqui uso o texto em portugues limpo.
  return {
    title: `<span class="titulo-coluna-pt">${pt}</span><span class="titulo-coluna-zh">${zh}</span>`,
    titleDownload: pt,
  };
}

function formatarData(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// accessorDownload -- o Tabulator exporta o valor BRUTO do campo, nao o
// que o formatter mostra na tela (visto na pratica em 2026-08-30: datas
// saiam em ISO cru, e campo vazio saia como o TEXTO "null" em vez de
// celula em branco). accessorDownload e' a opcao propria do Tabulator
// pra transformar o valor so' na hora de exportar.
function acessorNuloDownload(valor) {
  return valor == null ? "" : valor;
}
function acessorDataDownload(valor) {
  return valor ? formatarData(valor) : "";
}

function formatarDuracao(ms) {
  const negativo = ms < 0;
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const txt = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return negativo ? `-${txt} (vencido / 已逾期)` : txt;
}

function classeUrgencia(horasRestantes) {
  if (horasRestantes === null || horasRestantes === undefined) return "";
  if (horasRestantes <= 0) return "tempo-critico";
  if (horasRestantes <= 1) return "tempo-critico";
  if (horasRestantes <= 2) return "tempo-atencao";
  return "tempo-ok";
}

function pillEtapa(cell) {
  const v = cell.getValue();
  if (!v) return "-";
  const classe = "etapa-" + v.replace(/\s+/g, "-");
  const zh = ETAPA_ZH[v] || "";
  return `<span class="etapa-pill ${classe}">${v}${zh ? `<span class="pill-zh">${zh}</span>` : ""}</span>`;
}

function pillStatusPacote(status) {
  const classe = status === "Recebido" ? "tempo-ok" : status === "Pacote Voando" ? "tempo-atencao" : "tempo-critico";
  return `<span class="${classe}">${status}</span>`;
}

function barraProgresso(pct) {
  // excedido (2026-09-18): "Processado" nao e' mais limitado a <= "Carga"
  // no banco (ver comentario em etl/src/services/carga_processado.py) --
  // o numero real pode passar de 100% (pacote voando: mais descarregado
  // do que foi carregado por essa viagem). A barra continua sem estourar
  // visualmente, mas muda de cor + mostra "100%+" pra sinalizar direto na
  // tabela, sem precisar clicar no ID pra descobrir.
  const excedido = pct > 100;
  const p = Math.max(0, Math.min(100, pct));
  const classe = excedido ? " excedido" : "";
  const texto = excedido ? "100%+" : `${p}%`;
  return `<div class="barra-progresso"><div class="barra-progresso-preenchimento${classe}" style="width:${p}%"></div><span class="barra-progresso-texto">${texto}</span></div>`;
}

function colunasPernas() {
  return [
    { ...titulo("Shipment", "班次号"), field: "shipment_no", headerFilter: "input", width: 155 },
    { ...titulo("Origem", "起始站"), field: "base_origem_nome", headerFilter: "input" },
    { ...titulo("Destino", "目的站"), field: "base_destino_nome", headerFilter: "input" },
    { ...titulo("Modelo", "车型"), field: "modelo_veiculo", width: 110 },
    { ...titulo("Placa", "车牌"), field: "placa", width: 95 },
    { ...titulo("Transportador", "承运商"), field: "transportador" },
    { ...titulo("Carga", "货量"), field: "carga_total", width: 85, sorter: "number" },
    {
      ...titulo("Processado", "已处理"), field: "qtd_processada", width: 100, sorter: "number",
      formatter: (cell) => {
        const row = cell.getRow().getData();
        const v = cell.getValue();
        if (v == null) return "-";
        // pacote voando na propria viagem (2026-09-18): mais descarregado
        // do que carregado por essa perna -- destaca igual as outras 2
        // colunas de sinalizacao (Carregado/Descarregado nao X), pra nao
        // precisar abrir o modal pra perceber.
        if (row.carga_total != null && v > row.carga_total) return `<span class="tempo-atencao">${v}</span>`;
        return v;
      },
    },
    {
      ...titulo("Carregado, não descarregado", "已装未卸"), field: "carregado_nao_descarregado", width: 130, sorter: "number",
      formatter: (cell) => {
        const v = cell.getValue();
        return v == null ? "-" : v > 0 ? `<span class="tempo-atencao">${v}</span>` : "0";
      },
    },
    {
      ...titulo("Descarregado, não carregado", "已卸未装"), field: "descarregado_nao_carregado", width: 130, sorter: "number",
      formatter: (cell) => {
        const v = cell.getValue();
        return v == null ? "-" : v > 0 ? `<span class="tempo-atencao">${v}</span>` : "0";
      },
    },
    {
      ...titulo("% Processada", "处理百分比"), field: "pct_processada", width: 120, sorter: "number",
      formatter: (cell) => {
        const row = cell.getRow().getData();
        const pct = row.carga_total ? Math.round((row.qtd_processada / row.carga_total) * 100) : 0;
        return barraProgresso(pct);
      },
    },
    {
      ...titulo("Candidatos", "候选"), field: "qtd_candidatos", width: 100, sorter: "number",
      formatter: (cell) => {
        const v = cell.getValue();
        return v > 0 ? `<span class="tempo-critico">${v}</span>` : "0";
      },
    },
    {
      ...titulo("Pacotes Voando", "空降件"), field: "qtd_voando", width: 110, sorter: "number",
      formatter: (cell) => {
        const v = cell.getValue();
        return v > 0 ? `<span class="tempo-atencao">${v}</span>` : "0";
      },
    },
    { ...titulo("Etapa", "阶段"), field: "etapa", formatter: pillEtapa, width: 150 },
    {
      ...titulo("Deslacre", "解锁时间"), field: "hora_deslacre", width: 130,
      formatter: (cell) => {
        const row = cell.getRow().getData();
        if (row.hora_deslacre) return formatarData(row.hora_deslacre);
        // etapa Concluido sem deslacre = erro operacional real (a base
        // nunca bipou o deslacre do veiculo) -- diferente de "ainda nao
        // chegou nessa etapa", que so' mostra "-" (achado em 2026-09-14).
        if (row.sem_deslacre) return `<span class="tempo-critico">sem deslacre</span>`;
        return "-";
      },
      accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Tempo Descarregando", "卸货时长"), field: "hora_deslacre", width: 130,
      formatter: (cell) => {
        const row = cell.getRow().getData();
        if (row.etapa !== "Em Descarregamento" || !row.hora_deslacre) return "-";
        const ms = Date.now() - new Date(row.hora_deslacre).getTime();
        const classe = ms > 5 * 3_600_000 ? "tempo-critico" : ms > 3 * 3_600_000 ? "tempo-atencao" : "tempo-ok";
        return `<span class="${classe}">${formatarDuracao(ms)}</span>`;
      },
    },
    {
      ...titulo("Previsto", "预计时间"), field: "planejado_chegada", width: 120,
      formatter: (c) => formatarData(c.getValue()),
      accessorDownload: (v) => acessorDataDownload(v),
    },
  ];
}

function colunasCandidatos() {
  return [
    { ...titulo("Pedido LMS", "LMS订单号"), field: "bill_code", headerFilter: "input", width: 160 },
    { ...titulo("Shipment", "班次号"), field: "shipment_no", headerFilter: "input", width: 150 },
    { ...titulo("Tipo", "类型"), field: "tipo_perna", width: 100 },
    { ...titulo("Origem", "起始站"), field: "base_origem_nome", headerFilter: "input" },
    { ...titulo("Destino", "目的站"), field: "base_destino_nome", headerFilter: "input" },
    {
      ...titulo("Expedido desde", "发出时间"), field: "candidato_desde", width: 140,
      formatter: (c) => formatarData(c.getValue()),
      accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Prazo (deslacre + 6h)", "期限（解锁+6小时）"), field: "prazo_limite", width: 160,
      formatter: (c) => formatarData(c.getValue()),
      accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Tempo restante", "剩余时间"), field: "tempo_restante_ms", width: 170,
      formatter: (cell) => {
        const row = cell.getRow().getData();
        const classe = classeUrgencia(row.horas_restantes);
        return `<span class="${classe}">${formatarDuracao(row.tempo_restante_ms ?? 0)}</span>`;
      },
    },
  ];
}

function colunasPacotesDetalhe() {
  return [
    { ...titulo("Pedido LMS", "LMS订单号"), field: "bill_code", headerFilter: "input", width: 160 },
    { ...titulo("Pacote", "包裹号"), field: "pacote_codigo", width: 140 },
    { ...titulo("Destino previsto", "预计目的地"), field: "destino_previsto" },
    {
      ...titulo("Carregado em", "装车时间"), field: "carregado_em", width: 140,
      formatter: (c) => formatarData(c.getValue()),
      accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Chegou em", "到达时间"), field: "chegou_em", width: 140,
      formatter: (c) => formatarData(c.getValue()),
      accessorDownload: (v) => acessorDataDownload(v),
    },
    { ...titulo("Digitalizado por", "操作人"), field: "digitalizado_por" },
    {
      ...titulo("Status", "状态"), field: "status", width: 160,
      formatter: (cell) => pillStatusPacote(cell.getValue()),
    },
  ];
}

let tabelaPacotesDetalhe = null;
let pernaAtualModal = null;

function fecharModalPacotes() {
  document.getElementById("modal-pacotes-overlay").hidden = true;
}

async function abrirModalPacotes(perna) {
  const overlay = document.getElementById("modal-pacotes-overlay");
  const carregando = document.getElementById("modal-carregando");
  const erro = document.getElementById("modal-erro");
  const resumo = document.getElementById("modal-resumo");
  const tabelaDiv = document.getElementById("tabela-pacotes-detalhe");
  const btnExportar = document.getElementById("modal-exportar");

  pernaAtualModal = perna;
  document.getElementById("modal-titulo").textContent = perna.shipment_no;
  document.getElementById("modal-subtitulo").textContent =
    `${perna.base_origem_nome || "?"} → ${perna.base_destino_nome || "?"} · ${perna.tipo_perna}`;

  overlay.hidden = false;
  carregando.hidden = false;
  erro.hidden = true;
  resumo.hidden = true;
  tabelaDiv.hidden = true;
  btnExportar.hidden = true;

  try {
    const dados = await buscarJson(`/pernas/${perna.id}/pacotes`);
    carregando.hidden = true;
    btnExportar.hidden = dados.pacotes.length === 0;

    const porStatus = { "Recebido": 0, "Candidato a Expedido não chegou": 0, "Pacote Voando": 0 };
    dados.pacotes.forEach((p) => { porStatus[p.status] = (porStatus[p.status] || 0) + 1; });

    resumo.hidden = false;
    resumo.innerHTML = `
      <span class="modal-resumo-item"><strong>${dados.total_carregado}</strong>carregados / 已装车</span>
      <span class="modal-resumo-item"><strong>${porStatus["Recebido"]}</strong>recebidos / 已签收</span>
      <span class="modal-resumo-item"><strong>${porStatus["Candidato a Expedido não chegou"]}</strong>candidatos / 候选</span>
      <span class="modal-resumo-item"><strong>${porStatus["Pacote Voando"]}</strong>voando / 空降件</span>
    `;

    tabelaDiv.hidden = false;
    if (!tabelaPacotesDetalhe) {
      tabelaPacotesDetalhe = new Tabulator("#tabela-pacotes-detalhe", {
        data: dados.pacotes,
        columns: colunasPacotesDetalhe(),
        // fitDataStretch mede o conteudo de TODAS as linhas pra calcular
        // largura de coluna -- inviavel aqui, uma viagem grande pode ter
        // dezenas de milhares de pacotes (travou o navegador em teste,
        // 2026-08-30). fitColumns distribui largura sem medir celula por
        // celula -- as tabelas principais (pernas) ficam com fitDataStretch
        // porque nunca passam de poucos milhares de linhas.
        layout: "fitColumns",
        // vh explicito, nao "100%" -- ver comentario em estilo.css
        // (.tabela-modal) sobre a cadeia de flex aninhado nao resolver
        // de forma confiavel dentro do modal.
        height: "55vh",
        // Paginacao local -- uma viagem grande pode ter dezenas de
        // milhares de pacotes; sem isso o Tabulator tenta gerenciar tudo
        // de uma vez (travou em teste, 2026-08-30). Tambem casa com o
        // jeito que o proprio LMS pagina essa mesma tela.
        pagination: true,
        paginationSize: 100,
        paginationSizeSelector: [50, 100, 250, 500],
        columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
        placeholder: "Nenhum pacote encontrado. / 未找到包裹。",
      });
      tabelaPacotesDetalhe.on("tableBuilt", () => requestAnimationFrame(() => tabelaPacotesDetalhe.redraw(true)));
    } else {
      tabelaPacotesDetalhe.setData(dados.pacotes);
    }
  } catch (e) {
    console.error(e);
    carregando.hidden = true;
    erro.hidden = false;
    erro.textContent = `Falha ao buscar pacotes: ${e.message}`;
  }
}

document.getElementById("modal-fechar").addEventListener("click", fecharModalPacotes);
document.getElementById("modal-exportar").addEventListener("click", () => {
  if (!tabelaPacotesDetalhe || !pernaAtualModal) return;
  const nomeArquivo = `pacotes_${pernaAtualModal.shipment_no}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  // rowRange:"all" -- a tabela e' paginada (100/pagina), sem isso o
  // download so' traria a pagina atual em vez de todos os pacotes.
  tabelaPacotesDetalhe.download("xlsx", nomeArquivo, { rowRange: "all" });
});
document.getElementById("modal-pacotes-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-pacotes-overlay") fecharModalPacotes();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    fecharModalPacotes();
    fecharModalCiclo();
    fecharModalExtracaoTaxas();
    fecharModalExtracaoDropoff();
  }
});

async function buscarJson(caminho) {
  const resp = await fetch(`${API}${caminho}`);
  if (resp.status === 401) {
    // Sessao expirou (ou nunca existiu) no meio do uso -- volta pra tela
    // de login em vez de deixar os requests seguintes falhando calados.
    mostrarTelaLogin("Sessão expirada. Faça login novamente. / 会话已过期，请重新登录。");
    throw new Error("Não autenticado.");
  }
  if (!resp.ok) throw new Error(`Falha ao buscar ${caminho}: ${resp.status}`);
  return resp.json();
}

// Um so' setFilter -- combina os dois toggles (Com Carga / Sem Deslacre)
// com E logico. setFilter substitui qualquer filtro anterior (nao empilha),
// por isso os dois toggles precisam passar sempre pela mesma funcao em vez
// de cada um chamar setFilter isoladamente.
function aplicarFiltroComCarga() {
  if (!tabelaPernas) return;
  if (comCargaAtivo || semDeslacreAtivo) {
    tabelaPernas.setFilter((data) =>
      (!comCargaAtivo || (data.carga_total || 0) > 0) &&
      (!semDeslacreAtivo || data.sem_deslacre)
    );
  } else {
    tabelaPernas.clearFilter();
  }
}

let dentroPrazoAtivo = false;

function aplicarFiltroDentroPrazo() {
  if (!tabelaCandidatos) return;
  if (dentroPrazoAtivo) {
    tabelaCandidatos.setFilter((data) => data.dentro_do_prazo);
  } else {
    tabelaCandidatos.clearFilter();
  }
}

function atualizarContagemFiltrados() {
  const tabela = relatorioAtivo === "candidatos" ? tabelaCandidatos : tabelaPernas;
  const n = tabela ? tabela.getDataCount("active") : 0;
  document.getElementById("contagem-filtrados").textContent = n;
}

async function carregarPernas() {
  const params = new URLSearchParams();
  params.set("tipo", relatorioAtivo);
  if (etapaAtiva) params.set("etapa", etapaAtiva);
  if (estadoAtivo) params.set("estado", estadoAtivo);

  const dados = await buscarJson(`/pernas?${params.toString()}`);
  if (!tabelaPernas) {
    tabelaPernas = new Tabulator("#tabela-pernas", {
      data: dados,
      columns: colunasPernas(),
      // fitDataStretch trocado por fitColumns+paginacao em 2026-08-31 --
      // sem o limit artificial de 1000 la' na API, essa tabela agora pode
      // chegar a milhares de linhas de verdade (Secundaria sozinha ja tem
      // 3500+), e fitDataStretch e' O(linhas x colunas) -- trava o
      // navegador perto de ~9000 linhas (mesmo motivo do fix no modal de
      // detalhe de pacotes).
      layout: "fitColumns",
      height: "100%",
      pagination: true,
      paginationSize: 100,
      paginationSizeSelector: [50, 100, 250, 500],
      columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
      placeholder: "Nenhuma viagem encontrada. / 未找到班次。",
    });
    tabelaPernas.on("dataFiltered", atualizarContagemFiltrados);
    tabelaPernas.on("dataProcessed", atualizarContagemFiltrados);
    // clicar numa linha abre o detalhe dos pacotes dessa viagem ao vivo
    // (busca direto no LMS, nao vem do banco -- ver api/src/routes/pernaDetalhe.js).
    tabelaPernas.on("rowClick", (_e, row) => abrirModalPacotes(row.getData()));
    // height:"100%" mede o container ANTES do flexbox terminar de
    // resolver a altura real (.conteudo/.tabela) -- sem isso o virtual
    // DOM do Tabulator acha que a area visivel tem 0px e nao desenha
    // nenhuma linha ate o proximo resize manual. redraw(true) num rAF
    // forca reler a altura ja assentada.
    tabelaPernas.on("tableBuilt", () => requestAnimationFrame(() => tabelaPernas.redraw(true)));
  } else {
    tabelaPernas.setColumns(colunasPernas());
    tabelaPernas.setData(dados).then(() => {
      aplicarFiltroComCarga();
      atualizarContagemFiltrados();
    });
    return;
  }
  aplicarFiltroComCarga();
  atualizarContagemFiltrados();
}

async function carregarCandidatos() {
  const dados = await buscarJson("/candidatos");
  candidatosCache = dados.map((d) => ({
    ...d,
    tempo_restante_ms: d.prazo_limite ? new Date(d.prazo_limite).getTime() - Date.now() : null,
  }));

  // dentro_do_prazo ja' vem calculado e priorizado na ordenacao pela API
  // (candidatos.js) -- aqui e' so' contar pros cards. "Fora do prazo" fica
  // em destaque bem menor de proposito: depois das 6h a responsabilidade
  // passa pra base que descarregou (ver responsavel.py), entao o foco
  // operacional real e' sempre "dentro do prazo".
  document.getElementById("resumo-total-candidatos").textContent = candidatosCache.length;
  document.getElementById("resumo-dentro-prazo").textContent =
    candidatosCache.filter((d) => d.dentro_do_prazo).length;
  document.getElementById("resumo-fora-prazo").textContent =
    candidatosCache.filter((d) => !d.dentro_do_prazo).length;
  document.getElementById("resumo-urgentes").textContent =
    candidatosCache.filter((d) => d.horas_restantes !== null && d.horas_restantes >= 0 && d.horas_restantes <= 1).length;

  if (!tabelaCandidatos) {
    tabelaCandidatos = new Tabulator("#tabela-candidatos", {
      data: candidatosCache,
      columns: colunasCandidatos(),
      // sem isso, updateData() (usado no relogio de contagem regressiva,
      // 1x/seg) tenta casar linha por um campo "id" que essa API nunca
      // devolveu -- falhava silenciosamente (Update Error - Unable to
      // find row) pra TODA linha, todo segundo, achado ao validar o
      // console em 2026-08-31. bill_code e' unico por candidato.
      index: "bill_code",
      // mesmo motivo do fix em tabelaPernas acima -- ja vimos 984
      // candidatos num ciclo real, perto o suficiente do limiar de freeze
      // do fitDataStretch pra trocar preventivamente.
      layout: "fitColumns",
      height: "100%",
      pagination: true,
      paginationSize: 100,
      paginationSizeSelector: [50, 100, 250, 500],
      columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
      placeholder: "Nenhum candidato a Expedido não chegou no momento. / 目前没有已发出未到达的候选。",
    });
    tabelaCandidatos.on("dataFiltered", atualizarContagemFiltrados);
    tabelaCandidatos.on("dataProcessed", atualizarContagemFiltrados);
    // ver comentario equivalente em carregarPernas() acima.
    tabelaCandidatos.on("tableBuilt", () => requestAnimationFrame(() => tabelaCandidatos.redraw(true)));
  } else {
    tabelaCandidatos.setData(candidatosCache).then(() => {
      aplicarFiltroDentroPrazo();
      atualizarContagemFiltrados();
    });
    return;
  }
  aplicarFiltroDentroPrazo();
  atualizarContagemFiltrados();
}

function atualizarRelogioCandidatos() {
  if (relatorioAtivo !== "candidatos" || !tabelaCandidatos) return;
  candidatosCache.forEach((d) => {
    if (d.prazo_limite) d.tempo_restante_ms = new Date(d.prazo_limite).getTime() - Date.now();
  });
  tabelaCandidatos.updateData(candidatosCache);
}

async function atualizarTudo() {
  if (!moduloAtivo) return; // no menu inicial não há nada pra atualizar
  try {
    if (moduloAtivo === "transporte") {
      if (relatorioAtivo === "candidatos") await carregarCandidatos();
      else await carregarPernas();
    } else if (moduloAtivo === "indicadores") {
      await carregarTaxas();
    } else if (moduloAtivo === "tickets") {
      await carregarTickets();
    } else if (moduloAtivo === "dropoff") {
      if (relatorioAtivo === "c2c") await carregarC2C();
      else await carregarPudo();
    }
    const agora = new Date().toLocaleTimeString("pt-BR");
    document.getElementById("ultima-atualizacao").textContent = `Última atualização: ${agora}`;
    document.getElementById("ultima-atualizacao-zh").textContent = `最后更新：${agora}`;
  } catch (erro) {
    console.error(erro);
    document.getElementById("ultima-atualizacao").textContent = "Falha ao atualizar.";
    document.getElementById("ultima-atualizacao-zh").textContent = "更新失败。";
  }
}

// --- Roteamento: menu inicial + módulos (2026-09-10) -----------------------
// Depois do login o painel abre em #tela-inicio (blocos quadrados). Clicar
// num bloco muda o hash (#/transporte/troncais, #/indicadores/taxa-expedicao)
// e o roteador mostra o módulo certo -- os dados de cada relatório só são
// buscados quando você abre. Vanilla de propósito (mesma razão de não ter
// framework). Pra adicionar um relatório novo: um `sub` aqui + o painel no
// HTML + o ramo em atualizarTudo().
const MODULOS = {
  transporte: {
    nome: "Transporte",
    navId: "abas-transporte",
    secaoId: "modulo-transporte",
    subs: [
      { id: "troncal", slug: "troncais" },
      { id: "secundaria", slug: "secundarias" },
      { id: "candidatos", slug: "expedido-nao-chegou" },
    ],
  },
  indicadores: {
    nome: "Indicadores",
    navId: "abas-indicadores",
    secaoId: "modulo-indicadores",
    subs: [{ id: "taxa-expedicao", slug: "taxa-expedicao" }],
  },
  tickets: {
    nome: "Tickets",
    navId: "abas-tickets",
    secaoId: "modulo-tickets",
    subs: [
      { id: "comum", slug: "comuns" },
      { id: "plataforma", slug: "plataforma" },
    ],
  },
  dropoff: {
    nome: "Dropoff & C2C",
    navId: "abas-dropoff",
    secaoId: "modulo-dropoff",
    subs: [
      { id: "pudo", slug: "pudo" },
      { id: "c2c", slug: "c2c" },
    ],
  },
};

let moduloAtivo = null; // null = tela inicial (menu)

function parseHash() {
  const partes = (location.hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  const modulo = MODULOS[partes[0]] ? partes[0] : null;
  if (!modulo) return { modulo: null, sub: null };
  const cfg = MODULOS[modulo];
  const sub = cfg.subs.find((s) => s.slug === partes[1]) || cfg.subs[0];
  return { modulo, sub: sub.id };
}

function irPara(modulo, subId) {
  const cfg = MODULOS[modulo];
  const sub = cfg.subs.find((s) => s.id === subId) || cfg.subs[0];
  location.hash = `#/${modulo}/${sub.slug}`;
}

function roteador() {
  const { modulo, sub } = parseHash();
  moduloAtivo = modulo;
  relatorioAtivo = sub; // usado por carregarPernas/exportar/relógio de candidatos

  const naInicio = !modulo;
  document.getElementById("tela-inicio").hidden = !naInicio;
  document.getElementById("btn-atualizar").hidden = naInicio;

  for (const [id, cfg] of Object.entries(MODULOS)) {
    document.getElementById(cfg.secaoId).hidden = id !== modulo;
    // nav de sub-abas: só a do módulo ativo, e só se tiver mais de uma
    document.getElementById(cfg.navId).hidden = naInicio || id !== modulo || cfg.subs.length < 2;
    if (id === modulo) {
      document.querySelectorAll(`#${cfg.navId} .aba-relatorio`).forEach((b) =>
        b.classList.toggle("ativa", b.dataset.sub === sub));
    }
  }

  if (naInicio) {
    document.getElementById("ultima-atualizacao").textContent = "";
    document.getElementById("ultima-atualizacao-zh").textContent = "";
    return;
  }

  if (modulo === "transporte") {
    const ehCandidatos = sub === "candidatos";
    document.getElementById("barra-filtros-pernas").hidden = ehCandidatos;
    document.getElementById("painel-resumo-candidatos").hidden = !ehCandidatos;
    document.getElementById("tabela-pernas").hidden = ehCandidatos;
    document.getElementById("tabela-candidatos").hidden = !ehCandidatos;
  }

  if (modulo === "dropoff") {
    document.getElementById("painel-pudo").hidden = sub !== "pudo";
    document.getElementById("painel-c2c").hidden = sub !== "c2c";
  }

  atualizarTudo();
}

document.getElementById("modulos-grid").addEventListener("click", (e) => {
  const bloco = e.target.closest(".modulo-bloco");
  if (bloco) irPara(bloco.dataset.modulo);
});
// um listener por nav de módulo (delegação) -- clica na sub-aba, vai pra ela
for (const [id, cfg] of Object.entries(MODULOS)) {
  document.getElementById(cfg.navId).addEventListener("click", (e) => {
    const b = e.target.closest(".aba-relatorio");
    if (b) irPara(id, b.dataset.sub);
  });
}
document.getElementById("ir-inicio").addEventListener("click", () => { location.hash = "#/"; });
window.addEventListener("hashchange", roteador);

document.getElementById("filtro-etapas").addEventListener("click", (e) => {
  const botao = e.target.closest(".etapa-botao");
  if (!botao) return;
  document.querySelectorAll(".etapa-botao").forEach((b) => b.classList.remove("ativa"));
  botao.classList.add("ativa");
  etapaAtiva = botao.dataset.etapa;
  carregarPernas();
});

document.getElementById("filtro-com-carga").addEventListener("change", (e) => {
  comCargaAtivo = e.target.checked;
  aplicarFiltroComCarga();
  atualizarContagemFiltrados();
});

document.getElementById("filtro-sem-deslacre").addEventListener("change", (e) => {
  semDeslacreAtivo = e.target.checked;
  aplicarFiltroComCarga();
  atualizarContagemFiltrados();
});

document.getElementById("filtro-dentro-prazo").addEventListener("change", (e) => {
  dentroPrazoAtivo = e.target.checked;
  aplicarFiltroDentroPrazo();
  atualizarContagemFiltrados();
});

document.getElementById("filtro-estado").addEventListener("change", (e) => {
  estadoAtivo = e.target.value;
  carregarPernas();
});

document.getElementById("filtro-texto").addEventListener("input", (e) => {
  const tabela = relatorioAtivo === "candidatos" ? tabelaCandidatos : tabelaPernas;
  if (!tabela) return;
  tabela.setFilter((data) => JSON.stringify(data).toLowerCase().includes(e.target.value.toLowerCase()));
  atualizarContagemFiltrados();
});

document.getElementById("btn-atualizar").addEventListener("click", atualizarTudo);

function exportarRelatorioAtivo() {
  const tabela = relatorioAtivo === "candidatos" ? tabelaCandidatos : tabelaPernas;
  // rowRange:"active" -- cobre todas as paginas (essas duas tabelas sao
  // paginadas desde 2026-08-31) E respeita qualquer filtro ligado (Com
  // Carga / Só Dentro do Prazo, 2026-09-09) -- "all" ignorava filtro,
  // sempre exportava a tabela inteira mesmo com o toggle marcado.
  if (tabela) tabela.download("xlsx", `${relatorioAtivo}_${new Date().toISOString().slice(0, 10)}.xlsx`, { rowRange: "active" });
}

document.getElementById("btn-exportar").addEventListener("click", exportarRelatorioAtivo);
// Botao proprio na aba Expedido Nao Chegou -- a barra de filtros (onde
// fica o #btn-exportar generico) e' escondida nessa aba, entao sem esse
// botao dedicado nao dava pra exportar a lista pra registrar no LMS.
document.getElementById("btn-exportar-candidatos").addEventListener("click", exportarRelatorioAtivo);

function atualizarRelogioTopo() {
  document.getElementById("relogio-hora").textContent = new Date().toLocaleTimeString("pt-BR");
}

// --- Log de execução do ciclo automático (Task Scheduler) ---
// Sem isso so' dava pra saber se o `run.py` agendado esta' rodando
// saudavel olhando o terminal na hora -- agora da' pra ver direto no
// painel (bolinha verde/vermelha/amarela + historico ao clicar).
function formatarMinutosAtras(dataIso) {
  if (!dataIso) return "?";
  const min = Math.round((Date.now() - new Date(dataIso).getTime()) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${m > 0 ? m + "min" : ""}`;
}

async function atualizarBadgeCiclo() {
  const ponto = document.getElementById("ciclo-ponto");
  const texto = document.getElementById("ciclo-texto");
  const textoZh = document.getElementById("ciclo-texto-zh");
  try {
    const lista = await buscarJson("/execucoes?limit=1");
    if (!lista.length) {
      ponto.className = "ciclo-ponto";
      texto.textContent = "Ciclo: sem execuções ainda";
      textoZh.textContent = "自动周期：暂无记录";
      return;
    }
    const ultima = lista[0];
    const fim = ultima.finalizado_em || ultima.iniciado_em;
    const minAtras = Math.round((Date.now() - new Date(fim).getTime()) / 60000);
    const desde = formatarMinutosAtras(fim);

    if (ultima.status === "erro") {
      ponto.className = "ciclo-ponto erro";
      texto.textContent = `Ciclo: falhou (há ${desde})`;
      textoZh.textContent = `自动周期：失败（${desde}前）`;
    } else if (minAtras > 90) {
      // ciclo deveria rodar a cada 1h -- mais de 90min sem registro novo
      // sugere que o Task Scheduler parou (maquina desligada, ninguem
      // logado, tarefa desabilitada etc), nao so' que a ULTIMA rodada
      // especifica deu certo.
      ponto.className = "ciclo-ponto atrasado";
      texto.textContent = `Ciclo: atrasado (última há ${desde})`;
      textoZh.textContent = `自动周期：延迟（上次${desde}前）`;
    } else {
      ponto.className = "ciclo-ponto ok";
      texto.textContent = `Ciclo: ok (há ${desde})`;
      textoZh.textContent = `自动周期：正常（${desde}前）`;
    }
  } catch (e) {
    console.error(e);
    ponto.className = "ciclo-ponto erro";
    texto.textContent = "Ciclo: falha ao consultar";
    textoZh.textContent = "自动周期：查询失败";
  }
}

function colunasCiclo() {
  return [
    {
      ...titulo("Início", "开始时间"), field: "iniciado_em", width: 140,
      formatter: (c) => formatarData(c.getValue()),
      accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Duração", "耗时"), field: "duracao_segundos", width: 90,
      formatter: (cell) => {
        const s = cell.getValue();
        if (s == null) return "-";
        const m = Math.floor(s / 60), sec = s % 60;
        return `${m}min${String(sec).padStart(2, "0")}s`;
      },
    },
    {
      ...titulo("Status", "状态"), field: "status", width: 100,
      formatter: (cell) => {
        const v = cell.getValue();
        return v === "sucesso" ? `<span class="tempo-ok">sucesso</span>` : `<span class="tempo-critico">erro</span>`;
      },
    },
    { ...titulo("Pernas", "运单数"), field: "pernas_total", width: 90 },
    { ...titulo("Pacotes", "包裹数"), field: "pacotes_total", width: 90 },
    { ...titulo("Voando", "空降件"), field: "pacotes_voando", width: 90 },
    { ...titulo("Candidatos", "候选"), field: "candidatos_total", width: 100 },
    { ...titulo("Perto do prazo", "临近期限"), field: "candidatos_perto_prazo", width: 110 },
    { ...titulo("Erro", "错误"), field: "erro_mensagem", headerFilter: "input" },
  ];
}

let tabelaCiclo = null;

async function abrirModalCiclo() {
  document.getElementById("modal-ciclo-overlay").hidden = false;
  try {
    const dados = await buscarJson("/execucoes?limit=30");
    if (!tabelaCiclo) {
      tabelaCiclo = new Tabulator("#tabela-ciclo", {
        data: dados,
        columns: colunasCiclo(),
        layout: "fitColumns",
        height: "55vh",
        columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
        placeholder: "Nenhuma execução registrada ainda. / 暂无记录。",
      });
      tabelaCiclo.on("tableBuilt", () => requestAnimationFrame(() => tabelaCiclo.redraw(true)));
    } else {
      tabelaCiclo.setData(dados);
    }
  } catch (e) {
    console.error(e);
  }
}

function fecharModalCiclo() {
  document.getElementById("modal-ciclo-overlay").hidden = true;
}

document.getElementById("badge-ciclo-automatico").addEventListener("click", abrirModalCiclo);
document.getElementById("modal-ciclo-fechar").addEventListener("click", fecharModalCiclo);
document.getElementById("modal-ciclo-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-ciclo-overlay") fecharModalCiclo();
});

// --- Administração de contas (2026-08-31) --- botão só aparece pra quem
// é admin de verdade (ver iniciarApp) -- a API confere de novo no banco,
// isso aqui é só pra não mostrar o botão pra quem não pode usar.
let tabelaUsuarios = null;

function mostrarMensagemUsuarios(texto, ehErro) {
  const el = document.getElementById("usuarios-mensagem");
  el.textContent = texto;
  el.classList.toggle("erro", !!ehErro);
  el.hidden = false;
}

function colunasUsuarios() {
  return [
    { title: "Número", field: "usuario", width: 110 },
    { title: "Nome", field: "nome", widthGrow: 2 },
    {
      title: "Ativo", field: "ativo", width: 90, hozAlign: "center", headerHozAlign: "center",
      headerTooltip: "Clique no Sim/Não pra ativar ou desativar o acesso",
      formatter: (cell) => `<span class="pill-toggle ${cell.getValue() ? "pill-sim" : "pill-nao"}">${cell.getValue() ? "Sim" : "Não"}</span>`,
      cellClick: (_e, cell) => atualizarUsuario(cell.getRow().getData().id, { ativo: !cell.getValue() }),
    },
    {
      title: "Admin", field: "admin", width: 90, hozAlign: "center", headerHozAlign: "center",
      headerTooltip: "Clique no Sim/Não pra dar ou tirar acesso de administrador dessa pessoa",
      formatter: (cell) => `<span class="pill-toggle ${cell.getValue() ? "pill-sim" : "pill-nao"}">${cell.getValue() ? "Sim" : "Não"}</span>`,
      cellClick: (_e, cell) => atualizarUsuario(cell.getRow().getData().id, { admin: !cell.getValue() }),
    },
    { title: "Último login", field: "ultimo_login_em", width: 130, hozAlign: "center", headerHozAlign: "center", formatter: (cell) => formatarData(cell.getValue()) },
    {
      title: "Senha", width: 110, hozAlign: "center", headerHozAlign: "center",
      formatter: () => `<button class="btn-resetar-senha">Resetar</button>`,
      cellClick: (_e, cell) => resetarSenhaUsuario(cell.getRow().getData().id, cell.getRow().getData().usuario),
    },
    {
      title: "Excluir", width: 100, hozAlign: "center", headerHozAlign: "center",
      formatter: () => `<button class="btn-excluir-usuario">Excluir</button>`,
      cellClick: (_e, cell) => excluirUsuario(cell.getRow().getData().id, cell.getRow().getData().usuario),
    },
  ];
}

async function carregarUsuarios() {
  const dados = await buscarJson("/usuarios");
  if (!tabelaUsuarios) {
    tabelaUsuarios = new Tabulator("#tabela-usuarios", {
      data: dados,
      columns: colunasUsuarios(),
      layout: "fitColumns",
      height: "45vh",
      placeholder: "Nenhuma conta cadastrada.",
    });
    tabelaUsuarios.on("tableBuilt", () => requestAnimationFrame(() => tabelaUsuarios.redraw(true)));
  } else {
    tabelaUsuarios.setData(dados);
  }
}

async function atualizarUsuario(id, campos) {
  try {
    const resp = await fetch(`${API}/usuarios/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(campos),
    });
    const dados = await resp.json();
    if (!resp.ok) {
      mostrarMensagemUsuarios(dados.erro || "Falha ao atualizar.", true);
      return;
    }
    carregarUsuarios();
  } catch (erro) {
    mostrarMensagemUsuarios("Falha de conexão.", true);
  }
}

async function resetarSenhaUsuario(id, numero) {
  try {
    const resp = await fetch(`${API}/usuarios/${id}/resetar-senha`, { method: "POST" });
    const dados = await resp.json();
    if (!resp.ok) {
      mostrarMensagemUsuarios(dados.erro || "Falha ao resetar senha.", true);
      return;
    }
    mostrarMensagemUsuarios(`Nova senha temporária de ${numero}: ${dados.senha_temporaria}`);
  } catch (erro) {
    mostrarMensagemUsuarios("Falha de conexão.", true);
  }
}

async function excluirUsuario(id, numero) {
  // confirm() nativo -- exclusao e' definitiva (DELETE de verdade, nao so'
  // desativar), entao pede confirmacao explicita antes de mandar pro
  // servidor.
  const confirmou = window.confirm(`Excluir a conta ${numero} de vez? Essa ação não pode ser desfeita.`);
  if (!confirmou) return;

  try {
    const resp = await fetch(`${API}/usuarios/${id}`, { method: "DELETE" });
    const dados = await resp.json();
    if (!resp.ok) {
      mostrarMensagemUsuarios(dados.erro || "Falha ao excluir conta.", true);
      return;
    }
    mostrarMensagemUsuarios(`Conta ${dados.usuario} excluída.`);
    carregarUsuarios();
  } catch (erro) {
    mostrarMensagemUsuarios("Falha de conexão.", true);
  }
}

function abrirModalUsuarios() {
  document.getElementById("modal-usuarios-overlay").hidden = false;
  document.getElementById("usuarios-mensagem").hidden = true;
  carregarUsuarios().catch((erro) => console.error(erro));
}

function fecharModalUsuarios() {
  document.getElementById("modal-usuarios-overlay").hidden = true;
}

document.getElementById("btn-admin").addEventListener("click", abrirModalUsuarios);
document.getElementById("modal-usuarios-fechar").addEventListener("click", fecharModalUsuarios);
document.getElementById("modal-usuarios-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-usuarios-overlay") fecharModalUsuarios();
});

document.getElementById("form-novo-usuario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const numero = document.getElementById("novo-usuario-numero").value.trim();
  const nome = document.getElementById("novo-usuario-nome").value.trim();
  try {
    const resp = await fetch(`${API}/usuarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: numero, nome: nome || null }),
    });
    const dados = await resp.json();
    if (!resp.ok) {
      mostrarMensagemUsuarios(dados.erro || "Falha ao criar conta.", true);
      return;
    }
    mostrarMensagemUsuarios(`Conta ${dados.usuario} criada -- senha temporária (mostrada só agora): ${dados.senha_temporaria}`);
    document.getElementById("novo-usuario-numero").value = "";
    document.getElementById("novo-usuario-nome").value = "";
    carregarUsuarios();
  } catch (erro) {
    mostrarMensagemUsuarios("Falha de conexão.", true);
  }
});

// --- Aba "Taxa de Expedição" (2026-09-10) -----------------------------------
// Os 3 indicadores de taxa de expedição no prazo importados do LMS
// (taxas_expedicao, via etl/run_taxas.py). A ideia é ser "mais completo que
// o LMS": além da tabela crua do dia, uma matriz rota × período com taxa
// ponderada por volume e um gráfico de tendência da regional inteira.
const META_TAXA = 0.9;
const TAXA_LABEL = { sc_hub: "SC → HUB", sc_sc: "SC → SC", hub_pdd: "HUB → PDD" };
const estadoTaxas = { tipo: "sc_hub", gran: "dia" };

function fmtPct(v) {
  return v == null ? "–" : `${(v * 100).toFixed(1)}%`;
}

function agregarSerie(serie, filtro) {
  let total = 0, noPrazo = 0;
  for (const p of serie) {
    if (filtro && !filtro(p)) continue;
    total += p.total || 0;
    noPrazo += p.no_prazo || 0;
  }
  return total > 0 ? noPrazo / total : null;
}

function pintarCard(id, taxa, extra) {
  const card = document.getElementById(id);
  card.querySelector(".resumo-numero").textContent = extra != null ? extra : fmtPct(taxa);
  card.classList.remove("acima", "abaixo");
  if (taxa != null) card.classList.add(taxa >= META_TAXA ? "acima" : "abaixo");
}

function renderCardsTaxas(dados) {
  const serie = dados.serie_diaria;
  const mesAtual = new Date().toISOString().slice(0, 7);
  const corte7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  pintarCard("card-taxa-mes", agregarSerie(serie, (p) => p.data.startsWith(mesAtual)));
  pintarCard("card-taxa-semana", agregarSerie(serie, (p) => p.data >= corte7));

  const fechados = serie.filter((p) => p.total > 0);
  const ultimo = fechados[fechados.length - 1];
  pintarCard("card-taxa-dia", ultimo ? ultimo.taxa : null);
  document.getElementById("card-taxa-dia").querySelector(".resumo-label .rotulo-pt").textContent =
    ultimo ? `último dia fechado (${ultimo.data.slice(8, 10)}/${ultimo.data.slice(5, 7)})` : "último dia fechado";

  const abaixo = dados.linhas.filter((l) => l.geral.taxa != null && l.geral.taxa < META_TAXA).length;
  pintarCard("card-taxa-abaixo", null, `${abaixo} / ${dados.linhas.length}`);
  document.getElementById("card-taxa-abaixo").classList.toggle("abaixo", abaixo > 0);
  document.getElementById("card-taxa-abaixo").classList.toggle("acima", abaixo === 0);
}

let ultimaSerieGrafico = null;
const DIAS_GRAFICO = 15; // só os últimos 15 dias no gráfico -- foco na atualidade

function renderGraficoTaxas(serie) {
  const el = document.getElementById("taxas-grafico");
  if (serie) ultimaSerieGrafico = serie;
  const pts = (ultimaSerieGrafico || []).filter((p) => p.taxa != null).slice(-DIAS_GRAFICO);
  if (pts.length < 2) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados suficientes para o gráfico ainda.</span>`;
    return;
  }

  const padL = 48, padR = 16, padT = 14, padB = 30;
  // ocupa toda a caixa nos DOIS eixos; conforme os dias aumentam, o passo
  // entre os pontos diminui pra tudo caber sem rolar. Só passa a rolar na
  // horizontal se ficasse apertado demais (< 6px por dia). Um ResizeObserver
  // (lá embaixo) re-renderiza sempre que a caixa muda de tamanho.
  const larguraCaixa = Math.max(el.clientWidth || 900, 320);
  const h = Math.max(el.clientHeight || 220, 130); // = altura da área, sem forçar scroll vertical
  const passo = Math.max(6, (larguraCaixa - padL - padR) / (pts.length - 1));
  const w = Math.round(padL + padR + passo * (pts.length - 1));
  const minTaxa = Math.min(...pts.map((p) => p.taxa));
  const yMin = Math.min(0.5, Math.floor(minTaxa * 10) / 10);
  const yMax = 1;
  const x = (i) => padL + i * passo;
  const y = (t) => padT + (1 - (t - yMin) / (yMax - yMin)) * (h - padT - padB);

  const linhasGrade = [];
  const rotulosY = [];
  for (let g = Math.ceil(yMin * 10); g <= yMax * 10; g++) {
    const t = g / 10;
    linhasGrade.push(`<line class="grade" x1="${padL}" y1="${y(t).toFixed(1)}" x2="${w - padR}" y2="${y(t).toFixed(1)}"/>`);
    rotulosY.push(`<text class="eixo-texto" x="${padL - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${(t * 100).toFixed(0)}%</text>`);
  }

  const metaY = y(META_TAXA).toFixed(1);
  const caminho = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.taxa).toFixed(1)}`).join(" ");
  const pontos = pts
    .map((p, i) => `<circle class="ponto ${p.taxa < META_TAXA ? "abaixo" : ""}" cx="${x(i).toFixed(1)}" cy="${y(p.taxa).toFixed(1)}" r="3.2"><title>${p.data}: ${fmtPct(p.taxa)} (${p.no_prazo}/${p.total})</title></circle>`)
    .join("");
  const passoRot = Math.ceil(pts.length / Math.max(6, Math.floor(w / 90)));
  const rotulosX = pts
    .map((p, i) => (i % passoRot === 0 ? `<text class="eixo-texto" x="${x(i).toFixed(1)}" y="${h - 9}" text-anchor="middle">${p.data.slice(8, 10)}/${p.data.slice(5, 7)}</text>` : ""))
    .join("");

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    ${linhasGrade.join("")}
    <line class="meta-linha" x1="${padL}" y1="${metaY}" x2="${w - padR}" y2="${metaY}"/>
    <text class="eixo-texto" x="${w - padR}" y="${(Number(metaY) - 5)}" text-anchor="end">meta ${META_TAXA * 100}%</text>
    <path class="serie" d="${caminho}"/>
    ${pontos}
    ${rotulosY.join("")}
    ${rotulosX}
  </svg>`;
  tamGraficoAtual = `${Math.round(el.clientWidth)}x${Math.round(el.clientHeight)}`; // sincroniza com o ResizeObserver
}

function celulaMatriz(obj, ehGeral) {
  const cls = ehGeral ? "geral" : "";
  if (!obj || obj.taxa == null) return `<td class="${cls} taxa-vazia">–</td>`;
  const cor = obj.taxa >= META_TAXA ? "taxa-verde" : "taxa-vermelho";
  return `<td class="${cls} ${cor}">
    <span class="celula-taxa">${(obj.taxa * 100).toFixed(1)}%</span>
    <span class="celula-vol">${obj.no_prazo.toLocaleString("pt-BR")}/${obj.total.toLocaleString("pt-BR")}</span>
  </td>`;
}

function renderMatrizTaxas(dados) {
  const ehPar = dados.tipo === "hub_pdd";
  const cols = dados.colunas;
  const cabecalho = `<tr><th>${ehPar ? "SC → DC" : "SC"}</th>${cols.map((c) => `<th>${c.rotulo}</th>`).join("")}<th>Geral<span class="rotulo-zh">合计</span></th></tr>`;

  const corpo = dados.linhas
    .map((l) => {
      const rota = ehPar ? `${l.sc_nome || l.sc_codigo} → ${l.dc_nome || l.dc_codigo}` : (l.sc_nome || l.sc_codigo);
      const cels = cols.map((c) => celulaMatriz(l.celulas[c.chave], false)).join("");
      return `<tr><td class="rota">${rota}</td>${cels}${celulaMatriz(l.geral, true)}</tr>`;
    })
    .join("");

  const rod = dados.rodape;
  const rodape = `<tr class="rodape"><td class="rodape-lbl">Regional (todas)<span class="rotulo-zh">大区（全部）</span></td>${cols
    .map((c) => celulaMatriz(rod.celulas[c.chave], false))
    .join("")}${celulaMatriz(rod.geral, true)}</tr>`;

  document.getElementById("taxas-matriz").innerHTML = dados.linhas.length
    ? `<table class="taxas-matriz"><thead>${cabecalho}</thead><tbody>${corpo}${rodape}</tbody></table>`
    : `<p class="taxas-grafico-titulo">Nenhum dado para este indicador no período.</p>`;
}

async function carregarTaxas() {
  const { tipo, gran } = estadoTaxas;
  const dados = await buscarJson(`/taxas-expedicao/consolidado?tipo=${tipo}&granularidade=${gran}`);
  renderCardsTaxas(dados);
  renderGraficoTaxas(dados.serie_diaria);
  renderMatrizTaxas(dados);
  atualizarBadgeExtracaoTaxas();
}

// --- Saúde da extração (run_taxas.py, a cada 3h) -- 2026-09-11 -----------
// Antes disso uma falha parcial (ex: sc_hub travado um dia inteiro) ficava
// invisível -- a scheduled task não tinha saída capturada em lugar nenhum.
// Mesmo padrão visual do badge "Ciclo" do ETL principal (bolinha + texto),
// clicável pra ver o histórico.
async function atualizarBadgeExtracaoTaxas() {
  const ponto = document.getElementById("extracao-taxas-ponto");
  const texto = document.getElementById("extracao-taxas-texto");
  const textoZh = document.getElementById("extracao-taxas-texto-zh");
  try {
    const lista = await buscarJson("/taxas-expedicao/execucoes?limit=1");
    if (!lista.length) {
      ponto.className = "ciclo-ponto";
      texto.textContent = "Extração: sem execuções ainda";
      textoZh.textContent = "数据提取：暂无记录";
      return;
    }
    const ultima = lista[0];
    const fim = ultima.finalizado_em || ultima.iniciado_em;
    const minAtras = Math.round((Date.now() - new Date(fim).getTime()) / 60000);
    const desde = formatarMinutosAtras(fim);

    if (ultima.status === "erro") {
      ponto.className = "ciclo-ponto erro";
      texto.textContent = `Extração: falhou (há ${desde})`;
      textoZh.textContent = `数据提取：失败（${desde}前）`;
    } else if (minAtras > 240) {
      // roda a cada 3h -- mais de 4h sem registro novo sugere que a task
      // parou (mesmo raciocínio do badge "Ciclo" do ETL principal).
      ponto.className = "ciclo-ponto atrasado";
      texto.textContent = `Extração: atrasada (última há ${desde})`;
      textoZh.textContent = `数据提取：延迟（上次${desde}前）`;
    } else if (ultima.status === "parcial") {
      ponto.className = "ciclo-ponto atrasado";
      texto.textContent = `Extração: parcial (há ${desde})`;
      textoZh.textContent = `数据提取：部分成功（${desde}前）`;
    } else {
      ponto.className = "ciclo-ponto ok";
      texto.textContent = `Extração: ok (há ${desde})`;
      textoZh.textContent = `数据提取：正常（${desde}前）`;
    }
  } catch (e) {
    console.error(e);
    ponto.className = "ciclo-ponto erro";
    texto.textContent = "Extração: falha ao consultar";
    textoZh.textContent = "数据提取：查询失败";
  }
}

function colunasExtracaoTaxas() {
  return [
    {
      ...titulo("Início", "开始时间"), field: "iniciado_em", width: 140,
      formatter: (c) => formatarData(c.getValue()), accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Duração", "耗时"), field: "duracao_segundos", width: 80,
      formatter: (c) => (c.getValue() == null ? "-" : `${c.getValue()}s`),
    },
    {
      ...titulo("Status", "状态"), field: "status", width: 90,
      formatter: (c) => {
        const v = c.getValue();
        const classe = v === "sucesso" ? "tempo-ok" : v === "parcial" ? "tempo-atencao" : "tempo-critico";
        return `<span class="${classe}">${v}</span>`;
      },
    },
    { ...titulo("Dias", "天数"), field: "dias_alvo", width: 60 },
    { ...titulo("Linhas", "行数"), field: "linhas_gravadas", width: 70 },
    {
      ...titulo("Falhas", "失败详情"), field: "falhas", widthGrow: 2,
      formatter: (c) => (c.getValue() || "").replace(/\n/g, "<br>") || "-",
      accessorDownload: (v) => acessorNuloDownload(v),
    },
  ];
}

let tabelaExtracaoTaxas = null;

async function abrirModalExtracaoTaxas() {
  document.getElementById("modal-extracao-taxas-overlay").hidden = false;
  try {
    const dados = await buscarJson("/taxas-expedicao/execucoes?limit=30");
    if (!tabelaExtracaoTaxas) {
      tabelaExtracaoTaxas = new Tabulator("#tabela-extracao-taxas", {
        data: dados,
        columns: colunasExtracaoTaxas(),
        layout: "fitColumns",
        height: "55vh",
        columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
        placeholder: "Nenhuma execução registrada ainda. / 暂无记录。",
      });
      tabelaExtracaoTaxas.on("tableBuilt", () => requestAnimationFrame(() => tabelaExtracaoTaxas.redraw(true)));
    } else {
      tabelaExtracaoTaxas.setData(dados);
    }
  } catch (e) {
    console.error(e);
  }
}

function fecharModalExtracaoTaxas() {
  document.getElementById("modal-extracao-taxas-overlay").hidden = true;
}

document.getElementById("badge-extracao-taxas").addEventListener("click", abrirModalExtracaoTaxas);
document.getElementById("modal-extracao-taxas-fechar").addEventListener("click", fecharModalExtracaoTaxas);
document.getElementById("modal-extracao-taxas-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-extracao-taxas-overlay") fecharModalExtracaoTaxas();
});

document.getElementById("taxas-indicadores").addEventListener("click", (e) => {
  const b = e.target.closest(".taxa-ind");
  if (!b) return;
  document.querySelectorAll(".taxa-ind").forEach((x) => x.classList.toggle("ativa", x === b));
  estadoTaxas.tipo = b.dataset.tipo;
  carregarTaxas().catch(console.error);
});

document.getElementById("taxas-granularidade").addEventListener("click", (e) => {
  const b = e.target.closest(".taxa-gran");
  if (!b) return;
  document.querySelectorAll(".taxa-gran").forEach((x) => x.classList.toggle("ativa", x === b));
  estadoTaxas.gran = b.dataset.gran;
  carregarTaxas().catch(console.error);
});

// O SVG do gráfico é gerado com tamanho fixo = tamanho da caixa no momento
// do render. Um ResizeObserver o redesenha sempre que a caixa muda de
// tamanho (janela, abrir o módulo, etc) -- assim ele sempre ocupa o espaço
// todo. Guarda o último tamanho pra não re-renderizar à toa nem entrar em
// laço (o SVG nunca passa da caixa quando não está rolando).
let tamGraficoAtual = "0x0";
new ResizeObserver((entradas) => {
  const r = entradas[0].contentRect;
  const chave = `${Math.round(r.width)}x${Math.round(r.height)}`;
  if (r.width > 0 && r.height > 0 && chave !== tamGraficoAtual && ultimaSerieGrafico) {
    tamGraficoAtual = chave;
    renderGraficoTaxas(null);
  }
}).observe(document.getElementById("taxas-grafico"));

document.getElementById("btn-exportar-taxas").addEventListener("click", async () => {
  try {
    const linhas = await buscarJson(`/taxas-expedicao?tipo=${estadoTaxas.tipo}&de=2026-08-01`);
    if (!linhas.length) return;
    const planilha = XLSX.utils.json_to_sheet(linhas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, planilha, TAXA_LABEL[estadoTaxas.tipo].replace(/[^\w]/g, ""));
    XLSX.writeFile(wb, `taxa_expedicao_${estadoTaxas.tipo}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    console.error(e);
  }
});

// --- Módulo "Tickets" (2026-09-10) -----------------------------------------
// Tickets de reclamação em aberto do SAC. `comum` = clientes comuns
// (Client A, Client B, Client C...), `plataforma` = só Marketplace. Prazo já
// vem calculado da API (comum +24h; plataforma +12h se [PRIORITY], senão +48h).
// Mesmo padrão da aba de candidatos: cards de contagem + relógio regressivo
// atualizado 1x/seg a partir do prazo_limite.
let tabelaTickets = null;
let ticketsCache = [];
let ticketsFiltroNoPrazo = false;

function colunasTickets() {
  return [
    { ...titulo("Ticket", "工单号"), field: "work_order_no", headerFilter: "input", width: 140 },
    { ...titulo("Remessa", "运单号"), field: "waybill_no", headerFilter: "input", width: 135 },
    { ...titulo("Cliente", "客户"), field: "cliente_nome", headerFilter: "input", width: 130 },
    {
      ...titulo("Tipo (nível II)", "二级类型"), field: "tipo_ii_nome", headerFilter: "input", minWidth: 220, widthGrow: 3,
      formatter: (c) => {
        const v = c.getValue() || "-";
        return c.getRow().getData().eh_priority ? `<span class="tag-priority">PRIORITY</span> ${v.replace(/^\[PRIORITY\]\s*/i, "")}` : v;
      },
    },
    { ...titulo("Status", "状态"), field: "status_nome", width: 120, formatter: (c) => (c.getValue() || "").split("|")[0] },
    { ...titulo("Base", "网点"), field: "estacao_aceitacao", headerFilter: "input", width: 95 },
    { ...titulo("Responsável", "受理人"), field: "responsavel_nome", headerFilter: "input", width: 165 },
    {
      ...titulo("Registrado em", "登记时间"), field: "data_registro", width: 125,
      formatter: (c) => formatarData(c.getValue()), accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Prazo", "处理期限"), field: "prazo_limite", width: 125,
      formatter: (c) => formatarData(c.getValue()), accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("SLA", "时限"), field: "horas_sla", width: 65,
      formatter: (c) => `${Number(c.getValue())}h`,
    },
    {
      ...titulo("Tempo restante", "剩余时间"), field: "tempo_restante_ms", width: 165,
      formatter: (cell) => {
        const row = cell.getRow().getData();
        const ms = row.tempo_restante_ms ?? 0;
        const classe = ms <= 0 ? "tempo-critico" : ms <= 3_600_000 ? "tempo-critico" : ms <= 7_200_000 ? "tempo-atencao" : "tempo-ok";
        return `<span class="${classe}">${formatarDuracao(ms)}</span>`;
      },
    },
  ];
}

function recalcularCardsTickets() {
  const agora = Date.now();
  const meioDia = new Date(); meioDia.setHours(12, 0, 0, 0);
  const hojeStr = new Date().toISOString().slice(0, 10);
  let em15 = 0, em1h = 0, vencido = 0, hoje = 0, antes = 0, apos = 0, noPrazo = 0;

  for (const t of ticketsCache) {
    const prazo = t.prazo_limite ? new Date(t.prazo_limite).getTime() : null;
    if (prazo == null) continue;
    const rest = prazo - agora;
    if (rest > 0) noPrazo++;
    if (rest <= 0) vencido++;
    if (rest > 0 && rest <= 900_000) em15++;
    if (rest > 0 && rest <= 3_600_000) em1h++;
    if (t.prazo_limite.slice(0, 10) === hojeStr) {
      hoje++;
      if (prazo < meioDia.getTime()) antes++; else apos++;
    }
  }
  const total = ticketsCache.length;
  document.getElementById("tk-15min").textContent = em15;
  document.getElementById("tk-1h").textContent = em1h;
  document.getElementById("tk-vencido").textContent = vencido;
  document.getElementById("tk-hoje").textContent = hoje;
  document.getElementById("tk-antes").textContent = antes;
  document.getElementById("tk-apos").textContent = apos;
  document.getElementById("tk-taxa").textContent = total ? `${((noPrazo / total) * 100).toFixed(1)}%` : "–";
  const cardTaxa = document.querySelector(".resumo-tk-taxa");
  const pct = total ? noPrazo / total : 1;
  cardTaxa.classList.toggle("abaixo", pct < 0.9);
  cardTaxa.classList.toggle("acima", pct >= 0.9);
}

function atualizarContagemTickets() {
  const n = tabelaTickets ? tabelaTickets.getDataCount("active") : 0;
  document.getElementById("contagem-tickets").textContent = n;
}

async function carregarTickets() {
  const tipo = relatorioAtivo; // "comum" | "plataforma"
  const dados = await buscarJson(`/tickets?tipo=${tipo}`);
  ticketsCache = dados.map((d) => ({
    ...d,
    tempo_restante_ms: d.prazo_limite ? new Date(d.prazo_limite).getTime() - Date.now() : null,
  }));

  // o filtro PRIORITY só faz sentido na aba plataforma
  document.getElementById("filtro-tickets-priority").hidden = tipo !== "plataforma";

  recalcularCardsTickets();

  if (!tabelaTickets) {
    tabelaTickets = new Tabulator("#tabela-tickets", {
      data: ticketsCache,
      columns: colunasTickets(),
      index: "id",
      layout: "fitColumns",
      height: "100%",
      pagination: true,
      paginationSize: 100,
      paginationSizeSelector: [50, 100, 250, 500],
      columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
      placeholder: "Nenhum ticket em aberto. / 没有未处理的工单。",
    });
    tabelaTickets.on("dataFiltered", atualizarContagemTickets);
    tabelaTickets.on("dataProcessed", atualizarContagemTickets);
    tabelaTickets.on("tableBuilt", () => requestAnimationFrame(() => tabelaTickets.redraw(true)));
  } else {
    tabelaTickets.setData(ticketsCache).then(() => {
      aplicarFiltroTicketsCombinado();
      atualizarContagemTickets();
    });
    return;
  }
  aplicarFiltroTicketsCombinado();
  atualizarContagemTickets();
}

// combina os 3 filtros da barra (texto, PRIORITY, só no prazo) num setFilter só
function aplicarFiltroTicketsCombinado() {
  if (!tabelaTickets) return;
  const texto = document.getElementById("filtro-texto-tickets").value.toLowerCase();
  const priority = document.getElementById("filtro-tickets-priority").value;
  tabelaTickets.setFilter((d) => {
    if (ticketsFiltroNoPrazo && (d.tempo_restante_ms ?? 0) <= 0) return false;
    if (priority === "priority" && !d.eh_priority) return false;
    if (priority === "normal" && d.eh_priority) return false;
    if (texto && !JSON.stringify(d).toLowerCase().includes(texto)) return false;
    return true;
  });
}

function atualizarRelogioTickets() {
  if (moduloAtivo !== "tickets" || !tabelaTickets) return;
  ticketsCache.forEach((t) => {
    if (t.prazo_limite) t.tempo_restante_ms = new Date(t.prazo_limite).getTime() - Date.now();
  });
  tabelaTickets.updateData(ticketsCache);
  recalcularCardsTickets();
}

document.getElementById("filtro-texto-tickets").addEventListener("input", () => { aplicarFiltroTicketsCombinado(); atualizarContagemTickets(); });
document.getElementById("filtro-tickets-priority").addEventListener("change", () => { aplicarFiltroTicketsCombinado(); atualizarContagemTickets(); });
document.getElementById("filtro-tickets-no-prazo").addEventListener("change", (e) => {
  ticketsFiltroNoPrazo = e.target.checked;
  aplicarFiltroTicketsCombinado();
  atualizarContagemTickets();
});
document.getElementById("btn-exportar-tickets").addEventListener("click", () => {
  if (tabelaTickets) tabelaTickets.download("xlsx", `tickets_${relatorioAtivo}_${new Date().toISOString().slice(0, 10)}.xlsx`, { rowRange: "active" });
});

// --- Módulo "Dropoff & C2C" (2026-09-11) ------------------------------------
// Pudo = tudo bipado nos pontos de coleta parceiros. Volume altíssimo
// (~15-30 mil/dia) -- por isso aqui é sempre AGREGADO (cards + gráfico por
// dia + top-N em listinhas de barra), nunca a lista bruta inteira; o
// detalhe exportável é só "os N mais recentes". C2C = volume baixo, segue
// o padrão normal de tabela com prazo + relógio regressivo (igual Tickets),
// com o prazo já calculado no ETL via abrangencia_prazos.

// --- Pudo: cards + gráfico por dia + listas top-N ---
function renderCardsPudo(resumo) {
  document.getElementById("pudo-total").textContent = (resumo.total.total ?? 0).toLocaleString("pt-BR");
  document.getElementById("pudo-dropoffs").textContent = (resumo.total.dropoffs ?? 0).toLocaleString("pt-BR");
  document.getElementById("pudo-pontos").textContent = (resumo.total.pontos ?? 0).toLocaleString("pt-BR");
  // "Tempo médio até coleta" (2026-09-17) -- gap entre confirmação do
  // pedido e entrada de fato no ponto Pudo. >=24h mostra em dias (mais
  // legível que "36,4h"), abaixo disso fica em horas.
  const horas = resumo.tempo_medio_coleta_horas;
  const elTempo = document.getElementById("pudo-tempo-coleta");
  if (horas === null || horas === undefined) {
    elTempo.textContent = "–";
  } else if (horas >= 24) {
    elTempo.textContent = `${(horas / 24).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}d`;
  } else {
    elTempo.textContent = `${horas.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}h`;
  }
}

function renderListaPudo(idContainer, linhas, chaveRotulo) {
  const el = document.getElementById(idContainer);
  if (!linhas || !linhas.length) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados no período.</span>`;
    return;
  }
  const max = Math.max(...linhas.map((l) => l.qtd), 1);
  el.innerHTML = linhas
    .map((l) => {
      const rotulo = l[chaveRotulo] || "—";
      const pct = Math.round((l.qtd / max) * 100);
      return `<div class="dropoff-linha">
        <span class="dropoff-linha-rotulo" title="${rotulo}">${rotulo}</span>
        <span class="dropoff-linha-valor">${l.qtd.toLocaleString("pt-BR")}</span>
        <span class="dropoff-linha-barra"><div style="width:${pct}%"></div></span>
      </div>`;
    })
    .join("");
}

// Paleta do donut -- ciclada por categoria (poucas categorias sempre,
// diferente de CORES_BARRA que e' por grafico inteiro).
const CORES_DONUT = ["var(--azul)", "var(--verde)", "var(--amarelo)", "var(--roxo)", "var(--vermelho)", "var(--laranja)"];

// Grafico de rosca (donut) generico -- "Status dos pacotes" (2026-09-17,
// pedido do usuario pra sair do formato lista/barrinha, poucas categorias
// combinam melhor com proporcao visual que com ranking). SVG puro (mesmo
// estilo dos outros graficos do painel, sem lib externa) via
// stroke-dasharray/stroke-dashoffset num circulo -- cada fatia e' um
// trecho do contorno, nao um <path> de arco calculado a mao.
function renderDonut(idContainer, linhas, campoRotulo, campoValor) {
  const el = document.getElementById(idContainer);
  if (!linhas || !linhas.length) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados no período.</span>`;
    return;
  }
  const total = linhas.reduce((soma, l) => soma + (l[campoValor] || 0), 0);
  if (!total) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados no período.</span>`;
    return;
  }
  const r = 54, cx = 70, cy = 70, largura = 22;
  const circunferencia = 2 * Math.PI * r;
  let acumulado = 0;
  const fatias = linhas
    .map((l, i) => {
      const valor = l[campoValor] || 0;
      const frac = valor / total;
      const comprimento = frac * circunferencia;
      const cor = CORES_DONUT[i % CORES_DONUT.length];
      const svg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cor}" stroke-width="${largura}"
        stroke-dasharray="${comprimento.toFixed(2)} ${(circunferencia - comprimento).toFixed(2)}"
        stroke-dashoffset="${(-acumulado).toFixed(2)}"><title>${l[campoRotulo]}: ${valor.toLocaleString("pt-BR")} (${(frac * 100).toFixed(1)}%)</title></circle>`;
      acumulado += comprimento;
      return svg;
    })
    .join("");
  const legenda = linhas
    .map((l, i) => {
      const valor = l[campoValor] || 0;
      const cor = CORES_DONUT[i % CORES_DONUT.length];
      const pct = ((valor / total) * 100).toFixed(1);
      return `<div class="donut-legenda-item">
        <span class="donut-cor" style="background:${cor}"></span>
        <span>${l[campoRotulo]}</span>
        <strong>${valor.toLocaleString("pt-BR")}</strong>
        <span class="donut-pct">(${pct}%)</span>
      </div>`;
    })
    .join("");
  el.innerHTML = `<div class="donut-wrap">
    <svg viewBox="0 0 140 140" class="donut-svg">
      <g transform="rotate(-90 ${cx} ${cy})">${fatias}</g>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-total">${total.toLocaleString("pt-BR")}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" class="donut-total-label">total</text>
    </svg>
    <div class="donut-legenda">${legenda}</div>
  </div>`;
}

// Grafico de barra HORIZONTAL generico -- "Top clientes" (2026-09-17,
// mesmo pedido: sair do formato lista/barrinha fina). Cada linha e' um
// <rect> de verdade (nao um <div> com width% dentro de uma trilha fina
// como .dropoff-linha-barra), rotulo a esquerda, valor a direita.
// Cache por container (mesmo padrao de _cacheGraficoMensal) -- precisa
// pra poder re-renderizar so' com a largura nova quando o ResizeObserver
// disparar, sem ter que re-buscar os dados de novo.
const _cacheBarraHorizontal = {};
// corFixa (2026-09-17, pedido do usuario): quando informada, todas as barras
// usam essa cor unica em vez de ciclar CORES_DONUT por linha -- o ciclo por
// linha faz sentido pra categorias distintas (como no donut), mas aqui cada
// linha e' so' um ranking do mesmo tipo de dado, uma cor so' fica mais limpo.
function renderBarraHorizontal(idContainer, linhas, campoRotulo, campoValor, corFixa) {
  const el = document.getElementById(idContainer);
  if (linhas) _cacheBarraHorizontal[idContainer] = { linhas, campoRotulo, campoValor, corFixa };
  linhas = linhas || (_cacheBarraHorizontal[idContainer] || {}).linhas;
  corFixa = corFixa || (_cacheBarraHorizontal[idContainer] || {}).corFixa;
  if (!linhas || !linhas.length) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados no período.</span>`;
    return;
  }
  const max = Math.max(...linhas.map((l) => l[campoValor] || 0), 1);
  const alturaLinha = 24;
  const padEsq = 4, padDir = 56;
  const larguraCaixa = Math.max(el.clientWidth || 400, 220);
  const larguraDisponivel = larguraCaixa - padEsq - padDir;
  const h = linhas.length * alturaLinha;
  const linhasSvg = linhas
    .map((l, i) => {
      const valor = l[campoValor] || 0;
      const y = i * alturaLinha;
      const larguraBarra = Math.max((valor / max) * larguraDisponivel, 3);
      const cor = corFixa || CORES_DONUT[i % CORES_DONUT.length];
      const rotulo = l[campoRotulo] || "—";
      return `<g>
        <text x="${padEsq}" y="${(y + 11).toFixed(1)}" class="grafico-barrah-rotulo" dominant-baseline="middle">${rotulo}</text>
        <rect x="${padEsq}" y="${(y + 14).toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="6" rx="3" fill="${cor}"><title>${rotulo}: ${valor.toLocaleString("pt-BR")}</title></rect>
        <text x="${(larguraCaixa - padDir + 8).toFixed(1)}" y="${(y + 20).toFixed(1)}" class="grafico-barrah-valor">${valor.toLocaleString("pt-BR")}</text>
      </g>`;
    })
    .join("");
  el.innerHTML = `<svg viewBox="0 0 ${larguraCaixa} ${h}" width="${larguraCaixa}" height="${h}">${linhasSvg}</svg>`;
}

let ultimaSeriePorDiaPudo = null;

// Cor por TIPO de grafico, nao por barra (correcao 2026-09-17 -- 1a
// tentativa ciclava uma cor por barra dentro do mesmo grafico, nao era
// isso que foi pedido). "Volume por dia" fica azul (cor original), o
// "Referencia mensal" fica roxo -- so' pra diferenciar os dois graficos
// entre si de relance, cada um continua monocromatico por dentro.
const COR_BARRA_DIARIO = "var(--azul)";
const COR_BARRA_MENSAL = "var(--roxo)";

function renderGraficoPudo(serie) {
  const el = document.getElementById("pudo-grafico");
  if (serie) ultimaSeriePorDiaPudo = serie;
  const pts = ultimaSeriePorDiaPudo || [];
  if (pts.length < 1) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados suficientes para o gráfico ainda.</span>`;
    return;
  }

  const padL = 56, padR = 16, padT = 14, padB = 30;
  const larguraCaixa = Math.max(el.clientWidth || 900, 320);
  const h = Math.max(el.clientHeight || 200, 130);
  const passo = Math.max(18, (larguraCaixa - padL - padR) / pts.length);
  const w = Math.round(padL + padR + passo * pts.length);
  const maxQtd = Math.max(...pts.map((p) => p.qtd), 1);
  const escalaY = (h - padT - padB) / maxQtd;
  const larguraBarra = Math.min(passo * 0.6, 36);

  const barras = pts
    .map((p, i) => {
      const x = padL + i * passo + (passo - larguraBarra) / 2;
      const altura = p.qtd * escalaY;
      const y = h - padB - altura;
      // rotulo do valor -- pedido do usuario 2026-09-17, pra nao precisar
      // estimar pela grade. Fica logo acima da barra; se a barra for alta
      // o suficiente pra encostar no topo do grafico, cola por dentro
      // (perto do topo da barra) em vez de vazar pra fora do SVG.
      const yRotulo = Math.max(y - 4, padT + 9);
      const rotuloValor = p.qtd
        ? `<text class="eixo-texto barra-rotulo" x="${(x + larguraBarra / 2).toFixed(1)}" y="${yRotulo.toFixed(1)}" text-anchor="middle">${p.qtd.toLocaleString("pt-BR")}</text>`
        : "";
      return `<rect class="barra-pudo" style="fill:${COR_BARRA_DIARIO}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${altura.toFixed(1)}" rx="2"><title>${p.dia}: ${p.qtd.toLocaleString("pt-BR")}</title></rect>${rotuloValor}`;
    })
    .join("");

  const passoRotX = Math.max(1, Math.ceil(pts.length / Math.max(6, Math.floor(w / 70))));
  const rotulosX = pts
    .map((p, i) => {
      if (i % passoRotX !== 0) return "";
      const x = padL + i * passo + passo / 2;
      return `<text class="eixo-texto" x="${x.toFixed(1)}" y="${h - 9}" text-anchor="middle">${p.dia.slice(8, 10)}/${p.dia.slice(5, 7)}</text>`;
    })
    .join("");

  const linhasGrade = [], rotulosY = [];
  const passosY = 4;
  for (let g = 0; g <= passosY; g++) {
    const valor = Math.round((maxQtd / passosY) * g);
    const y = h - padB - valor * escalaY;
    linhasGrade.push(`<line class="grade" x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}"/>`);
    rotulosY.push(`<text class="eixo-texto" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${valor.toLocaleString("pt-BR")}</text>`);
  }

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    ${linhasGrade.join("")}
    ${barras}
    ${rotulosY.join("")}
    ${rotulosX}
  </svg>`;
  tamGraficoPudoAtual = `${Math.round(el.clientWidth)}x${Math.round(el.clientHeight)}`;
}

let tamGraficoPudoAtual = "0x0";
new ResizeObserver((entradas) => {
  const r = entradas[0].contentRect;
  const chave = `${Math.round(r.width)}x${Math.round(r.height)}`;
  if (r.width > 0 && r.height > 0 && chave !== tamGraficoPudoAtual && ultimaSeriePorDiaPudo) {
    tamGraficoPudoAtual = chave;
    renderGraficoPudo(null);
  }
}).observe(document.getElementById("pudo-grafico"));

// --- Gráfico mensal genérico (Pudo/C2C, 2026-09-15) -- referência de
// "outros meses", separado da janela rolante de 30 dias. Poucos meses por
// enquanto (cresce devagar, 1 mês fechado por vez via run_mensal.py) --
// mesmo estilo visual do gráfico diário acima, parametrizado pra
// reaproveitar nos dois relatórios.
function formatarMesRotulo(mesIso) {
  const [ano, mes] = mesIso.slice(0, 7).split("-");
  return `${mes}/${ano}`;
}

const _cacheGraficoMensal = {};
function renderGraficoMensal(elId, serie, campoValor) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (serie) _cacheGraficoMensal[elId] = serie;
  const pts = _cacheGraficoMensal[elId] || [];
  if (pts.length < 1) {
    el.innerHTML = `<span class="taxas-grafico-titulo">Sem dados suficientes para o gráfico ainda.</span>`;
    return;
  }

  const padL = 64, padR = 16, padT = 14, padB = 28;
  const larguraCaixa = Math.max(el.clientWidth || 900, 320);
  // piso baixo (60, nao 120) -- achado em 2026-09-15: com a caixa mensal
  // fixa em 160px (~88px sobrando pro grafico depois do titulo), um piso
  // de 120 forcava o SVG a ficar mais alto que o proprio container e
  // vazar por baixo dele.
  const h = Math.max(el.clientHeight || 180, 60);
  // espaçamento SEMPRE estica pra preencher a caixa inteira (sem cap) --
  // achado em 2026-09-15: um cap fixo (260px/barra) deixava o SVG parado
  // em ~600px de largura mesmo dentro de uma caixa de >1800px (tela real
  // do usuário), sobrando uma área escura enorme e vazia à direita --
  // pareceu "espaço vazio gigante" bem pior do que o problema original
  // que o cap tentava evitar. A barra em si continua limitada (abaixo)
  // pra não virar um bloco gigante com poucos meses -- só o espaçamento
  // entre elas estica pra ocupar a caixa toda.
  const passo = Math.max(70, (larguraCaixa - padL - padR) / pts.length);
  const w = Math.round(padL + padR + passo * pts.length);
  const maxQtd = Math.max(...pts.map((p) => p[campoValor] || 0), 1);
  const escalaY = (h - padT - padB) / maxQtd;
  // barra bem mais larga que a do gráfico diário (que tem muito mais
  // pontos), mas capada em px absoluto pra não virar um bloco enorme
  // quando o passo esticado (acima) fica muito grande com poucos meses.
  const larguraBarra = Math.min(passo * 0.4, 160);

  const barras = pts
    .map((p, i) => {
      const x = padL + i * passo + (passo - larguraBarra) / 2;
      const valor = p[campoValor] || 0;
      const altura = valor * escalaY;
      const y = h - padB - altura;
      const rotulo = formatarMesRotulo(p.mes);
      const yRotulo = Math.max(y - 4, padT + 9);
      const rotuloValor = valor
        ? `<text class="eixo-texto barra-rotulo" x="${(x + larguraBarra / 2).toFixed(1)}" y="${yRotulo.toFixed(1)}" text-anchor="middle">${valor.toLocaleString("pt-BR")}</text>`
        : "";
      return `<rect class="barra-pudo" style="fill:${COR_BARRA_MENSAL}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${altura.toFixed(1)}" rx="2"><title>${rotulo}: ${valor.toLocaleString("pt-BR")}</title></rect>${rotuloValor}`;
    })
    .join("");

  const rotulosX = pts
    .map((p, i) => {
      const x = padL + i * passo + passo / 2;
      return `<text class="eixo-texto" x="${x.toFixed(1)}" y="${h - 8}" text-anchor="middle">${formatarMesRotulo(p.mes)}</text>`;
    })
    .join("");

  const linhasGrade = [], rotulosY = [];
  const passosY = 4;
  for (let g = 0; g <= passosY; g++) {
    const valor = Math.round((maxQtd / passosY) * g);
    const y = h - padB - valor * escalaY;
    linhasGrade.push(`<line class="grade" x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}"/>`);
    rotulosY.push(`<text class="eixo-texto" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${valor.toLocaleString("pt-BR")}</text>`);
  }

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    ${linhasGrade.join("")}
    ${barras}
    ${rotulosY.join("")}
    ${rotulosX}
  </svg>`;
}

async function carregarPudoMensal() {
  try {
    const serie = await buscarJson("/dropoff/pudo/mensal");
    // requestAnimationFrame -- achado em 2026-09-15: chamado logo depois de
    // trocar de aba, o container ainda mede clientWidth=0 (layout não
    // assentou), e o gráfico fica preso no fallback de 900px pra sempre
    // (o ResizeObserver sozinho não bastou pra pegar essa transição).
    requestAnimationFrame(() => renderGraficoMensal("pudo-grafico-mensal", serie, "total_pacotes"));
  } catch (e) {
    console.error(e);
  }
}

async function carregarC2CMensal() {
  try {
    const serie = await buscarJson("/dropoff/c2c/mensal");
    requestAnimationFrame(() => renderGraficoMensal("c2c-grafico-mensal", serie, "total_pedidos"));
  } catch (e) {
    console.error(e);
  }
}

// Sem isso o gráfico mensal nasce com clientWidth=0 (a aba ainda não
// tinha terminado o layout flex/sticky no primeiro render) e fica preso
// num fallback de 900px pra sempre -- barra espremida bem menor que a
// caixa real, sobrando espaço vazio enorme (achado em 2026-09-15, mesmo
// padrão que o gráfico diário do Pudo já resolve há mais tempo).
function observarGraficoMensal(elId, campoValor) {
  let tamAtual = "0x0";
  new ResizeObserver((entradas) => {
    const r = entradas[0].contentRect;
    const chave = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (r.width > 0 && r.height > 0 && chave !== tamAtual && _cacheGraficoMensal[elId]) {
      tamAtual = chave;
      renderGraficoMensal(elId, null, campoValor);
    }
  }).observe(document.getElementById(elId));
}
observarGraficoMensal("pudo-grafico-mensal", "total_pacotes");
observarGraficoMensal("c2c-grafico-mensal", "total_pedidos");

// Mesma protecao de redesenho pro "C2C por Pudo" (barra horizontal,
// 2026-09-17) -- so' esse depende de clientWidth (o donut usa viewBox
// fixo, nao precisa).
(() => {
  let tamAtual = "0x0";
  new ResizeObserver((entradas) => {
    const r = entradas[0].contentRect;
    const chave = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (r.width > 0 && r.height > 0 && chave !== tamAtual && _cacheBarraHorizontal["c2c-por-pudo"]) {
      tamAtual = chave;
      renderBarraHorizontal("c2c-por-pudo", null, "chave", "qtd", "var(--azul)");
    }
  }).observe(document.getElementById("c2c-por-pudo"));
})();

// Filtro de período (De/Até) -- 2026-09-14, travado no dia de hoje por
// padrão desde 2026-09-15 (igual o LMS -- usuário troca manualmente se
// quiser outro dia/intervalo). Limitado ao que o banco ainda guarda
// (retenção de 30 dias pra Pudo/C2C, ver etl/src/config.py).
function hojeISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

let pudoDataDe = hojeISO();
let pudoDataAte = hojeISO();
document.getElementById("pudo-data-de").value = pudoDataDe;
document.getElementById("pudo-data-ate").value = pudoDataAte;

function paramsPeriodo(de, ate) {
  const params = new URLSearchParams();
  if (de) params.set("de", de);
  if (ate) params.set("ate", ate);
  return params.toString();
}

async function carregarPudo() {
  const resumo = await buscarJson(`/dropoff/pudo/resumo?${paramsPeriodo(pudoDataDe, pudoDataAte)}`);
  renderCardsPudo(resumo);
  renderGraficoPudo(resumo.por_dia);
  renderListaPudo("pudo-por-cidade", resumo.por_cidade, "city");
  renderListaPudo("pudo-por-pudo", resumo.por_pudo, "site");
  renderListaPudo("pudo-por-origem", resumo.por_origem, "origem");
  renderDonut("pudo-por-status", resumo.por_status, "status", "qtd");
  atualizarBadgeExtracaoDropoff("pudo");
  carregarPudoMensal();
  carregarC2CRankingPudo();
}

document.getElementById("btn-exportar-pudo").addEventListener("click", async () => {
  try {
    const linhas = await buscarJson("/dropoff/pudo?limit=2000");
    if (!linhas.length) return;
    const planilha = XLSX.utils.json_to_sheet(linhas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, planilha, "Pudo");
    XLSX.writeFile(wb, `pudo_recentes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    console.error(e);
  }
});

function aplicarPeriodoPudo() {
  pudoDataDe = document.getElementById("pudo-data-de").value || null;
  pudoDataAte = document.getElementById("pudo-data-ate").value || null;
  carregarPudo();
}
document.getElementById("pudo-data-de").addEventListener("change", aplicarPeriodoPudo);
document.getElementById("pudo-data-ate").addEventListener("change", aplicarPeriodoPudo);

// --- C2C: tabela com prazo + relógio regressivo (mesmo padrão de Tickets) ---
let tabelaC2C = null;
let tabelaC2CPronta = false; // true so' depois do evento tableBuilt (redraw antes disso gera erro interno do Tabulator)
let c2cCache = [];
let c2cFiltroNoPrazo = false;
let c2cDataDe = hojeISO();
let c2cDataAte = hojeISO();
document.getElementById("c2c-data-de").value = c2cDataDe;
document.getElementById("c2c-data-ate").value = c2cDataAte;
const META_C2C_DIARIA = 200; // meta DEMO (o simulador gera ~150 pedidos/dia)
let c2cHojeOntem = { hoje: 0, ontem: 0 };

function colunasC2C() {
  return [
    { ...titulo("Número do Pedido", "订单号"), field: "order_id", headerFilter: "input", width: 155 },
    { ...titulo("Remessa", "运单号"), field: "waybill_no", headerFilter: "input", width: 135 },
    { ...titulo("Tipo Última Operação", "最新操作类型"), field: "latest_scan_type_name", headerFilter: "input", width: 150 },
    { ...titulo("Base Remetente", "发件网点"), field: "pick_network_name", headerFilter: "input", width: 115 },
    { ...titulo("Origem (Cidade)", "起始城市"), field: "origin_name", headerFilter: "input", width: 115 },
    { ...titulo("UF Origem", "起始省"), field: "origin_province", width: 80 },
    { ...titulo("Base de Entrega", "派送网点"), field: "dispatch_network_name", headerFilter: "input", width: 115 },
    { ...titulo("Destino", "目的地"), field: "destination_name", headerFilter: "input", width: 120 },
    { ...titulo("UF Destino", "目的省"), field: "destination_province", width: 80 },
    { ...titulo("Origem do Pedido", "订单来源"), field: "order_source_name", headerFilter: "input", width: 125 },
    { ...titulo("Status", "状态"), field: "is_sign_name", width: 120 },
    {
      ...titulo("Hora do Envio", "登记时间"), field: "input_time", width: 130,
      formatter: (c) => formatarData(c.getValue()), accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Prazo", "处理期限"), field: "prazo_limite", width: 135,
      formatter: (c) => (c.getValue() ? formatarData(c.getValue()) : "-"), accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Dias", "天数"), field: "prazo_dias", width: 65,
      formatter: (c) => (c.getValue() != null ? `${c.getValue()}d` : "-"),
    },
    {
      ...titulo("Tempo restante", "剩余时间"), field: "tempo_restante_ms", width: 170,
      formatter: (cell) => {
        const row = cell.getRow().getData();
        if (row.prazo_limite == null) return `<span class="tempo-atencao">sem abrangência</span>`;
        const ms = row.tempo_restante_ms ?? 0;
        const classe = ms <= 0 ? "tempo-critico" : ms <= 86_400_000 ? "tempo-atencao" : "tempo-ok";
        return `<span class="${classe}">${formatarDuracao(ms)}</span>`;
      },
    },
  ];
}

// Gauge "Meta x Realizado" -- arco SVG simples (círculo com stroke-dasharray
// proporcional ao %, capado em 100% visualmente mesmo se estourar a meta).
function renderGaugeC2C(atual, meta) {
  const pct = meta > 0 ? Math.min(atual / meta, 1) : 0;
  const raio = 54;
  const circunferencia = 2 * Math.PI * raio;
  const preenchido = circunferencia * pct;
  const cor = pct >= 1 ? "var(--verde)" : pct >= 0.7 ? "var(--azul)" : "var(--vermelho)";
  const pctTexto = meta > 0 ? Math.round(pct * 100) : 0;
  document.getElementById("c2c-gauge").innerHTML = `
    <svg viewBox="0 0 130 130" width="130" height="130">
      <circle cx="65" cy="65" r="${raio}" fill="none" stroke="var(--borda)" stroke-width="12"/>
      <circle cx="65" cy="65" r="${raio}" fill="none" stroke="${cor}" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${preenchido} ${circunferencia}"
        transform="rotate(-90 65 65)"/>
      <text x="65" y="72" text-anchor="middle" font-size="26" font-weight="800" fill="var(--texto)">${pctTexto}%</text>
    </svg>`;
  document.getElementById("c2c-gauge-atual").textContent = atual;
  document.getElementById("c2c-gauge-meta").textContent = meta;
}

async function carregarC2CHojeOntem() {
  try {
    c2cHojeOntem = await buscarJson("/dropoff/c2c/hoje");
  } catch (e) {
    console.error(e);
    c2cHojeOntem = { hoje: 0, ontem: 0 };
  }
  const { hoje, ontem } = c2cHojeOntem;
  document.getElementById("c2c-hoje").textContent = hoje;
  renderGaugeC2C(hoje, META_C2C_DIARIA);

  const cardEvolucao = document.getElementById("card-c2c-evolucao");
  const elEvolucao = document.getElementById("c2c-evolucao");
  cardEvolucao.classList.remove("subiu", "desceu");
  if (ontem === 0) {
    elEvolucao.textContent = hoje > 0 ? `+${hoje}` : "–";
    if (hoje > 0) cardEvolucao.classList.add("subiu");
  } else {
    const diff = hoje - ontem;
    const pctVar = (diff / ontem) * 100;
    const seta = diff > 0 ? "▲" : diff < 0 ? "▼" : "—";
    elEvolucao.textContent = `${seta} ${diff >= 0 ? "+" : ""}${diff} (${pctVar >= 0 ? "+" : ""}${pctVar.toFixed(0)}%)`;
    if (diff > 0) cardEvolucao.classList.add("subiu");
    else if (diff < 0) cardEvolucao.classList.add("desceu");
  }
}

// "C2C por Pudo" (2026-09-17) -- ranking de qual ponto Pudo especifico fez
// C2C. Pedido do usuario, 2a versao (a 1a, cruzando c2c_pedidos com
// pudo_coletas por id interno, foi descartada -- janelas rolantes com
// alcances diferentes deixavam muito pedido "sem correspondencia"). Essa
// versao NAO cruza nada -- so' filtra o proprio relatorio do Pudo pelas 4
// origens que so' existem quando o pedido foi feito diretamente pelo Pudo
// (nao marketplace X/Y/etc.), agrupado por station_name. Vive no painel Pudo
// (2026-09-17, relocado do painel C2C) porque a consulta filtra contra
// enter_time do proprio Pudo -- por isso usa a janela de datas da aba Pudo
// (pudoDataDe/pudoDataAte), nao a do C2C.
async function carregarC2CRankingPudo() {
  const el = document.getElementById("c2c-por-pudo");
  try {
    const dados = await buscarJson(`/dropoff/c2c/ranking-pudo?${paramsPeriodo(pudoDataDe, pudoDataAte)}`);
    const linhas = dados.ranking.map((r) => ({ chave: r.station_name || "—", qtd: r.qtd }));
    // rAF -- mesmo motivo do grafico mensal: na primeira troca de aba o
    // container as vezes ainda nao terminou o layout flex/sticky, clientWidth vem 0.
    requestAnimationFrame(() => renderBarraHorizontal("c2c-por-pudo", linhas, "chave", "qtd", "var(--azul)"));
    const info = document.getElementById("c2c-por-pudo-info");
    if (info) {
      info.title = `${dados.total} pedidos C2C feitos diretamente pelo Pudo (Origem do Pedido = Official Site/Partner App/Partner Web/Official H5), agrupados pelo ponto de coleta Pudo que os fez.`;
    }
  } catch (e) {
    console.error(e);
    el.innerHTML = `<span class="taxas-grafico-titulo">Falha ao carregar.</span>`;
  }
}

function recalcularCardsC2C() {
  const agora = Date.now();
  let fora = 0, semPrazo = 0, noPrazo = 0;
  for (const p of c2cCache) {
    if (p.prazo_limite == null) { semPrazo++; continue; }
    if (new Date(p.prazo_limite).getTime() < agora) fora++; else noPrazo++;
  }
  document.getElementById("c2c-total").textContent = c2cCache.length;
  document.getElementById("c2c-fora").textContent = fora;
  document.getElementById("c2c-sem-prazo").textContent = semPrazo;
  const base = noPrazo + fora;
  document.getElementById("c2c-taxa").textContent = base ? `${((noPrazo / base) * 100).toFixed(1)}%` : "–";
  const card = document.getElementById("card-c2c-taxa");
  const pct = base ? noPrazo / base : 1;
  card.classList.toggle("abaixo", base > 0 && pct < 0.9);
  card.classList.toggle("acima", base > 0 && pct >= 0.9);

  // listas: por UF de destino / origem do pedido / base (computadas no
  // front -- volume baixo o suficiente pra não precisar de agregação no
  // servidor). "pedidos hoje"/"evolução"/gauge de meta NÃO entram aqui --
  // vêm de /dropoff/c2c/hoje (carregarC2CHojeOntem), independentes do
  // filtro de período da tela (ver comentário em dropoff.js).
  renderListaPudo("c2c-por-uf", agregarContagem(c2cCache, "destination_province"), "chave");
  renderListaPudo("c2c-por-origem", agregarContagem(c2cCache, "order_source_name"), "chave");
  renderListaPudo("c2c-por-base", agregarContagem(c2cCache, "pick_network_name"), "chave");
}

function agregarContagem(linhas, campo) {
  const contagem = new Map();
  for (const l of linhas) {
    const chave = l[campo] || "—";
    contagem.set(chave, (contagem.get(chave) || 0) + 1);
  }
  return [...contagem.entries()]
    .map(([chave, qtd]) => ({ chave, qtd }))
    .sort((a, b) => b.qtd - a.qtd);
}

function aplicarFiltroC2C() {
  if (!tabelaC2C) return;
  const texto = document.getElementById("filtro-texto-c2c").value.toLowerCase();
  tabelaC2C.setFilter((d) => {
    if (c2cFiltroNoPrazo && (d.tempo_restante_ms == null || d.tempo_restante_ms <= 0)) return false;
    if (texto && !JSON.stringify(d).toLowerCase().includes(texto)) return false;
    return true;
  });
}

async function carregarC2C() {
  const dados = await buscarJson(`/dropoff/c2c?${paramsPeriodo(c2cDataDe, c2cDataAte)}`);
  c2cCache = dados.map((d) => ({
    ...d,
    tempo_restante_ms: d.prazo_limite ? new Date(d.prazo_limite).getTime() - Date.now() : null,
  }));
  recalcularCardsC2C();
  carregarC2CHojeOntem();
  carregarC2CMensal();

  if (!tabelaC2C) {
    tabelaC2C = new Tabulator("#tabela-c2c", {
      data: c2cCache,
      columns: colunasC2C(),
      index: "id",
      layout: "fitColumns",
      // vh explicito, nao "100%" -- achado em 2026-09-15: diferente das
      // outras tabelas com height:"100%" (Troncal/Secundaria/Candidatos/
      // Tickets), essas vivem dentro de .conteudo com overflow:hidden e
      // altura fixa pelo viewport, entao "100%" resolve limpo. #tabela-c2c
      // fica dentro de .painel-taxas, que ROLA por dentro (overflow-y:auto,
      // altura nao travada) com varios irmaos flex acima (controles, cards,
      // gauge/listas, grafico mensal) -- exatamente a mesma ambiguidade de
      // altura ja documentada e corrigida em estilo.css pro .modal-caixa
      // (2026-08-30): confirmado ao vivo com o usuario numa tela real de
      // 1920x1000 que "100%" deixava o tabulator-tableholder interno com
      // 281px mas as linhas renderizando ate 394px alem da borda de corte
      // (overflow visivel, "buraco preto" vazio embaixo da tabela) -- setar
      // height explicito em px via JS (setHeight) NAO resolveu, precisa ser
      // vh desde a criacao, igual o padrao ja provado no modal.
      height: "50vh",
      pagination: true,
      paginationSize: 100,
      paginationSizeSelector: [50, 100, 250, 500],
      columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
      placeholder: "Nenhum pedido C2C no período. / 期间无C2C订单。",
    });
    tabelaC2C.on("tableBuilt", () => {
      tabelaC2CPronta = true;
      requestAnimationFrame(() => tabelaC2C.redraw(true));
      // Reforço além do requestAnimationFrame -- achado em 2026-09-15: com
      // .taxas-controles sticky (2026-09-15) o layout às vezes leva mais
      // de 1 frame pra assentar, e um redraw(true) cedo demais deixa a
      // tabela com largura errada (coluna fantasma vazia na ponta direita).
      setTimeout(() => tabelaC2C.redraw(true), 300);
    });
    // ResizeObserver como rede de segurança extra -- qualquer mudança real
    // de largura do container (não só o assentamento inicial acima) força
    // um redraw, sem depender de acertar um tempo fixo.
    let tamTabelaC2CAtual = "0x0";
    new ResizeObserver((entradas) => {
      const r = entradas[0].contentRect;
      const chave = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (tabelaC2CPronta && r.width > 0 && r.height > 0 && chave !== tamTabelaC2CAtual) {
        tamTabelaC2CAtual = chave;
        tabelaC2C.redraw(true);
      }
    }).observe(document.getElementById("tabela-c2c"));
  } else {
    // setData([]) rejeita a promise no Tabulator ("Update Error - No data
    // provided") -- achado em 2026-09-15 depois de travar a data padrão em
    // "hoje" (dia sem nenhum C2C ainda deixa c2cCache = [] com frequência).
    // clearData() é o jeito certo do Tabulator de mostrar "sem linhas"
    // (fica o placeholder configurado), mas NÃO devolve Promise nesta
    // versão -- Promise.resolve() unifica os dois caminhos. .catch() é
    // rede de segurança pra qualquer outra rejeição não virar erro solto.
    Promise.resolve(c2cCache.length ? tabelaC2C.setData(c2cCache) : tabelaC2C.clearData())
      .then(() => {
        aplicarFiltroC2C();
        // achado 2026-09-17: so' o redraw do "tableBuilt" (1a construção)
        // nao bastava -- toda vez que o filtro de data troca (ou o ciclo
        // automatico recarrega), a LINHA de filtros do cabeçalho ("Número
        // do Pedido", "Remessa" etc.) ia ficando fora de sincronia com a
        // largura real das colunas depois de varias recargas seguidas
        // (usuario reportou visualmente desalinhado). redraw(true) de novo
        // aqui resincroniza sem custo perceptível.
        requestAnimationFrame(() => tabelaC2C.redraw(true));
      })
      .catch((e) => console.error("tabelaC2C:", e));
    atualizarBadgeExtracaoDropoff("c2c");
    return;
  }
  aplicarFiltroC2C();
  atualizarBadgeExtracaoDropoff("c2c");
}

function atualizarRelogioC2C() {
  if (moduloAtivo !== "dropoff" || relatorioAtivo !== "c2c" || !tabelaC2C) return;
  c2cCache.forEach((p) => {
    if (p.prazo_limite) p.tempo_restante_ms = new Date(p.prazo_limite).getTime() - Date.now();
  });
  // updateData() do Tabulator lança "No data provided" pra array vazio --
  // achado em 2026-09-15 depois de travar a data padrão em "hoje" (dia sem
  // nenhum C2C ainda deixa c2cCache = [] com frequência, coisa que quase
  // nunca acontecia com o filtro antigo de 15 dias). Nada pra atualizar
  // mesmo, só pula.
  if (c2cCache.length) tabelaC2C.updateData(c2cCache);
  recalcularCardsC2C();
}

document.getElementById("filtro-texto-c2c").addEventListener("input", aplicarFiltroC2C);
document.getElementById("filtro-c2c-no-prazo").addEventListener("change", (e) => {
  c2cFiltroNoPrazo = e.target.checked;
  aplicarFiltroC2C();
});
document.getElementById("btn-exportar-c2c").addEventListener("click", () => {
  if (tabelaC2C) tabelaC2C.download("xlsx", `c2c_${new Date().toISOString().slice(0, 10)}.xlsx`, { rowRange: "active" });
});

function aplicarPeriodoC2C() {
  c2cDataDe = document.getElementById("c2c-data-de").value || null;
  c2cDataAte = document.getElementById("c2c-data-ate").value || null;
  carregarC2C();
}
document.getElementById("c2c-data-de").addEventListener("change", aplicarPeriodoC2C);
document.getElementById("c2c-data-ate").addEventListener("change", aplicarPeriodoC2C);

// --- Saúde das extrações Pudo/C2C (badge + modal, mesmo padrão da Taxa de
// Expedição) -- visibilidade de falha parcial em vez de print perdido. ---
async function atualizarBadgeExtracaoDropoff(relatorio) {
  const ponto = document.getElementById(`extracao-${relatorio}-ponto`);
  const texto = document.getElementById(`extracao-${relatorio}-texto`);
  const textoZh = document.getElementById(`extracao-${relatorio}-texto-zh`);
  try {
    const lista = await buscarJson(`/dropoff/execucoes?relatorio=${relatorio}&limit=1`);
    if (!lista.length) {
      ponto.className = "ciclo-ponto";
      texto.textContent = "Extração: sem execuções ainda";
      textoZh.textContent = "数据提取：暂无记录";
      return;
    }
    const ultima = lista[0];
    const fim = ultima.finalizado_em || ultima.iniciado_em;
    const desde = formatarMinutosAtras(fim);
    const minAtras = Math.round((Date.now() - new Date(fim).getTime()) / 60000);
    // pudo roda a cada 1h, c2c a cada 30min -- folga de ~2.5x antes de avisar atraso
    const limiteAtraso = relatorio === "pudo" ? 150 : 90;

    if (ultima.status === "erro") {
      ponto.className = "ciclo-ponto erro";
      texto.textContent = `Extração: falhou (há ${desde})`;
      textoZh.textContent = `数据提取：失败（${desde}前）`;
    } else if (minAtras > limiteAtraso) {
      ponto.className = "ciclo-ponto atrasado";
      texto.textContent = `Extração: atrasada (última há ${desde})`;
      textoZh.textContent = `数据提取：延迟（上次${desde}前）`;
    } else if (ultima.status === "parcial") {
      ponto.className = "ciclo-ponto atrasado";
      texto.textContent = `Extração: parcial (há ${desde})`;
      textoZh.textContent = `数据提取：部分成功（${desde}前）`;
    } else {
      ponto.className = "ciclo-ponto ok";
      texto.textContent = `Extração: ok (há ${desde})`;
      textoZh.textContent = `数据提取：正常（${desde}前）`;
    }
  } catch (e) {
    console.error(e);
    ponto.className = "ciclo-ponto erro";
    texto.textContent = "Extração: falha ao consultar";
    textoZh.textContent = "数据提取：查询失败";
  }
}

function colunasExtracaoDropoff() {
  return [
    {
      ...titulo("Início", "开始时间"), field: "iniciado_em", width: 140,
      formatter: (c) => formatarData(c.getValue()), accessorDownload: (v) => acessorDataDownload(v),
    },
    {
      ...titulo("Duração", "耗时"), field: "duracao_segundos", width: 80,
      formatter: (c) => (c.getValue() == null ? "-" : `${c.getValue()}s`),
    },
    {
      ...titulo("Status", "状态"), field: "status", width: 90,
      formatter: (c) => {
        const v = c.getValue();
        const classe = v === "sucesso" ? "tempo-ok" : v === "parcial" ? "tempo-atencao" : "tempo-critico";
        return `<span class="${classe}">${v}</span>`;
      },
    },
    { ...titulo("Linhas", "行数"), field: "linhas_gravadas", width: 80 },
    { ...titulo("Erro", "错误"), field: "erro_mensagem", widthGrow: 2, headerFilter: "input" },
  ];
}

let tabelaExtracaoDropoff = null;

async function abrirModalExtracaoDropoff(relatorio) {
  document.getElementById("modal-extracao-dropoff-titulo").textContent =
    relatorio === "pudo" ? "Histórico da extração de Pudo" : "Histórico da extração de C2C";
  document.getElementById("modal-extracao-dropoff-overlay").hidden = false;
  try {
    const dados = await buscarJson(`/dropoff/execucoes?relatorio=${relatorio}&limit=30`);
    if (!tabelaExtracaoDropoff) {
      tabelaExtracaoDropoff = new Tabulator("#tabela-extracao-dropoff", {
        data: dados,
        columns: colunasExtracaoDropoff(),
        layout: "fitColumns",
        height: "55vh",
        columnDefaults: { hozAlign: "center", headerHozAlign: "center", accessorDownload: (v) => acessorNuloDownload(v) },
        placeholder: "Nenhuma execução registrada ainda. / 暂无记录。",
      });
      tabelaExtracaoDropoff.on("tableBuilt", () => requestAnimationFrame(() => tabelaExtracaoDropoff.redraw(true)));
    } else {
      tabelaExtracaoDropoff.setData(dados);
    }
  } catch (e) {
    console.error(e);
  }
}

function fecharModalExtracaoDropoff() {
  document.getElementById("modal-extracao-dropoff-overlay").hidden = true;
}

document.getElementById("badge-extracao-pudo").addEventListener("click", () => abrirModalExtracaoDropoff("pudo"));
document.getElementById("badge-extracao-c2c").addEventListener("click", () => abrirModalExtracaoDropoff("c2c"));
document.getElementById("modal-extracao-dropoff-fechar").addEventListener("click", fecharModalExtracaoDropoff);
document.getElementById("modal-extracao-dropoff-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-extracao-dropoff-overlay") fecharModalExtracaoDropoff();
});

// --- Login proprio do painel (2026-08-31, substitui o Cloudflare Access) ---
// Nada do bootstrap normal (abas, timers, etc.) roda antes de confirmar
// sessao valida -- ver server.js, toda rota de dado agora exige cookie.
let appIniciado = false;

function mostrarTelaLogin(mensagemErro) {
  document.getElementById("tela-login").hidden = false;
  const erroEl = document.getElementById("login-erro");
  if (mensagemErro) {
    erroEl.textContent = mensagemErro;
    erroEl.hidden = false;
  } else {
    erroEl.hidden = true;
  }
}

function iniciarApp(usuarioLogado, ehAdmin) {
  document.getElementById("tela-login").hidden = true;
  document.getElementById("usuario-logado-nome").textContent = usuarioLogado || "";
  // so' mostra o botao pra quem e' admin de verdade -- a API confere de
  // novo no banco em toda chamada de /api/usuarios, isso aqui e' so' UI.
  document.getElementById("btn-admin").hidden = !ehAdmin;
  if (appIniciado) return; // login apos sessao expirar no meio do uso -- nao duplica os timers
  appIniciado = true;

  roteador(); // lê o hash atual -- sem hash abre o menu inicial (#tela-inicio)
  atualizarRelogioTopo();
  atualizarBadgeCiclo();
  setInterval(atualizarTudo, INTERVALO_ATUALIZACAO_MS);
  setInterval(atualizarBadgeCiclo, INTERVALO_ATUALIZACAO_MS);
  setInterval(atualizarRelogioCandidatos, INTERVALO_RELOGIO_MS);
  setInterval(atualizarRelogioTickets, INTERVALO_RELOGIO_MS);
  setInterval(atualizarRelogioC2C, INTERVALO_RELOGIO_MS);
  setInterval(atualizarRelogioTopo, INTERVALO_RELOGIO_MS);
}

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = document.getElementById("login-usuario").value.trim();
  const senha = document.getElementById("login-senha").value;
  const lembrar = document.getElementById("login-lembrar").checked;
  const botao = document.getElementById("login-botao");
  botao.disabled = true;
  try {
    const resp = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha, lembrar }),
    });
    const dados = await resp.json();
    if (!resp.ok) {
      mostrarTelaLogin(dados.erro || "Falha ao entrar. / 登录失败。");
      return;
    }
    iniciarApp(dados.nome, dados.admin);
  } catch (erro) {
    mostrarTelaLogin("Falha de conexão. Tente novamente. / 连接失败，请重试。");
  } finally {
    botao.disabled = false;
  }
});

document.getElementById("btn-sair").addEventListener("click", async () => {
  try {
    await fetch(`${API}/auth/logout`, { method: "POST" });
  } finally {
    // reload em vez de so' trocar de tela -- limpa qualquer estado/timer
    // pendente e forca o checkAutenticacao rodar de novo do zero.
    location.reload();
  }
});

(async function verificarAutenticacaoEIniciar() {
  try {
    const resp = await fetch(`${API}/auth/me`);
    if (resp.ok) {
      const dados = await resp.json();
      iniciarApp(dados.nome || dados.usuario, dados.admin);
    } else {
      mostrarTelaLogin();
    }
  } catch (erro) {
    mostrarTelaLogin("Falha de conexão com o servidor. / 无法连接服务器。");
  }
})();
