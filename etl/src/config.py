"""Configuracao central do ETL -- tudo vem de variaveis de ambiente (.env).

Nenhuma URL, credencial ou codigo de sistema externo fica no repositorio:
a fonte de dados e' escolhida por `DATA_SOURCE` (ver src/sources/).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

RAIZ_PROJETO = Path(__file__).resolve().parents[2]
load_dotenv(RAIZ_PROJETO / ".env")

# --- Fonte de dados ---------------------------------------------------------
# "demo" (padrao) gera uma operacao SINTETICA e deterministica, sem rede.
# Um adaptador real (ver src/sources/README.md) implementa o mesmo contrato.
DATA_SOURCE = os.getenv("DATA_SOURCE", "demo")
DEMO_SEED = int(os.getenv("DEMO_SEED", "42"))

# --- Pastas -----------------------------------------------------------------
PASTA_DATA = RAIZ_PROJETO / "data"
PASTA_EXPORTS = PASTA_DATA / "exports"

# --- PostgreSQL -------------------------------------------------------------
PG_CONFIG = {
    "host": os.getenv("PGHOST", "localhost"),
    "port": os.getenv("PGPORT", "5432"),
    "dbname": os.getenv("PGDATABASE", "logistics_ops"),
    "user": os.getenv("PGUSER"),
    "password": os.getenv("PGPASSWORD"),
}

# --- Regras de negocio ------------------------------------------------------
# Janela (horas) entre o deslacre do veiculo e a transferencia de
# responsabilidade do pacote da base que despachou para a que recebeu.
PRAZO_LIMITE_HORAS = int(os.getenv("PRAZO_LIMITE_HORAS", "6"))

# Retencao das tabelas rolantes de detalhe (dias). Historico de longo prazo
# vive nas tabelas *_diario / *_mensal (so' agregados, nunca pacote a pacote).
PUDO_JANELA_DIAS = int(os.getenv("PUDO_JANELA_DIAS", "30"))
C2C_JANELA_DIAS = int(os.getenv("C2C_JANELA_DIAS", "30"))
TICKET_JANELA_DIAS = int(os.getenv("TICKET_JANELA_DIAS", "15"))
# `pacotes` tambem e' rolante: poda o que ficou sem atividade alem da janela.
PACOTES_JANELA_DIAS = int(os.getenv("PACOTES_JANELA_DIAS", "30"))

# SLA de tratamento dos tickets (horas a partir do registro).
TICKET_SLA_COMUM_HORAS = float(os.getenv("TICKET_SLA_COMUM_HORAS", "24"))
TICKET_SLA_PLATAFORMA_PRIORITY_HORAS = float(os.getenv("TICKET_SLA_PLATAFORMA_PRIORITY_HORAS", "12"))
TICKET_SLA_PLATAFORMA_PADRAO_HORAS = float(os.getenv("TICKET_SLA_PLATAFORMA_PADRAO_HORAS", "48"))

# Estados cobertos pela regional e a coluna de prazo (hub de referencia) de
# cada um em abrangencia_prazos.
REGIAO_ESTADOS = ("PR", "SC", "RS")
HUB_POR_ESTADO = {"PR": "prazo_hub1_dias", "SC": "prazo_hub2_dias", "RS": "prazo_hub3_dias"}

# Codigos de "origem do pedido" que contam como C2C (a fonte demo usa estes).
C2C_ORDER_SOURCE_CODES = tuple(os.getenv("C2C_ORDER_SOURCE_CODES", "S01,S02,S03,S04,S05,S06,S07").split(","))

# --- Alerta proativo (webhook Feishu/Lark, opcional) -------------------------
# Sem URL preenchida o alerta simplesmente fica desligado (nao gera erro).
FEISHU_WEBHOOK_URL = os.getenv("FEISHU_WEBHOOK_URL", "")
FEISHU_WEBHOOK_SECRET = os.getenv("FEISHU_WEBHOOK_SECRET", "")
PAINEL_URL = os.getenv("PAINEL_URL", "http://localhost:3001")
