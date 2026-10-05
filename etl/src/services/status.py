"""
Decide se um pacote "chegou" comparando dois conjuntos de bill_codes do
MESMO shipment_no -- o que foi CARREGADO (DataSource.fetch_loaded_parcels)
x o que ja foi DESCARREGADO (DataSource.fetch_unloaded_parcels).

Essa comparacao foi validada numericamente contra uma conferencia manual
(cruzamento carregamento x descarregamento em planilha): bateu exato com o
numero agregado "carregado e nao descarregado" que a propria fonte calcula.

A confirmacao de anomalia (DataSource.fetch_audit_status) so' serve para
AUDITORIA (responsavel.py): e' o que um operador ja' registrou manualmente,
informacao diferente de "chegou ou nao", que decidimos sozinhos aqui.
"""

from datetime import timedelta



def definir_status(pacote_esperado: dict, chegou_em, status_atual: dict | None = None) -> dict:
    """
    `pacote_esperado`: um item de fetch_loaded_parcels() -- tem
    bill_code, origin_code (origem esperada), next_station_code (destino
    esperado), scanned_at (quando foi carregado por essa viagem).
    `chegou_em`: datetime de quando esse bill_code apareceu no
    descarregamento do MESMO shipment_no, ou None se ainda nao apareceu.
    `status_atual`: opcional, o dict de fetch_audit_status() pra esse
    bill_code -- usado so pra trazer a confirmacao nativa (is_abnormal/
    motivo_confirmado_lms/registrado_em_lms), nao pra decidir o status.
    """
    bill_code = pacote_esperado.get("bill_code")
    network_code_esperado = pacote_esperado.get("origin_code")
    next_station_codigo = pacote_esperado.get("next_station_code")

    if chegou_em:
        status = "Recebido"
        candidato_desde = None
    else:
        status = "Candidato a Expedido não chegou"
        # desde quando esse pacote esta "preso" -- o proprio momento em que
        # foi carregado por essa viagem, e' a partir dali que a janela de
        # 6h (prazo_limite da perna) conta. scanned_at ja' vem como datetime do
        # scan/page, precisa parsear.
        candidato_desde = pacote_esperado.get("scanned_at")

    resultado = {
        "bill_code": bill_code,
        "network_code_esperado": network_code_esperado,
        "next_station_codigo": next_station_codigo,
        "status": status,
        "candidato_desde": candidato_desde,
        "carregado_em": pacote_esperado.get("scanned_at"),
        "latest_scan_type_name": "Bipe de descarregamento" if chegou_em else None,
        "latest_scan_network_codigo": next_station_codigo if chegou_em else None,
        "latest_scan_time": chegou_em,
        "is_refund": False,
        "is_abnormal": None,
        "motivo_confirmado_lms": None,
        "registrado_em_lms": None,
        "base_registro_lms_codigo": None,
    }
    if status_atual:
        resultado.update({
            "is_abnormal": status_atual.get("is_abnormal"),
            "motivo_confirmado_lms": status_atual.get("reason"),
            "registrado_em_lms": status_atual.get("registered_at"),
            "base_registro_lms_codigo": status_atual.get("registered_site_code"),
        })
    return resultado


def definir_pacote_voando(pacote_descarregado: dict, destino_codigo: str) -> dict:
    """Pacote que apareceu no descarregamento de um shipment_no sem ter
    sido carregado por ele -- "pacote voando"/reexpedicao (ja estava na
    base em backlog e foi reexpedido dali pra seguir a carga logistica,
    confirmado com o gerente de transporte). Nao tem origem esperada
    porque nao veio da lista de carregamento dessa viagem."""
    return {
        "bill_code": pacote_descarregado.get("bill_code"),
        "network_code_esperado": None,
        "next_station_codigo": destino_codigo,
        "status": "Pacote Voando",
        "candidato_desde": None,
        "latest_scan_type_name": "Bipe de descarregamento",
        "latest_scan_network_codigo": destino_codigo,
        "latest_scan_time": pacote_descarregado.get("scanned_at"),
        "is_refund": False,
        "is_abnormal": None,
        "motivo_confirmado_lms": None,
        "registrado_em_lms": None,
        "base_registro_lms_codigo": None,
    }


def candidatos_perto_do_prazo(pacotes: list[dict], prazo_limite_por_bill_code: dict, horas_de_folga=1):
    """Filtra os candidatos cuja perna está a menos de `horas_de_folga`
    de estourar o prazo de 6h -- essa lista vira o .xlsx.

    O prazo vem por bill_code (não por shipment_no) porque uma viagem
    Secundaria pode ter varias paradas sob o mesmo shipment_no, cada uma
    com seu proprio prazo -- ver comentario em main.py."""
    from datetime import datetime
    agora = datetime.now()
    candidatos = []

    for pacote in pacotes:
        if pacote["status"] != "Candidato a Expedido não chegou":
            continue

        prazo_limite = prazo_limite_por_bill_code.get(pacote.get("bill_code"))
        if not prazo_limite:
            continue

        tempo_restante = prazo_limite - agora
        if tempo_restante <= timedelta(hours=horas_de_folga):
            candidatos.append({**pacote, "prazo_limite": prazo_limite, "tempo_restante": tempo_restante})

    return candidatos
