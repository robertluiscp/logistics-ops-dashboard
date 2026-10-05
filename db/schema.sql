-- Painel de Operacao de Transporte -- Regional (demo)
-- Schema PostgreSQL
--
-- Os nomes de coluna seguem o dominio do painel (pernas, pacotes, bases...).
-- A traducao entre o formato da fonte de dados e este modelo acontece na
-- camada DataSource (etl/src/sources/), nunca aqui.

CREATE TABLE IF NOT EXISTS bases (
    codigo              TEXT PRIMARY KEY,        -- codigo unico da base/estacao
    nome                TEXT NOT NULL,
    tipo                TEXT,                     -- 'Regional' | 'Sorting Center' | 'DC' | 'Base Final'
    modelo_negocio      TEXT,                     -- 'Frota' | 'Franqueado'
    provincia           TEXT,                     -- 'PR' | 'SC' | 'RS'
    tipo_funcao         TEXT,
    atualizado_em       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pernas (
    id                    SERIAL PRIMARY KEY,
    shipment_no            TEXT NOT NULL,           -- id da viagem (prefixo indica troncal ou secundaria)
    tipo_perna            TEXT NOT NULL,           -- 'troncal' | 'secundaria'
    shipment_name           TEXT,                     -- nome/tarefa da viagem
    base_origem_codigo      TEXT REFERENCES bases(codigo),
    base_destino_codigo     TEXT REFERENCES bases(codigo),
    placa                TEXT,
    modelo_veiculo          TEXT,
    transportador           TEXT,
    motorista             TEXT,
    mileage               NUMERIC,
    -- Contagem AGREGADA (resumo por viagem, sem paginar pacote a pacote) --
    -- preenchida pra qualquer etapa exceto Planejado/Cancelado (barato).
    -- qtd_processada guarda o NUMERO REAL de descarregados: pode passar de
    -- carga_total ("pacote voando": descarregou mais do que foi carregado por
    -- esta viagem). So' a BARRA de % e' limitada a 100% -- na interface, nunca
    -- no banco. Ver docs/ENGINEERING_NOTES.md (item 6).
    carga_total            INTEGER,                 -- contagem agregada de carregamento (vale pro caminhao inteiro)
    qtd_processada          INTEGER,                 -- contagem agregada de descarregamento DESTA parada (sem limite)
    -- Colunas "Carregado e nao descarregado" / "Descarregado e nao carregado"
    -- que a propria fonte ja' calcula. carregado_nao_descarregado repete o mesmo
    -- valor em todas as paradas elegiveis da viagem (o carregamento vale pro
    -- caminhao inteiro, igual carga_total); descarregado_nao_carregado e' por
    -- parada especifica.
    carregado_nao_descarregado INTEGER,
    descarregado_nao_carregado INTEGER,
    hora_lacre             TIMESTAMP,               -- lacre do veiculo
    hora_deslacre           TIMESTAMP,               -- deslacre do veiculo -- inicio da janela de 6h
    planejado_partida        TIMESTAMP,
    planejado_chegada        TIMESTAMP,
    partida_real            TIMESTAMP,
    chegada_real            TIMESTAMP,
    shipment_state          INTEGER,                 -- codigo bruto de estado da fonte, guardado pra referencia
    etapa                TEXT NOT NULL DEFAULT 'Planejado',
        -- 'Planejado' | 'Carregando' | 'Em Transito' | 'Em Descarregamento' | 'Concluido' | 'Cancelado'
    prazo_limite            TIMESTAMP,               -- hora_deslacre + 6h
    primeira_deteccao        TIMESTAMP NOT NULL DEFAULT now(),
    atualizado_em           TIMESTAMP NOT NULL DEFAULT now(),
    -- base_destino_codigo entra na chave porque uma viagem Secundaria pode
    -- ter varias paradas (pernas) sob o mesmo shipment_no -- descoberto na
    -- primeira execucao real (2026-08-25/26), ver README.
    UNIQUE (shipment_no, tipo_perna, base_destino_codigo)
);

CREATE INDEX IF NOT EXISTS idx_pernas_etapa ON pernas (etapa);
CREATE INDEX IF NOT EXISTS idx_pernas_deslacre ON pernas (hora_deslacre);
CREATE INDEX IF NOT EXISTS idx_pernas_tipo ON pernas (tipo_perna);

CREATE TABLE IF NOT EXISTS pacotes (
    bill_code             TEXT PRIMARY KEY,         -- codigo unico do pacote
    perna_id              INTEGER REFERENCES pernas(id) ON DELETE SET NULL,
    shipment_no             TEXT,                     -- redundante com pernas.shipment_no, útil pra query direta

    -- Ponto de origem esperado (do evento de carregamento).
    -- Sem FK pra bases de proposito: essas colunas podem vir de fontes
    -- diferentes e as vezes trazem nome em vez de codigo (fallback) --
    -- uma FK aqui derrubaria o upsert do lote inteiro por causa de uma
    -- linha só. bases fica como catalogo enriquecido, nao como trava.
    network_code_esperado      TEXT,
    next_station_codigo       TEXT,

    -- Confirmacao de chegada -- desde 2026-08-30 vem da comparacao
    -- carregamento x descarregamento do mesmo shipment_no (nao de um campo de
    -- status da fonte), ver docs/ARCHITECTURE.md.
    -- Pra "Pacote Voando" (pacote_esperado == null), esses campos vem do
    -- proprio registro de descarregamento.
    latest_scan_type_name      TEXT,
    latest_scan_network_codigo   TEXT,
    latest_scan_time         TIMESTAMP,
    is_refund              BOOLEAN DEFAULT FALSE,

    status                TEXT NOT NULL DEFAULT 'Pendente',
        -- 'Pendente' | 'Candidato a Expedido não chegou' | 'Recebido' | 'Pacote Voando'
        -- | 'Outra base' | 'Devolução' | 'Status não definido'
        -- 'Pacote Voando': apareceu no descarregamento de um shipment_no
        -- sem ter sido carregado por ele (reexpedicao de backlog na base,
        -- comportamento normal -- nao e' problema).
    candidato_desde          TIMESTAMP,                -- quando o ultimo bipe conhecido ficou "preso" -- corre contra as 6h
    carregado_em             TIMESTAMP,                -- quando foi carregado pela viagem (bipe de carregamento)

    xlsx_exportado_em         TIMESTAMP,

    -- Confirmacao registrada por um operador na fonte de dados --
    -- so pra auditoria (responsavel.py), nao decide mais "chegou ou nao"
    -- (isso agora vem de latest_scan_time acima).
    is_abnormal             BOOLEAN DEFAULT FALSE,
    motivo_confirmado_lms      TEXT,                     -- motivo informado pelo operador
    registrado_em_lms         TIMESTAMP,                -- quando o operador registrou
    base_registro_lms_codigo    TEXT, -- base onde foi registrado

    responsavel             TEXT,                     -- 'base anterior' | 'base atual' -- regra das 6h

    primeira_deteccao         TIMESTAMP NOT NULL DEFAULT now(),
    atualizado_em            TIMESTAMP NOT NULL DEFAULT now()
);
        
CREATE INDEX IF NOT EXISTS idx_pacotes_status ON pacotes (status);
CREATE INDEX IF NOT EXISTS idx_pacotes_perna ON pacotes (perna_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_shipment ON pacotes (shipment_no);
CREATE INDEX IF NOT EXISTS idx_pacotes_candidato_desde ON pacotes (candidato_desde);

CREATE TABLE IF NOT EXISTS historico_status (
    id             SERIAL PRIMARY KEY,
    bill_code        TEXT NOT NULL,
    status_anterior    TEXT,
    status_novo      TEXT NOT NULL,
    mudou_em        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_historico_bill_code ON historico_status (bill_code);

-- Log persistente de cada execucao do ETL (etl/src/main.py) -- sem isso,
-- so' dava pra saber se o ciclo automatico (Task Scheduler, ver
-- docs/ENGINEERING_NOTES.md) esta' saudavel olhando
-- o terminal na hora. Uma linha por execucao, sucesso ou falha.
CREATE TABLE IF NOT EXISTS execucoes_etl (
    id                  SERIAL PRIMARY KEY,
    iniciado_em            TIMESTAMP NOT NULL,
    finalizado_em           TIMESTAMP,
    duracao_segundos         INTEGER,
    status                TEXT NOT NULL,             -- 'sucesso' | 'erro'
    erro_mensagem           TEXT,
    pernas_total            INTEGER,
    pacotes_total            INTEGER,
    pacotes_voando           INTEGER,
    candidatos_total          INTEGER,
    candidatos_perto_prazo      INTEGER,
    xlsx_gerado             TEXT
);

CREATE INDEX IF NOT EXISTS idx_execucoes_iniciado_em ON execucoes_etl (iniciado_em DESC);

-- Login proprio do painel: uma unica tela, sessao por cookie httpOnly. Contas
-- criadas por um administrador (tela de administracao) ou pela CLI
-- (api/scripts/criar_usuario.js), sempre com senha temporaria aleatoria;
-- so' o hash bcrypt e' guardado. Sem cadastro aberto nem "esqueci a senha".
CREATE TABLE IF NOT EXISTS usuarios (
    id             SERIAL PRIMARY KEY,
    usuario          TEXT NOT NULL UNIQUE,
    senha_hash        TEXT NOT NULL,         -- bcrypt, nunca texto puro
    nome            TEXT,
    ativo           BOOLEAN NOT NULL DEFAULT true,
    criado_em         TIMESTAMP NOT NULL DEFAULT now(),
    ultimo_login_em     TIMESTAMP
);

-- admin: quem pode gerenciar outras contas na tela de administracao
-- (2026-08-31) -- ADD COLUMN separado (nao dentro do CREATE TABLE) porque
-- a tabela ja existia em producao com contas reais quando essa coluna foi
-- criada; IF NOT EXISTS deixa idempotente igual ao resto do arquivo.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin BOOLEAN NOT NULL DEFAULT false;

-- Rate-limiter COMPARTILHADO ENTRE PROCESSOS para chamadas a um gateway
-- externo. Varias tarefas agendadas (run.py, run_c2c.py, run_pudo.py,
-- run_tickets.py, run_taxas.py, run_carga_processado.py) podem rodar ao mesmo
-- tempo; sem um throttle comum, cada uma respeitaria o limite sozinha e
-- somadas estourariam o limite do WAF do gateway.
--   ultima_chamada -> espaca o INICIO de cada chamada (fila global)
--   em_andamento   -> capa quantas chamadas ficam ABERTAS ao mesmo tempo,
--                     somando todos os processos
--   slot_atualizado_em -> ultima vez que um slot foi pego OU devolvido;
--                     se o teto ficar cheio por muito tempo sem nenhuma das
--                     duas coisas, e' vazamento (processo morto na marra) e
--                     o contador se recupera sozinho
-- Ver etl/src/common/throttle.py (a tabela tambem e' criada la' quando
-- scripts standalone rodam sem passar por aplicar_schema()).
CREATE TABLE IF NOT EXISTS throttle_global (
    id                 INT PRIMARY KEY,
    ultima_chamada     TIMESTAMPTZ NOT NULL DEFAULT now(),
    em_andamento       INT NOT NULL DEFAULT 0,
    slot_atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO throttle_global (id) VALUES (1) ON CONFLICT DO NOTHING;
-- Ao reiniciar o schema (so' no inicio do ciclo principal) zera slots
-- possivelmente vazados: nenhuma chamada real dura mais que alguns minutos.
UPDATE throttle_global SET em_andamento = 0 WHERE id = 1;

-- Taxa de expedicao no prazo -- 3 indicadores dos relatorios
-- de taxa da fonte: SC->HUB (inward), SC->SC (departure), HUB->PDD
-- (bulk). Uma linha por (dia operacional, tipo, SC de origem, DC de
-- destino quando aplicavel). Extracao 1x/dia (etl/run_taxas.py) -- esses
-- numeros so' fecham depois do dia operacional (14:00 as 14:00 pros dois
-- primeiros, meia-noite a meia-noite pro bulk). Consolidacoes (semana/mes/
-- por regional) sao calculadas na leitura somando as contagens brutas --
-- a media certa de um periodo e' Sum(no_prazo)/Sum(total), nao media das %.
CREATE TABLE IF NOT EXISTS taxas_expedicao (
    id                 SERIAL PRIMARY KEY,
    data               DATE NOT NULL,               -- dia operacional (scanTime/sendDate/counDate)
    tipo               TEXT NOT NULL,               -- 'sc_hub' | 'sc_sc' | 'hub_pdd'
    regional_codigo    TEXT,
    regional_nome      TEXT,
    sc_codigo          TEXT NOT NULL,               -- centro de origem
    sc_nome            TEXT,
    dc_codigo          TEXT NOT NULL DEFAULT '',     -- so' pra 'hub_pdd' (jsNetworkCode do DC destino); '' nos outros
    dc_nome            TEXT,
    qtd_total          INTEGER NOT NULL,            -- total de pacotes do periodo
    qtd_no_prazo       INTEGER NOT NULL,            -- pacotes dentro do prazo
    qtd_fora_prazo     INTEGER,                     -- noTimelyNum / untimelyNum / jsNoTimelyVotes
    taxa               NUMERIC,                     -- fracao 0..1 -- valor QUE O LMS MOSTRA (parseado de "90.13%"),
                                                    -- pra visao detalhada bater linha a linha; agregados recalculam
    -- especificos de sc_sc (departure):
    qtd_sem_viagem     INTEGER,                     -- unShiftNum
    qtd_sem_rota       INTEGER,                     -- unrouteNum
    qtd_sem_chegada    INTEGER,                     -- unarriveNum
    qtd_destino_errado INTEGER,                     -- wrongNum
    bilhetes_op_habil  INTEGER,                     -- operationTimelyNum
    -- especificos de sc_hub (inward):
    qtd_sem_shift      INTEGER,                     -- noShiftCount
    -- especificos de hub_pdd (bulk):
    qtd_anomalia       INTEGER,                     -- abnormalTimelyVotes
    qtd_falta_cod_2seg INTEGER,                     -- secondLossVotes
    atualizado_em      TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (data, tipo, sc_codigo, dc_codigo)
);

CREATE INDEX IF NOT EXISTS idx_taxas_data ON taxas_expedicao (data DESC);
CREATE INDEX IF NOT EXISTS idx_taxas_tipo ON taxas_expedicao (tipo);

-- Tickets de reclamacao do SAC -- 2 relatorios da fonte: "comum" (clientes
-- comuns: Client A/B/C...) e "plataforma" (exclusivo Marketplace, regras proprias).
-- Cada run do etl/run_tickets.py e' um SNAPSHOT dos tickets AINDA NAO
-- TRATADOS (status "Processando" / "Pendente" / "Em processamento") na
-- janela de ~15 dias -- por isso a extracao apaga tudo do `tipo` e reinsere
-- (ticket tratado some do proximo snapshot). Prazo de tratamento:
--   comum      -> data_registro + 24h
--   plataforma -> data_registro + 12h se o tipo nivel II comeca com "[PRIORITY]",
--                 senao + 48h
CREATE TABLE IF NOT EXISTS tickets_reclamacao (
    id                  TEXT PRIMARY KEY,           -- id do ticket no LMS
    tipo                TEXT NOT NULL,              -- 'comum' | 'plataforma'
    work_order_no       TEXT,
    waybill_no          TEXT,
    canal               TEXT,                      -- 'TIKTOK' / 'email' / 'chat' / ...
    tipo_i_nome         TEXT,                      -- tipo nivel I
    tipo_ii_nome        TEXT,                      -- tipo nivel II (onde vem "[PRIORITY] ...")
    eh_priority            BOOLEAN NOT NULL DEFAULT false,
    descricao_problema  TEXT,
    status_codigo       TEXT,
    status_nome         TEXT,
    estacao_aceitacao   TEXT,                      -- acceptNetworkName
    regional_aceitacao  TEXT,                      -- acceptBelongNetworkName / acceptNetworkProxyName
    cliente_nome        TEXT,                      -- comum: callBackName/orderSourceName ; plataforma: 'TIKTOK'
    responsavel_nome    TEXT,                      -- acceptByName
    is_last_mile        BOOLEAN,                   -- plataforma: "Esta no Last Mile?"
    data_registro       TIMESTAMP NOT NULL,        -- createTime / registrationTime
    horas_sla           NUMERIC NOT NULL,          -- 24 / 22 / 44
    prazo_limite        TIMESTAMP NOT NULL,        -- data_registro + horas_sla
    surplus_process_min INTEGER,                   -- tempo restante segundo a fonte (referencia)
    atualizado_em       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_tipo ON tickets_reclamacao (tipo);
CREATE INDEX IF NOT EXISTS idx_tickets_prazo ON tickets_reclamacao (prazo_limite);

-- Log de execucao do run_tickets.py -- registrado pra dar visibilidade de
-- falha parcial no painel (2026-09-11: descoberto que a task diaria de
-- taxas falhou silenciosamente pra sc_hub/sc_sc por um dia inteiro sem
-- ninguem perceber, porque a scheduled task nao tinha saida capturada em
-- lugar nenhum -- so' o run.py tinha isso, via execucoes_etl).
CREATE TABLE IF NOT EXISTS execucoes_taxas (
    id                SERIAL PRIMARY KEY,
    iniciado_em       TIMESTAMP NOT NULL,
    finalizado_em     TIMESTAMP,
    status            TEXT NOT NULL,        -- 'sucesso' | 'parcial' | 'erro'
    dias_alvo         INTEGER,
    linhas_gravadas   INTEGER,
    falhas            TEXT,                 -- resumo textual (dia + tipo + erro), NULL se tudo ok
    duracao_segundos  INTEGER,
    erro_mensagem     TEXT
);
CREATE INDEX IF NOT EXISTS idx_execucoes_taxas_iniciado ON execucoes_taxas (iniciado_em DESC);

-- Dropoff & C2C (2026-09-11) -- 2 novos relatorios LMS + tabela de prazo
-- de referencia (planilha Abrangencia Nacional, mantida manualmente pelo
-- time de ops, re-importada quando sai versao nova).
--
--   pudo_coletas -- tudo bipado pelos pontos de coleta parceiros (app Pudo).
--     Volume altissimo (~15-30 mil/dia) -- janela rolante de
--     PUDO_JANELA_DIAS (nao da' pra reconstituir o historico anual
--     paginando a fonte).
--   c2c_pedidos -- pedidos C2C (consumidor -> consumidor), volume bem
--     menor. Prazo final calculado via abrangencia_prazos (Cidade Destino +
--     UF -> dias corridos a partir da base-tronco de origem, contados da
--     "Hora de envio").

-- Tabela de referencia de prazo de entrega: 1 linha por (municipio, uf).
-- Quando uma fonte real tem mais de um prazo por municipio (faixas de CEP),
-- usa-se o MAIOR (mais conservador). No modo demo e' populada por
-- etl/seed_demo.py com municipios ficticios.
CREATE TABLE IF NOT EXISTS abrangencia_prazos (
    id               SERIAL PRIMARY KEY,
    municipio        TEXT NOT NULL,
    municipio_norm   TEXT NOT NULL,        -- maiusculo, sem acento -- join robusto
    estado           TEXT,
    uf               TEXT NOT NULL,
    regiao           TEXT,
    prazo_hub1_dias   INTEGER NOT NULL,     -- dias corridos partindo de PR HUB1
    prazo_hub2_dias   INTEGER NOT NULL,     -- dias corridos partindo de SC HUB2
    prazo_hub3_dias   INTEGER NOT NULL,     -- dias corridos partindo de RS HUB3
    versao_arquivo   TEXT,                 -- ex "07-2026", da planilha importada
    atualizado_em    TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (municipio_norm, uf)
);

CREATE TABLE IF NOT EXISTS pudo_coletas (
    order_no          TEXT PRIMARY KEY,
    billcode          TEXT,
    order_source_name TEXT,
    mail_name         TEXT,
    input_time        TIMESTAMP,
    enter_time        TIMESTAMP NOT NULL,   -- quando bipado no ponto Pudo (D0)
    pick_agent_name   TEXT,                 -- provincia (PR/SC/RS)
    pick_network_name TEXT,                 -- rede/base do ponto de coleta
    station_code      TEXT,
    station_name      TEXT,
    province          TEXT,
    city              TEXT,
    order_type_export TEXT,                 -- status em texto (已揽收 etc)
    order_type        INTEGER,
    goods_name        TEXT,
    customer_code     TEXT,
    atualizado_em     TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pudo_enter_time ON pudo_coletas (enter_time DESC);
CREATE INDEX IF NOT EXISTS idx_pudo_pick_network ON pudo_coletas (pick_network_name);

CREATE TABLE IF NOT EXISTS c2c_pedidos (
    id                      TEXT PRIMARY KEY,     -- id do LMS
    order_id                TEXT,                 -- "Número do Pedido" (orderId, diferente da remessa)
    waybill_no              TEXT,
    numero_encomenda_interna TEXT,                -- "Número de encomenda interna" -- achado 2026-09-17:
                                                    -- chave pra cruzar C2C origem PUDO (D700) de volta
                                                    -- com pudo_coletas.order_no (qual Pudo fez o C2C) --
                                                    -- so' cobre o que ainda estiver na janela rolante do
                                                    -- Pudo no momento da consulta, ver ranking na API.
    order_source_code       TEXT,
    order_source_name       TEXT,
    pick_network_name       TEXT,                 -- "Base Remetente" -- ponto de coleta de origem
    origin_name             TEXT,                 -- "Origem" (cidade de origem)
    origin_province         TEXT,                 -- provincia de origem (PR/SC/RS) -> escolhe a coluna de prazo
    dispatch_network_name   TEXT,                 -- "Base de Entrega"
    destination_name        TEXT,                 -- Cidade Destino -- chave do join com abrangencia_prazos
    destination_province    TEXT,                 -- UF Destino -- chave do join
    package_number          INTEGER,
    goods_type_name         TEXT,
    waybill_weight          NUMERIC,
    input_time               TIMESTAMP NOT NULL,  -- "Hora de envio" -- inicio da contagem do prazo
    collect_time             TIMESTAMP,
    is_sign                  INTEGER,
    is_sign_name             TEXT,
    sign_time                TIMESTAMP,
    latest_scan_type_name     TEXT,                -- "Tipo da Última Operação"
    latest_scan_network_name  TEXT,                -- base da última operação
    latest_scan_time           TIMESTAMP,           -- horário da última operação
    prazo_dias                INTEGER,             -- achado na abrangencia_prazos (dias corridos)
    prazo_limite               TIMESTAMP,           -- input_time + prazo_dias
    abrangencia_encontrada      BOOLEAN NOT NULL DEFAULT false,
    atualizado_em                TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_c2c_input_time ON c2c_pedidos (input_time DESC);
CREATE INDEX IF NOT EXISTS idx_c2c_prazo ON c2c_pedidos (prazo_limite);
-- 2026-09-11: colunas adicionadas depois que a tabela ja' existia em
-- producao (CREATE TABLE IF NOT EXISTS acima nao altera tabela existente).
ALTER TABLE c2c_pedidos ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE c2c_pedidos ADD COLUMN IF NOT EXISTS latest_scan_type_name TEXT;
ALTER TABLE c2c_pedidos ADD COLUMN IF NOT EXISTS latest_scan_network_name TEXT;
ALTER TABLE c2c_pedidos ADD COLUMN IF NOT EXISTS latest_scan_time TIMESTAMP;
ALTER TABLE c2c_pedidos ADD COLUMN IF NOT EXISTS numero_encomenda_interna TEXT;
CREATE INDEX IF NOT EXISTS idx_c2c_encomenda_interna ON c2c_pedidos (numero_encomenda_interna);

-- Log de execucao (mesmo padrao de execucoes_taxas -- visibilidade de
-- falha parcial no painel em vez de print perdido).
CREATE TABLE IF NOT EXISTS execucoes_dropoff (
    id                SERIAL PRIMARY KEY,
    relatorio         TEXT NOT NULL,        -- 'pudo' | 'c2c'
    iniciado_em       TIMESTAMP NOT NULL,
    finalizado_em     TIMESTAMP,
    status            TEXT NOT NULL,        -- 'sucesso' | 'parcial' | 'erro'
    linhas_gravadas   INTEGER,
    erro_mensagem     TEXT,
    duracao_segundos  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_execucoes_dropoff_iniciado ON execucoes_dropoff (relatorio, iniciado_em DESC);

-- 2026-09-14: colunas adicionadas depois que `pernas` ja' existia em
-- producao (CREATE TABLE IF NOT EXISTS acima nao altera tabela existente).
-- Ver comentario ao lado da definicao de `pernas` acima.
ALTER TABLE pernas ADD COLUMN IF NOT EXISTS carregado_nao_descarregado INTEGER;
ALTER TABLE pernas ADD COLUMN IF NOT EXISTS descarregado_nao_carregado INTEGER;

-- Job frequente (~20min) que so' atualiza carga_total/qtd_processada/
-- carregado_nao_descarregado/descarregado_nao_carregado das pernas ja'
-- gravadas -- separado do ciclo principal (1h) pra reduzir a defasagem em
-- viagens de varias paradas, onde o bipe de descarregamento de paradas
-- tardias pode acontecer horas depois da primeira parada (ver
-- docs/ENGINEERING_NOTES.md). Mesmo padrao
-- de log que execucoes_taxas/execucoes_dropoff.
CREATE TABLE IF NOT EXISTS execucoes_carga_processado (
    id                 SERIAL PRIMARY KEY,
    iniciado_em        TIMESTAMP NOT NULL,
    finalizado_em      TIMESTAMP,
    status             TEXT NOT NULL,        -- 'sucesso' | 'parcial' | 'erro'
    pernas_verificadas INTEGER,
    linhas_gravadas    INTEGER,
    erro_mensagem      TEXT,
    duracao_segundos   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_execucoes_carga_processado_iniciado ON execucoes_carga_processado (iniciado_em DESC);

-- Agregados MENSAIS de Pudo/C2C (2026-09-15) -- referencia de "outros meses
-- do ano" alem da janela rolante de 30 dias em pudo_coletas/c2c_pedidos.
-- So' o NUMERO final por mes, nunca pacote a pacote -- Pudo sozinho passa
-- de 1 MILHAO de registros/mes a nivel nacional (medido ao vivo em
-- 2026-09-15, Agosto/2026), inviavel guardar isso no Postgres. O numero e'
-- calculado paginando a API inteira pro mes (sem filtro de regiao no lado
-- do servidor -- testado e nao existe) e contando em memoria do lado de ca,
-- devagar, so' os meses fechados -- ver run_mensal.py e
-- docs/ENGINEERING_NOTES.md.
CREATE TABLE IF NOT EXISTS pudo_mensal (
    id              SERIAL PRIMARY KEY,
    mes             DATE NOT NULL,        -- primeiro dia do mes, ex 2026-08-01
    total_pacotes   INTEGER NOT NULL,
    total_dropoffs  INTEGER,              -- count distinct station_name (Regional)
    bases_ativas    INTEGER,              -- count distinct pick_network_name (Regional)
    atualizado_em   TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (mes)
);

CREATE TABLE IF NOT EXISTS c2c_mensal (
    id              SERIAL PRIMARY KEY,
    mes             DATE NOT NULL,
    total_pedidos   INTEGER NOT NULL,
    atualizado_em   TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (mes)
);

-- Historico DIARIO permanente (2026-09-17, pedido explicito do usuario) --
-- diferente de pudo_coletas/c2c_pedidos (janela rolante de 30 dias, se
-- auto-apaga) e diferente de pudo_mensal/c2c_mensal (so' o total do mes).
-- So' o numero final do dia (nao pacote a pacote), calculado a partir do
-- que o self-heal JA' capturou nas tabelas rolantes -- nao precisa de
-- chamada nova a API. Job roda 1x por dia logo depois da meia-noite,
-- processando o dia anterior (ja' fechado) -- ver run_diario.py.
CREATE TABLE IF NOT EXISTS pudo_diario (
    id              SERIAL PRIMARY KEY,
    dia             DATE NOT NULL,
    total_pacotes   INTEGER NOT NULL,
    total_dropoffs  INTEGER,
    bases_ativas    INTEGER,
    atualizado_em   TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (dia)
);

CREATE TABLE IF NOT EXISTS c2c_diario (
    id              SERIAL PRIMARY KEY,
    dia             DATE NOT NULL,
    total_pedidos   INTEGER NOT NULL,
    atualizado_em   TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (dia)
);

-- Log de execucao do backfill mensal -- mesmo padrao de execucoes_taxas/
-- execucoes_dropoff, mas cada linha cobre 1 mes (pudo OU c2c) processado.
CREATE TABLE IF NOT EXISTS execucoes_mensal (
    id                 SERIAL PRIMARY KEY,
    relatorio          TEXT NOT NULL,        -- 'pudo' | 'c2c'
    mes                DATE NOT NULL,
    iniciado_em        TIMESTAMP NOT NULL,
    finalizado_em      TIMESTAMP,
    status             TEXT NOT NULL,        -- 'sucesso' | 'erro'
    total_contado      INTEGER,
    paginas_percorridas INTEGER,
    erro_mensagem      TEXT,
    duracao_segundos   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_execucoes_mensal_iniciado ON execucoes_mensal (relatorio, iniciado_em DESC);

-- Bancos criados antes desta coluna existir (CREATE TABLE IF NOT EXISTS nao altera tabela existente).
ALTER TABLE pacotes ADD COLUMN IF NOT EXISTS carregado_em TIMESTAMP;
