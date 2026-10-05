"""
Extrai os 3 indicadores de taxa de expedicao no prazo do LMS e grava em
`taxas_expedicao`. Agendado a cada 3h (self-heal dos ultimos 3 dias
operacionais) -- nao 1x/dia como antes: uma falha transitoria num relatorio
especifico (visto na pratica em 2026-09-11, sc_hub/sc_sc ficaram travados um
dia inteiro sem ninguem perceber) agora se corrige sozinha em poucas horas
em vez de esperar o dia seguinte.

Cada execucao grava um resumo em `execucoes_taxas` (status sucesso/parcial/
erro + falhas) -- e' o que da' visibilidade de falha parcial no painel,
coisa que so' um `print` perdido numa scheduled task sem saida capturada
nao dava.

Uso:
  python run_taxas.py                      -> ultimos 3 dias operacionais (self-heal)
  python run_taxas.py 2026-08-01           -> so' esse dia
  python run_taxas.py 2026-08-01 2026-09-09  -> backfill do intervalo (inclusive)
"""
import functools
import sys
from datetime import date, datetime, timedelta

from src import db
from src.sources import get_source

print = functools.partial(print, flush=True)


def _parse_data(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _dias_alvo(argv) -> list[date]:
    if len(argv) >= 3:
        ini, fim = _parse_data(argv[1]), _parse_data(argv[2])
        return [ini + timedelta(days=i) for i in range((fim - ini).days + 1)]
    if len(argv) == 2:
        return [_parse_data(argv[1])]
    hoje = date.today()
    return [hoje - timedelta(days=n) for n in (1, 2, 3)]


def _registrar_execucao(iniciado_em, status, dias_alvo, linhas_gravadas, falhas, erro_mensagem):
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO execucoes_taxas
                    (iniciado_em, finalizado_em, status, dias_alvo, linhas_gravadas,
                     falhas, duracao_segundos, erro_mensagem)
                VALUES (%s, now(), %s, %s, %s, %s,
                        EXTRACT(EPOCH FROM (now() - %s))::int, %s)
                """,
                (iniciado_em, status, dias_alvo, linhas_gravadas,
                 "\n".join(falhas) if falhas else None, iniciado_em, erro_mensagem),
            )


def main():
    iniciado_em = datetime.now()
    dias = _dias_alvo(sys.argv)
    print(f"Extraindo taxa de expedicao para {len(dias)} dia(s): {dias[0]} .. {dias[-1]}")

    todas_falhas = []
    total_linhas = 0
    erro_fatal = None

    try:
        fonte = get_source()

        for dia in dias:
            try:
                linhas, falhas_dia = fonte.fetch_timely_rates(dia)
            except Exception as exc:
                msg = f"{dia}: {type(exc).__name__}: {exc}"
                print(f"  {msg} -- seguindo pros outros dias")
                todas_falhas.append(msg)
                continue

            todas_falhas.extend(falhas_dia)
            if not linhas:
                print(f"  {dia}: sem dados (dia ainda nao fechou / sem movimento)")
                continue

            with db.conexao() as conn:
                with conn.cursor() as cur:
                    db.upsert_muitos(cur, "taxas_expedicao", linhas, "(data, tipo, sc_codigo, dc_codigo)")
            por_tipo = {}
            for l in linhas:
                por_tipo[l["tipo"]] = por_tipo.get(l["tipo"], 0) + 1
            print(f"  {dia}: {len(linhas)} linhas gravadas ({por_tipo})")
            total_linhas += len(linhas)
    except Exception as exc:
        erro_fatal = f"{type(exc).__name__}: {exc}"
        print(f"FALHA GERAL: {erro_fatal}")

    if erro_fatal:
        status = "erro"
    elif todas_falhas:
        status = "parcial"
    else:
        status = "sucesso"

    _registrar_execucao(iniciado_em, status, len(dias), total_linhas, todas_falhas, erro_fatal)

    print(f"Concluido -- {total_linhas} linhas no total. Status: {status}"
          + (f" ({len(todas_falhas)} falha(s))" if todas_falhas else ""))
    sys.exit(1 if status != "sucesso" else 0)


if __name__ == "__main__":
    main()
