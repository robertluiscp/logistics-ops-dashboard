"""
ETL principal do painel de operacao de transporte.

Roda uma vez por chamada (agendar externamente a cada 1 hora -- ver README).
Toda a leitura de dados externos passa por um `DataSource` (src/sources/):
o pipeline abaixo so' conhece estruturas neutras.

Fluxo:
  1. viagens (pernas) Troncais e Secundarias
  2. grava bases e pernas
  3. contagem agregada de carga/descarga (barato, todas as etapas)
  4. pacotes carregados por viagem  (so' viagens Em Descarregamento)
  5. pacotes descarregados por viagem
  6. confirmacao de anomalia registrada por operador (auditoria)
  7. "pacotes voando" (descarregados sem terem sido carregados pela viagem)
  -> grava pacotes, gera candidatos a "Expedido nao chegou" (xlsx) e alerta
"""

import functools
from datetime import datetime

from . import config, db
from .services import status as status_svc
from .services import carga_processado as carga_processado_svc
from .services.responsavel import definir_responsavel
from .services.exportador import gerar_xlsx_candidatos
from .services.alerta_feishu import enviar_alerta_candidatos
from .sources import get_source

print = functools.partial(print, flush=True)


def _extrair_bases_das_pernas(pernas):
    """Monta o upsert de `bases` a partir dos nomes que ja vem junto com as
    viagens -- nao depende de cadastro manual."""
    vistas = {}
    for p in pernas:
        for codigo_key, nome_key in (
            ("base_origem_codigo", "base_origem_nome"),
            ("base_destino_codigo", "base_destino_nome"),
        ):
            codigo = p.get(codigo_key)
            nome = p.get(nome_key)
            if codigo and codigo not in vistas:
                vistas[codigo] = {"codigo": codigo, "nome": nome or codigo, "tipo": None,
                                   "modelo_negocio": None, "provincia": None, "tipo_funcao": None}
    return list(vistas.values())


def _remover_campos_de_apoio(perna):
    p = dict(perna)
    p.pop("base_origem_nome", None)
    p.pop("base_destino_nome", None)
    return p


def _montar_registro_pacote(shipment_no, perna_info, resultado, responsavel=None):
    """Linha final de `pacotes` a partir do dict de definir_status() /
    definir_pacote_voando()."""
    return {
        "bill_code": resultado["bill_code"],
        "perna_id": perna_info["id"],
        "shipment_no": shipment_no,
        "network_code_esperado": resultado.get("network_code_esperado"),
        "next_station_codigo": resultado.get("next_station_codigo"),
        "latest_scan_type_name": resultado.get("latest_scan_type_name"),
        "latest_scan_network_codigo": resultado.get("latest_scan_network_codigo"),
        "latest_scan_time": resultado.get("latest_scan_time"),
        "is_refund": resultado.get("is_refund") or False,
        "status": resultado.get("status"),
        "candidato_desde": resultado.get("candidato_desde"),
        "carregado_em": resultado.get("carregado_em"),
        "is_abnormal": resultado.get("is_abnormal") or False,
        "motivo_confirmado_lms": resultado.get("motivo_confirmado_lms"),
        "registrado_em_lms": resultado.get("registrado_em_lms"),
        "base_registro_lms_codigo": resultado.get("base_registro_lms_codigo"),
        "responsavel": responsavel,
    }


def _gravar_log_execucao(inicio, fim, erro_mensagem, metricas):
    """1 linha em `execucoes_etl` por execucao (sucesso ou falha) -- da'
    visibilidade de saude do ciclo agendado sem precisar abrir o terminal.
    Uma falha AQUI nunca derruba o resultado do ciclo: e' so' observabilidade."""
    duracao_segundos = int((fim - inicio).total_seconds())
    status = "erro" if erro_mensagem else "sucesso"
    try:
        with db.conexao() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO execucoes_etl
                        (iniciado_em, finalizado_em, duracao_segundos, status, erro_mensagem,
                         pernas_total, pacotes_total, pacotes_voando, candidatos_total,
                         candidatos_perto_prazo, xlsx_gerado)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        inicio, fim, duracao_segundos, status, erro_mensagem,
                        metricas.get("pernas_total"), metricas.get("pacotes_total"),
                        metricas.get("pacotes_voando"), metricas.get("candidatos_total"),
                        metricas.get("candidatos_perto_prazo"), metricas.get("xlsx_gerado"),
                    ),
                )
    except Exception as exc:
        print(f"  aviso: falha ao gravar log de execução ({exc})")


