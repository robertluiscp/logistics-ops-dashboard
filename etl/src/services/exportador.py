"""Gera o .xlsx com os pacotes candidatos a "Expedido não chegou" perto do
prazo -- a planilha que o operador usa para registrar a anomalia no sistema
de origem antes de a responsabilidade mudar de base."""

import pandas as pd
from datetime import datetime
from pathlib import Path

COLUNAS_SAIDA = {
    "bill_code": "Número de pedido LMS",
    "shipment_no": "ID da viagem",
    "network_code_esperado": "Base de origem",
    "next_station_codigo": "Base destino",
    "candidato_desde": "Expedido desde",
    "prazo_limite": "Prazo limite (deslacre + 6h)",
    "tempo_restante": "Tempo restante",
}


def gerar_xlsx_candidatos(candidatos, pasta_saida):
    pasta_saida = Path(pasta_saida)
    pasta_saida.mkdir(parents=True, exist_ok=True)

    if not candidatos:
        return None

    df = pd.DataFrame(candidatos)
    colunas_presentes = [c for c in COLUNAS_SAIDA if c in df.columns]
    df = df[colunas_presentes].rename(columns=COLUNAS_SAIDA)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    caminho = pasta_saida / f"expedido_nao_chegou_{timestamp}.xlsx"
    df.to_excel(caminho, index=False)
    return caminho
