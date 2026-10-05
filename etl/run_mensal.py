"""
Agregados MENSAIS de Pudo e C2C -- referencia de "outros meses" nos dois
relatorios. Escopo: MES ATUAL e MES PASSADO.

  Pudo: o total do mes vem da fonte de dados (paginacao completa numa fonte
        real -- lenta de proposito, sem concorrencia extra). Mes fechado e'
        calculado 1x; o mes em andamento e' recalculado a cada execucao.
  C2C:  conta direto do que ja' esta' gravado em `c2c_pedidos` (instantaneo).

Uso:
  python run_mensal.py              -> os 2 relatorios, mes atual + mes passado
  python run_mensal.py pudo         -> so' pudo
  python run_mensal.py c2c          -> so' c2c
"""
import functools
import sys
from datetime import date, datetime

from src import db
from src.sources import get_source

print = functools.partial(print, flush=True)


def _mes_atual_e_anterior():
    hoje = date.today()
    atual = date(hoje.year, hoje.month, 1)
    ano_ant, mes_ant = (hoje.year - 1, 12) if hoje.month == 1 else (hoje.year, hoje.month - 1)
    anterior = date(ano_ant, mes_ant, 1)
    return anterior, atual


def _ja_processado(tabela: str, mes_data) -> bool:
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT 1 FROM {tabela} WHERE mes = %s", (mes_data,))
            return cur.fetchone() is not None


def _registrar_execucao(relatorio, mes_data, iniciado_em, status, total_contado, unidades, erro_mensagem):
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO execucoes_mensal
                    (relatorio, mes, iniciado_em, finalizado_em, status, total_contado,
                     paginas_percorridas, erro_mensagem, duracao_segundos)
                VALUES (%s, %s, %s, now(), %s, %s, %s, %s, EXTRACT(EPOCH FROM (now() - %s))::int)
                """,
                (relatorio, mes_data, iniciado_em, status, total_contado, unidades, erro_mensagem, iniciado_em),
            )


def _processar_pudo_mes(fonte, mes_data, forcar: bool):
    if not forcar and _ja_processado("pudo_mensal", mes_data):
        print(f"  pudo {mes_data:%Y-%m}: ja' processado (mes fechado), pulando.")
        return
    print(f"  pudo: processando {mes_data:%Y-%m} (isso demora, pode levar ~25-30min por mes)...")
    iniciado_em = datetime.now()

    def _progresso(atual, total):
        if atual % 100 == 0 or atual == total:
            print(f"    ...pagina {atual}/{total}")

    try:
        resultado = fonte.count_pudo_month(mes_data.year, mes_data.month, progress=_progresso)
        with db.conexao() as conn:
            with conn.cursor() as cur:
                db.upsert_muitos(
                    cur, "pudo_mensal",
                    [{
                        "mes": mes_data,
                        "total_pacotes": resultado["total_pacotes"],
                        "total_dropoffs": resultado["total_dropoffs"],
                        "bases_ativas": resultado["bases_ativas"],
                    }],
                    "(mes)",
                )
        erro = f"{resultado['paginas_falhas']} pagina(s) falharam de {resultado['total_paginas']}" if resultado["paginas_falhas"] else None
        _registrar_execucao("pudo", mes_data, iniciado_em, "sucesso", resultado["total_pacotes"], resultado["paginas_percorridas"], erro)
        print(f"  pudo {mes_data:%Y-%m}: {resultado['total_pacotes']} pacotes, "
              f"{resultado['total_dropoffs']} dropoffs, {resultado['bases_ativas']} bases "
              f"({resultado['paginas_falhas']} pagina(s) falha(s))")
    except Exception as exc:
        erro_mensagem = f"{type(exc).__name__}: {exc}"[:2000]
        _registrar_execucao("pudo", mes_data, iniciado_em, "erro", None, None, erro_mensagem)
        print(f"  pudo {mes_data:%Y-%m}: FALHOU -- {erro_mensagem}")


def _contar_c2c_mes_do_banco(mes_dt) -> int:
    """Conta os pedidos C2C do mes a partir do que ja' esta' gravado em
    `c2c_pedidos` (o self-heal mantem os dias recentes corretos). Mes fechado
    antes do sistema existir retorna 0 -- honesto, nao inventa numero."""
    from calendar import monthrange
    _, ultimo_dia = monthrange(mes_dt.year, mes_dt.month)
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM c2c_pedidos WHERE input_time::date BETWEEN %s AND %s",
                (date(mes_dt.year, mes_dt.month, 1), date(mes_dt.year, mes_dt.month, ultimo_dia)),
            )
            return cur.fetchone()[0]


def _processar_c2c_mes(mes_data):
    iniciado_em = datetime.now()
    try:
        total = _contar_c2c_mes_do_banco(mes_data)
        with db.conexao() as conn:
            with conn.cursor() as cur:
                db.upsert_muitos(cur, "c2c_mensal", [{"mes": mes_data, "total_pedidos": total}], "(mes)")
        _registrar_execucao("c2c", mes_data, iniciado_em, "sucesso", total, None, None)
        print(f"  c2c {mes_data:%Y-%m}: {total} pedidos (contado do banco, sem chamar a API)")
    except Exception as exc:
        erro_mensagem = f"{type(exc).__name__}: {exc}"[:2000]
        _registrar_execucao("c2c", mes_data, iniciado_em, "erro", None, None, erro_mensagem)
        print(f"  c2c {mes_data:%Y-%m}: FALHOU -- {erro_mensagem}")


def main():
    alvo_relatorio = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("pudo", "c2c") else None
    anterior, atual = _mes_atual_e_anterior()
    print(f"Agregados mensais -- {datetime.now():%d/%m/%Y %H:%M:%S} -- meses alvo: {anterior:%Y-%m} e {atual:%Y-%m}")

    if alvo_relatorio in (None, "c2c"):
        # instantaneo (le do banco), sempre reprocessa os 2 meses.
        _processar_c2c_mes(anterior)
        _processar_c2c_mes(atual)

    if alvo_relatorio in (None, "pudo"):
        fonte = get_source()
        _processar_pudo_mes(fonte, anterior, forcar=False)  # mes fechado, so' 1x
        _processar_pudo_mes(fonte, atual, forcar=True)      # mes em andamento, sempre atualiza

    print("Concluido.")


if __name__ == "__main__":
    main()