def executar_etl(fonte=None):
    """Wrapper fino: mede inicio/fim e grava o log em execucoes_etl. A logica
    de verdade fica em _executar_etl_interno(), que preenche `metricas`."""
    inicio = datetime.now()
    metricas = {
        "pernas_total": None, "pacotes_total": None, "pacotes_voando": None,
        "candidatos_total": None, "candidatos_perto_prazo": None, "xlsx_gerado": None,
    }
    erro_mensagem = None
    try:
        _executar_etl_interno(inicio, metricas, fonte or get_source())
    except Exception as exc:
        erro_mensagem = f"{type(exc).__name__}: {exc}"[:2000]
        raise
    finally:
        _gravar_log_execucao(inicio, datetime.now(), erro_mensagem, metricas)


def _executar_etl_interno(inicio, metricas, fonte):
    print("=" * 60)
    print(f"  ETL Painel de Operação de Transporte -- {inicio:%d/%m/%Y %H:%M:%S} (fonte: {fonte.name})")
    print("=" * 60)

    db.aplicar_schema()

    print("\n[1/7] Extraindo viagens Troncais e Secundárias...")
    pernas_troncal, pernas_secundaria = fonte.fetch_legs()
    todas_pernas = pernas_troncal + pernas_secundaria
    metricas["pernas_total"] = len(todas_pernas)
    print(f"  -> {len(pernas_troncal)} pernas troncais, {len(pernas_secundaria)} pernas secundárias.")

    print("\n[2/7] Gravando bases e pernas...")
    bases_novas = _extrair_bases_das_pernas(todas_pernas)
    pernas_para_upsert = [_remover_campos_de_apoio(p) for p in todas_pernas]

    with db.conexao() as conn:
        with conn.cursor() as cur:
            db.upsert_muitos(cur, "bases", bases_novas, "codigo")
            db.upsert_muitos(cur, "pernas", pernas_para_upsert, "(shipment_no, tipo_perna, base_destino_codigo)")
            cur.execute("SELECT id, shipment_no, tipo_perna, base_destino_codigo, prazo_limite, etapa FROM pernas")
            pernas_no_banco = {
                (row[1], row[2], row[3]): {"id": row[0], "prazo_limite": row[4], "etapa": row[5]}
                for row in cur.fetchall()
            }

    print("\n[3/7] Extraindo contagem agregada de carga/descarga (todas as etapas)...")
    # Barato (so' o resumo por viagem, sem paginar pacote a pacote) -- serve
    # para preencher Carga/Processado/%Processada em qualquer etapa, exceto
    # Planejado/Cancelado (nada foi carregado ainda / nao vai carregar). A
    # checagem PRECISA (Candidatos/Pacotes Voando) continua restrita a Em
    # Descarregamento: ampliar para todas as etapas estoura o ciclo de 1h.
    def _elegivel_para_contagem_agregada(perna):
        return perna.get("etapa") not in ("Planejado", "Cancelado")

    sn_agregado_troncal = list(dict.fromkeys(p["shipment_no"] for p in pernas_troncal if _elegivel_para_contagem_agregada(p)))
    sn_agregado_secundaria = list(dict.fromkeys(p["shipment_no"] for p in pernas_secundaria if _elegivel_para_contagem_agregada(p)))
    eventos_agregados_por_shipment = fonte.fetch_scan_summary(sn_agregado_troncal, "troncal")
    eventos_agregados_por_shipment.update(fonte.fetch_scan_summary(sn_agregado_secundaria, "secundaria"))

    shipment_nos_troncal_set = {p["shipment_no"] for p in pernas_troncal}

    # Casamento evento->perna: carregamento vale pro shipment inteiro,
    # descarregamento casa pelo site_code == destino especifico da parada.
    linhas_finais = carga_processado_svc.calcular_linhas_agregadas(
        eventos_agregados_por_shipment, pernas_no_banco, shipment_nos_troncal_set
    )

    with db.conexao() as conn:
        with conn.cursor() as cur:
            if linhas_finais:
                db.upsert_muitos(cur, "pernas", linhas_finais, "(shipment_no, tipo_perna, base_destino_codigo)")
            # Limpeza defensiva: perna Planejado/Cancelado nunca deve exibir
            # carga/processado (zera qualquer resto de execucao anterior).
            cur.execute(
                "UPDATE pernas SET carga_total = NULL, qtd_processada = NULL, "
                "  carregado_nao_descarregado = NULL, descarregado_nao_carregado = NULL "
                "WHERE etapa IN ('Planejado', 'Cancelado') "
                "AND (carga_total IS NOT NULL OR qtd_processada IS NOT NULL "
                "     OR carregado_nao_descarregado IS NOT NULL OR descarregado_nao_carregado IS NOT NULL)"
            )
    print(f"  -> {len(linhas_finais)} pernas com contagem agregada gravada.")

    print("\n[4/7] Extraindo pacotes carregados por viagem...")
    # Uma perna so' entra na checagem de pacotes se ja' deslacrou (o deslacre
    # inicia o relogio de 6h) mas ainda nao teve chegada confirmada -- e' o
    # momento em que "Expedido nao chegou" pode de fato surgir.
    def _na_janela_de_atencao(perna):
        return perna.get("etapa") == "Em Descarregamento"

    # dict.fromkeys desduplica mantendo a ordem: uma viagem Secundaria com
    # varias paradas repete o shipment_no em pernas_secundaria.
    shipment_nos_troncal = list(dict.fromkeys(p["shipment_no"] for p in pernas_troncal if _na_janela_de_atencao(p)))
    shipment_nos_secundaria = list(dict.fromkeys(p["shipment_no"] for p in pernas_secundaria if _na_janela_de_atencao(p)))
    pacotes_esperados_por_shipment = fonte.fetch_loaded_parcels(shipment_nos_troncal, "troncal")
    pacotes_esperados_por_shipment.update(fonte.fetch_loaded_parcels(shipment_nos_secundaria, "secundaria"))

    todos_bill_codes = [
        pac["bill_code"]
        for lista in pacotes_esperados_por_shipment.values()
        for pac in lista
        if pac.get("bill_code")
    ]
    print(f"  -> {len(todos_bill_codes)} pacotes carregados no total.")

    # Comparar carregamento x descarregamento do MESMO shipment_no decide
    # "chegou ou nao" sozinho (validado contra o agregado que a propria
    # fonte calcula).
    print("\n[5/7] Extraindo pacotes descarregados por viagem...")
    pacotes_descarregados_por_shipment = fonte.fetch_unloaded_parcels(shipment_nos_troncal, "troncal")
    pacotes_descarregados_por_shipment.update(fonte.fetch_unloaded_parcels(shipment_nos_secundaria, "secundaria"))
    descarregados_por_shipment = {
        shipment_no: {p["bill_code"]: p for p in lista if p.get("bill_code")}
        for shipment_no, lista in pacotes_descarregados_por_shipment.items()
    }
    total_descarregados = sum(len(d) for d in descarregados_por_shipment.values())
    print(f"  -> {total_descarregados} pacotes descarregados no total.")

    # Auditoria: o que um operador ja' registrou manualmente (consumido por
    # responsavel.py) -- "chegou ou nao" vem da comparacao acima.
    print("\n[6/7] Consultando confirmação de anomalia registrada (auditoria)...")
    status_atual = fonte.fetch_audit_status(todos_bill_codes)

    pacotes_por_bill_code = {}
    prazo_limite_por_bill_code = {}
    pernas_por_shipment_troncal = {p["shipment_no"]: p for p in pernas_troncal}

    for shipment_no, lista_pacotes in pacotes_esperados_por_shipment.items():
        tipo_perna = "troncal" if shipment_no in pernas_por_shipment_troncal else "secundaria"
        descarregados_do_shipment = descarregados_por_shipment.get(shipment_no, {})

        for pac in lista_pacotes:
            bill_code = pac.get("bill_code")
            if not bill_code:
                continue

            # O destino do PROPRIO pacote (proxima parada) decide qual perna
            # usar -- necessario para Secundaria com varias paradas sob o
            # mesmo shipment_no. Usar o destino FINAL de entrega em vez da
            # proxima parada descartaria quase todos os pacotes (bug real que
            # ja' aconteceu -- ver docs/ENGINEERING_NOTES.md).
            destino_codigo = pac.get("next_station_code")
            perna_info = pernas_no_banco.get((shipment_no, tipo_perna, destino_codigo))
            if not perna_info:
                continue

            descarga = descarregados_do_shipment.get(bill_code)
            chegou_em = descarga.get("scanned_at") if descarga else None

            resultado = status_svc.definir_status(pac, chegou_em, status_atual.get(bill_code))
            responsavel = definir_responsavel(resultado.get("registrado_em_lms"), perna_info["prazo_limite"])
            prazo_limite_por_bill_code[bill_code] = perna_info["prazo_limite"]

            # dict por bill_code (nao list.append): o mesmo pacote pode
            # aparecer mais de uma vez na listagem bruta e o upsert em lote
            # nao aceita chave duplicada no mesmo comando.
            pacotes_por_bill_code[bill_code] = _montar_registro_pacote(shipment_no, perna_info, resultado, responsavel)

    # "Pacotes voando"/reexpedicao: bill_code que aparece no descarregamento
    # de um shipment_no sem ter sido carregado por ele (estava em backlog na
    # base e foi reexpedido dali -- comportamento normal, nao e' erro).
    print("\n[7/7] Identificando pacotes voando (reexpedição)...")
    total_voando = 0
    for shipment_no, descarregados_do_shipment in descarregados_por_shipment.items():
        tipo_perna = "troncal" if shipment_no in pernas_por_shipment_troncal else "secundaria"
        carregados_bill_codes = {
            pac["bill_code"] for pac in pacotes_esperados_por_shipment.get(shipment_no, []) if pac.get("bill_code")
        }

        for bill_code, descarga in descarregados_do_shipment.items():
            if bill_code in carregados_bill_codes or bill_code in pacotes_por_bill_code:
                continue

            destino_codigo = descarga.get("site_code")
            perna_info = pernas_no_banco.get((shipment_no, tipo_perna, destino_codigo))
            if not perna_info:
                continue

            resultado = status_svc.definir_pacote_voando(descarga, destino_codigo)
            pacotes_por_bill_code[bill_code] = _montar_registro_pacote(shipment_no, perna_info, resultado)
            total_voando += 1
    print(f"  -> {total_voando} pacotes voando identificados.")
    metricas["pacotes_voando"] = total_voando

    pacotes_para_upsert = list(pacotes_por_bill_code.values())
    metricas["pacotes_total"] = len(pacotes_para_upsert)
    metricas["candidatos_total"] = sum(
        1 for p in pacotes_para_upsert if p["status"] == "Candidato a Expedido não chegou"
    )

    print("\nGravando pacotes e gerando candidatos a Expedido não chegou...")
    with db.conexao() as conn:
        with conn.cursor() as cur:
            db.upsert_muitos(cur, "pacotes", pacotes_para_upsert, "bill_code")

    candidatos = status_svc.candidatos_perto_do_prazo(pacotes_para_upsert, prazo_limite_por_bill_code)
    metricas["candidatos_perto_prazo"] = len(candidatos)
    caminho_xlsx = gerar_xlsx_candidatos(candidatos, config.PASTA_EXPORTS)
    metricas["xlsx_gerado"] = str(caminho_xlsx) if caminho_xlsx else None

    # Alerta proativo: repete a cada ciclo enquanto houver candidato na janela
    # urgente (melhor repetitivo do que passar despercebido). Nunca deixa uma
    # falha aqui derrubar o resultado do ciclo.
    try:
        enviar_alerta_candidatos(candidatos)
    except Exception as exc:
        print(f"  aviso: falha inesperada no alerta ({exc})")

    duracao = datetime.now() - inicio
    print("\n" + "=" * 60)
    print(f"  Pernas: {len(todas_pernas)} | Pacotes: {len(pacotes_para_upsert)} | "
          f"Pacotes voando: {total_voando} | Candidatos perto do prazo: {len(candidatos)}")
    if caminho_xlsx:
        print(f"  Arquivo gerado: {caminho_xlsx}")
    print(f"  Duração: {str(duracao).split('.')[0]}")
    print("=" * 60)


if __name__ == "__main__":
    executar_etl()
