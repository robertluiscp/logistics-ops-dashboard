"""
Extrai o relatorio Pudo (tudo bipado nos pontos de coleta parceiros) pra
`pudo_coletas`. Volume altissimo (~15-30 mil/dia) -- por isso o modo padrao
(sem args) so' busca uma janela CURTA e RECENTE (self-heal incremental,
pra rodar com frequencia sem pesar no LMS); o backfill da janela completa
(15 dias) e' caro e roda so' quando pedido explicitamente.

Uso:
  python run_pudo.py                 -> incremental: ultimas PUDO_INCREMENTAL_HORAS horas (rodar a cada ~1h)
  python run_pudo.py --backfill       -> janela completa de PUDO_JANELA_DIAS dias (caro, rodar manual 1x)
  python run_pudo.py 2026-08-01 2026-08-05  -> intervalo especifico (gap-fill manual)

Sempre poda no final: apaga da tabela o que ja' saiu da janela de retencao
(PUDO_JANELA_DIAS) -- nao da' pra manter historico completo dado o volume.
"""
import functools
import sys
from datetime import date, datetime, timedelta

from src import config, db
from src.sources import get_source

print = functools.partial(print, flush=True)

PUDO_INCREMENTAL_HORAS = int(__import__("os").getenv("PUDO_INCREMENTAL_HORAS", "6"))


def _parse_data(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _gravar(linhas: list[dict]):
    linhas = [l for l in linhas if l["enter_time"] is not None]
    if not linhas:
        return 0
    with db.conexao() as conn:
        with conn.cursor() as cur:
            db.upsert_muitos(cur, "pudo_coletas", linhas, "(order_no)")
    return len(linhas)


def _podar():
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM pudo_coletas WHERE enter_time < now() - (%s || ' days')::interval",
                (config.PUDO_JANELA_DIAS,),
            )
            apagadas = cur.rowcount
    if apagadas:
        print(f"  poda: {apagadas} linha(s) fora da janela de {config.PUDO_JANELA_DIAS} dias removida(s)")


def main():
    iniciado_em = datetime.now()
    total = 0
    erro_fatal = None

    try:
        fonte = get_source()

        if len(sys.argv) >= 3:
            ini, fim = _parse_data(sys.argv[1]), _parse_data(sys.argv[2])
            dias = [ini + timedelta(days=i) for i in range((fim - ini).days + 1)]
            print(f"Pudo -- backfill por dia: {dias[0]} .. {dias[-1]} ({len(dias)} dia(s))")
            for dia in dias:
                inicio_dt = datetime.combine(dia, datetime.min.time())
                fim_dt = inicio_dt + timedelta(hours=23, minutes=59, seconds=59)
                linhas = fonte.fetch_pudo(inicio_dt, fim_dt)
                gravadas = _gravar(linhas)
                print(f"  {dia}: {len(linhas)} extraidas, {gravadas} gravadas")
                total += gravadas
        elif "--backfill" in sys.argv:
            fim_dt = datetime.now()
            inicio_dt = fim_dt - timedelta(days=config.PUDO_JANELA_DIAS)
            print(f"Pudo -- BACKFILL completo: {inicio_dt} .. {fim_dt} (pode levar bastante tempo)")
            # ainda assim por dia, pra nao estourar 1 pagina de resposta gigante
            dias = [(inicio_dt + timedelta(days=i)).date() for i in range(config.PUDO_JANELA_DIAS + 1)]
            for dia in sorted(set(dias)):
                inicio_dia = max(datetime.combine(dia, datetime.min.time()), inicio_dt)
                fim_dia = min(datetime.combine(dia, datetime.min.time()) + timedelta(hours=23, minutes=59, seconds=59), fim_dt)
                if inicio_dia >= fim_dia:
                    continue
                linhas = fonte.fetch_pudo(inicio_dia, fim_dia)
                gravadas = _gravar(linhas)
                print(f"  {dia}: {len(linhas)} extraidas, {gravadas} gravadas")
                total += gravadas
        else:
            fim_dt = datetime.now()
            inicio_dt = fim_dt - timedelta(hours=PUDO_INCREMENTAL_HORAS)
            print(f"Pudo -- incremental: ultimas {PUDO_INCREMENTAL_HORAS}h ({inicio_dt} .. {fim_dt})")
            linhas = fonte.fetch_pudo(inicio_dt, fim_dt)
            total = _gravar(linhas)
            print(f"  {len(linhas)} extraidas, {total} gravadas")

        _podar()
    except Exception as exc:
        erro_fatal = f"{type(exc).__name__}: {exc}"
        print(f"FALHA GERAL: {erro_fatal}")

    status = "erro" if erro_fatal else "sucesso"
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO execucoes_dropoff (relatorio, iniciado_em, finalizado_em, status,
                                                linhas_gravadas, erro_mensagem, duracao_segundos)
                VALUES ('pudo', %s, now(), %s, %s, %s, EXTRACT(EPOCH FROM (now() - %s))::int)
                """,
                (iniciado_em, status, total, erro_fatal, iniciado_em),
            )

    print(f"Concluido -- {total} linha(s) gravada(s). Status: {status}")
    sys.exit(1 if erro_fatal else 0)


if __name__ == "__main__":
    main()
