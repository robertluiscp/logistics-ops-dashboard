"""
Calculo de Carga/Processado agregado por perna (parada).

Roda tanto no ciclo principal (1h) quanto num job frequente separado
(~20min, run_carga_processado.py) que so' atualiza esses 4 campos -- viagens
de varias paradas continuam recebendo bipe de descarregamento horas depois
da primeira parada, e o ciclo de 1h sozinho nao acompanha isso a tempo.

Entrada: eventos AGREGADOS por viagem (DataSource.fetch_scan_summary) --
1 chamada por shipment_no, sem paginar pacote a pacote (barato). Cada evento
neutro tem `direction` ('load' | 'unload'), `site_code`/`site_name` (onde
aconteceu), `count` (quantidade), e `only_loaded`/`only_unloaded` (o que a
propria fonte ja' calcula como "carregado e nao descarregado" /
"descarregado e nao carregado").
"""



def calcular_linhas_agregadas(eventos_agregados_por_shipment, pernas_no_banco, shipment_nos_troncal_set):
    """`pernas_no_banco`: dict (shipment_no, tipo_perna, base_destino_codigo)
    -> {"etapa": ...} (ou qualquer dict que tenha a chave "etapa") -- so'
    usado aqui pra saber quais destinos sao ELEGIVEIS (etapa != Planejado/
    Cancelado) pra cada shipment.     Devolve a lista de linhas prontas pra upsert em `pernas`."""

    # Indice (shipment_no, tipo_perna) -> destinos ELEGIVEIS -- ver
    # comentario equivalente que existia em main.py: um mesmo shipment_no
    # pode ter mais de uma linha de perna com etapa diferente (residuo de
    # reatribuicao no LMS), e loading/scan/list responde so' por
    # shipmentNo (sem filtro de data/etapa) -- so' escrever nos destinos
    # que a PROPRIA chamada considera elegiveis evita contaminar uma linha
    # stale (Planejado/Cancelado).
    destinos_por_shipment = {}
    for (sn, tp, destino), info in pernas_no_banco.items():
        if info.get("etapa") in ("Planejado", "Cancelado"):
            continue
        destinos_por_shipment.setdefault((sn, tp), []).append(destino)

    linhas_brutas = []
    for shipment_no, eventos in eventos_agregados_por_shipment.items():
        tipo_perna = "troncal" if shipment_no in shipment_nos_troncal_set else "secundaria"
        destinos_elegiveis = destinos_por_shipment.get((shipment_no, tipo_perna), [])
        for evento in eventos:
            rede_codigo = evento.get("site_code")
            carga_evento = evento.get("count") or 0

            if evento.get("direction") == "load":
                # carregamento -- vale pro caminhao inteiro (todas as
                # paradas elegiveis desse shipment), igual a only_loaded
                # ("Carregado mas nao descarregado" repete o mesmo valor
                # em toda parada na propria tela do LMS).
                for destino in destinos_elegiveis:
                    linhas_brutas.append({
                        "shipment_no": shipment_no, "tipo_perna": tipo_perna, "base_destino_codigo": destino,
                        "carga_total": carga_evento,
                        "carregado_nao_descarregado": evento.get("only_loaded"),
                    })
            elif rede_codigo in destinos_elegiveis:
                # descarregamento -- rede_codigo e' o proprio DESTINO, casa
                # direto com uma perna especifica (essencial pra Secundaria
                # com varias paradas, cada uma com seu proprio evento tipo 2).
                linhas_brutas.append({
                    "shipment_no": shipment_no, "tipo_perna": tipo_perna, "base_destino_codigo": rede_codigo,
                    "qtd_processada": carga_evento,
                    "descarregado_nao_carregado": evento.get("only_unloaded"),
                })

    # Junta os 4 campos da mesma perna (podem vir em eventos/iteracoes
    # separadas acima) numa unica linha por upsert, e aplica a regra do
    # "pacote voando" (descarregado > carregado nao deve estourar 100% na
    # exibicao -- ver docs/ENGINEERING_NOTES.md).
    agregado_por_chave = {}
    for linha in linhas_brutas:
        chave = (linha["shipment_no"], linha["tipo_perna"], linha["base_destino_codigo"])
        acumulado = agregado_por_chave.setdefault(chave, {
            "carga_total": None, "qtd_processada": None,
            "carregado_nao_descarregado": None, "descarregado_nao_carregado": None,
        })
        if "carga_total" in linha:
            acumulado["carga_total"] = (acumulado["carga_total"] or 0) + linha["carga_total"]
            if linha.get("carregado_nao_descarregado") is not None:
                acumulado["carregado_nao_descarregado"] = (
                    (acumulado["carregado_nao_descarregado"] or 0) + linha["carregado_nao_descarregado"]
                )
        if "qtd_processada" in linha:
            acumulado["qtd_processada"] = (acumulado["qtd_processada"] or 0) + linha["qtd_processada"]
            if linha.get("descarregado_nao_carregado") is not None:
                acumulado["descarregado_nao_carregado"] = (
                    (acumulado["descarregado_nao_carregado"] or 0) + linha["descarregado_nao_carregado"]
                )

    linhas_finais = []
    for (shipment_no, tipo_perna, destino), valores in agregado_por_chave.items():
        if destino is None:
            continue
        carga = valores["carga_total"]
        # NAO limitar processado <= carga aqui (removido 2026-09-18) --
        # gravava o numero errado no banco so' pra barra de % nao estourar
        # 100%, mas isso escondia a escala real de "pacote voando" ate' o
        # usuario clicar no ID e ver a lista ao vivo (sem limite nenhum).
        # O limite de 100% agora e' so' visual, na barra (barraProgresso em
        # app.js) -- o numero de "Processado" na tabela fica sempre verdadeiro.
        processado = valores["qtd_processada"]
        linhas_finais.append({
            "shipment_no": shipment_no, "tipo_perna": tipo_perna, "base_destino_codigo": destino,
            "carga_total": carga, "qtd_processada": processado,
            "carregado_nao_descarregado": valores["carregado_nao_descarregado"],
            "descarregado_nao_carregado": valores["descarregado_nao_carregado"],
        })
    return linhas_finais
