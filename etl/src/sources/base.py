"""Contrato da fonte de dados.

O ETL nunca fala com um sistema externo diretamente: ele pede dados a um
`DataSource` e recebe estruturas NEUTRAS (dicts com nomes de campo do nosso
dominio). Trocar de fonte (demo sintetica, adaptador real, arquivos) nao
exige tocar em nenhuma regra de negocio.

Formatos (todos os datetimes sao `datetime` naive no horario local):

  perna (fetch_legs)        -> mesmas colunas da tabela `pernas`, mais
                               base_origem_nome / base_destino_nome
  evento de bipagem         -> {direction: "load"|"unload", site_code,
                               site_name, count, only_loaded, only_unloaded}
  pacote carregado          -> {bill_code, origin_code, next_station_code,
                               scanned_at}
  pacote descarregado       -> {bill_code, site_code, site_name, scanned_at}
  status de auditoria       -> {is_abnormal, reason, registered_at,
                               registered_site_code}
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Callable, Protocol

LegType = str  # "troncal" | "secundaria"


class DataSource(Protocol):
    name: str

    # ------------------------------------------------------------ transporte
    def fetch_legs(self) -> tuple[list[dict], list[dict]]:
        """(pernas troncais, pernas secundarias) da janela operacional."""

    def fetch_scan_summary(self, shipment_nos: list[str], leg_type: LegType) -> dict[str, list[dict]]:
        """Eventos agregados de carga/descarga por viagem (barato: sem
        paginar pacote a pacote)."""

    def fetch_loaded_parcels(self, shipment_nos: list[str], leg_type: LegType) -> dict[str, list[dict]]:
        """Pacotes carregados (esperados) por viagem."""

    def fetch_unloaded_parcels(self, shipment_nos: list[str], leg_type: LegType) -> dict[str, list[dict]]:
        """Pacotes descarregados (chegaram) por viagem."""

    def fetch_audit_status(self, bill_codes: list[str]) -> dict[str, dict]:
        """Confirmacao nativa de anomalia registrada por um operador."""

    # ------------------------------------------------------------ indicadores
    def fetch_timely_rates(self, day: date) -> tuple[list[dict], list[str]]:
        """(linhas de taxas_expedicao do dia operacional, falhas em texto)."""

    def fetch_open_tickets(self, kind: str) -> list[dict]:
        """Snapshot dos tickets ainda em aberto ('comum' | 'plataforma')."""

    # ----------------------------------------------------------------- dropoff
    def fetch_pudo(self, start: datetime, end: datetime) -> list[dict]:
        """Linhas de pudo_coletas com enter_time em [start, end]."""

    def fetch_c2c(self, start: datetime, end: datetime) -> tuple[list[dict], bool]:
        """(linhas de c2c_pedidos, incompleto?)."""

    def count_pudo_month(self, year: int, month: int,
                         progress: Callable[[int, int], None] | None = None) -> dict:
        """Total do mes sem gravar linha a linha."""
