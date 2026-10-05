"""
Atualiza SO' Carga/Processado/Carregado-nao-descarregado/Descarregado-nao-
-carregado das pernas ja' gravadas (Troncal+Secundaria) -- nao mexe em
lacre/deslacre/etapa, isso continua so' no ciclo principal (run.py, 1h).

Existe porque viagens de varias paradas continuam recebendo bipe de
carregamento/descarregamento por HORAS depois da primeira parada: o ciclo de
1h capturava so' um instantaneo parcial das paradas tardias. Roda a cada
~20min (agendado a parte) para reduzir essa defasagem sem rodar o ciclo pesado
inteiro com mais frequencia -- so' o passo barato (resumo por viagem, sem
paginar pacote a pacote) e' reaproveitado aqui. Ver services/carga_processado.py.

Escopo: pernas com partida_real nos ultimos JANELA_DIAS dias e etapa fora
de Planejado/Cancelado (nada foi carregado ainda / nao vai carregar).

Cada execucao grava um resumo em `execucoes_carga_processado`.
"""
import functools
import sys
from datetime import datetime

from src import db
from src.services import carga_processado as carga_processado_svc
from src.sources import get_source

print = functools.partial(print, flush=True)

JANELA_DIAS = 2


def _registrar_execucao(iniciado_em, status, pernas_verificadas, linhas_gravadas, erro_mensagem):
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO execucoes_carga_processado
                    (iniciado_em, finalizado_em, status, pernas_verificadas, linhas_gravadas,
                     duracao_segundos, erro_mensagem)
                VALUES (%s, now(), %s, %s, %s, EXTRACT(EPOCH FROM (now() - %s))::int, %s)
                """,
                (iniciado_em, status, pernas_verificadas, linhas_gravadas, iniciado_em, erro_mensagem),
            )


def main():
    iniciado_em = datetime.now()
    erro_fatal = None
    pernas_verificadas = 0
    linhas_gravadas = 0

    try:
        fonte = get_source()

        with db.conexao() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, shipment_no, tipo_perna, base_destino_codigo, etapa
                    FROM pernas
                    WHERE etapa NOT IN ('Planejado', 'Cancelado')
                      AND partida_real >= now() - (%s || ' days')::interval
                    """,
                    (JANELA_DIAS,),
                )
                linhas = cur.fetchall()

        pernas_no_banco = {}
        shipment_nos_troncal_set = set()
        shipment_nos_secundaria_set = set()
        for perna_id, shipment_no, tipo_perna, base_destino_codigo, etapa in linhas:
            pernas_no_banco[(shipment_no, tipo_perna, base_destino_codigo)] = {"etapa": etapa}
            if tipo_perna == "troncal":
                shipment_nos_troncal_set.add(shipment_no)
            else:
                shipment_nos_secundaria_set.add(shipment_no)

        pernas_verificadas = len(linhas)
        print(f"  {len(shipment_nos_troncal_set)} shipments troncal, "
              f"{len(shipment_nos_secundaria_set)} shipments secundaria "
              f"(partida_real nos ultimos {JANELA_DIAS} dias).")

        eventos_agregados_por_shipment = fonte.fetch_scan_summary(list(shipment_nos_troncal_set), "troncal")
        eventos_agregados_por_shipment.update(
            fonte.fetch_scan_summary(list(shipment_nos_secundaria_set), "secundaria")
        )

        linhas_finais = carga_processado_svc.calcular_linhas_agregadas(
            eventos_agregados_por_shipment, pernas_no_banco, shipment_nos_troncal_set
        )

        with db.conexao() as conn:
            with conn.cursor() as cur:
                if linhas_finais:
                    db.upsert_muitos(cur, "pernas", linhas_finais, "(shipment_no, tipo_perna, base_destino_codigo)")
        linhas_gravadas = len(linhas_finais)
        print(f"  -> {linhas_gravadas} pernas com contagem agregada atualizada.")
    except Exception as exc:
        erro_fatal = f"{type(exc).__name__}: {exc}"[:2000]
        print(f"FALHA GERAL: {erro_fatal}")

    status = "erro" if erro_fatal else "sucesso"
    _registrar_execucao(iniciado_em, status, pernas_verificadas, linhas_gravadas, erro_fatal)

    duracao = datetime.now() - iniciado_em
    print(f"Concluido -- {linhas_gravadas} linhas gravadas. Status: {status}. Duracao: {str(duracao).split('.')[0]}")
    sys.exit(1 if status != "sucesso" else 0)


if __name__ == "__main__":
    main()
