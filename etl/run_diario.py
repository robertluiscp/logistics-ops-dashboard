"""
Agregado DIARIO permanente de Pudo e C2C -- pedido do usuario em 2026-09-17:
diferente de pudo_coletas/c2c_pedidos (janela rolante de 30 dias, se
auto-apaga) e diferente de pudo_mensal/c2c_mensal (so' o total do mes), isto
grava o total de CADA DIA, pra sempre, mesmo depois que o dia sair da janela
rolante.

NAO chama a API -- so' agrega o que o self-heal (run_pudo.py/run_c2c.py) JA'
gravou nas tabelas rolantes. Por isso so' funciona pra dias que ainda estao
dentro da janela de 30 dias no momento em que este script roda -- rodar 1x
por dia (logo depois da meia-noite) processando o dia ANTERIOR (ja' fechado,
"os dados se encerram as 23:59" -- pedido do usuario) garante isso com folga.

Uso:
  python run_diario.py                        -> processa ONTEM (uso normal, diario)
  python run_diario.py 2026-09-10              -> 1 dia especifico (gap-fill manual)
  python run_diario.py 2026-09-01 2026-09-16   -> intervalo (backfill do que ainda esta' na janela rolante)
"""
import functools
import sys
from datetime import date, datetime, timedelta

from src import db

print = functools.partial(print, flush=True)


def _parse_data(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _dias_alvo(argv) -> list[date]:
    if len(argv) >= 3:
        ini, fim = _parse_data(argv[1]), _parse_data(argv[2])
        return [ini + timedelta(days=i) for i in range((fim - ini).days + 1)]
    if len(argv) == 2:
        return [_parse_data(argv[1])]
    return [date.today() - timedelta(days=1)]


def _processar_pudo_dia(dia: date):
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT count(*), count(DISTINCT station_name), count(DISTINCT pick_network_name)
                FROM pudo_coletas WHERE enter_time::date = %s
                """,
                (dia,),
            )
            total, dropoffs, bases = cur.fetchone()
            if total == 0:
                print(f"  pudo {dia}: 0 pacotes na janela rolante -- pode ser dia real sem volume "
                      f"(ex. domingo) OU o dia ja' saiu da janela de 30 dias antes deste job rodar. "
                      f"Gravando 0 mesmo assim (honesto, nao inventa numero).")
            db.upsert_muitos(
                cur, "pudo_diario",
                [{"dia": dia, "total_pacotes": total, "total_dropoffs": dropoffs, "bases_ativas": bases}],
                "(dia)",
            )
    print(f"  pudo {dia}: {total} pacotes, {dropoffs} dropoffs, {bases} bases")


def _processar_c2c_dia(dia: date):
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM c2c_pedidos WHERE input_time::date = %s", (dia,))
            (total,) = cur.fetchone()
            if total == 0:
                print(f"  c2c {dia}: 0 pedidos na janela rolante -- pode ser dia real sem volume "
                      f"(ex. domingo) OU o dia ja' saiu da janela de 30 dias antes deste job rodar. "
                      f"Gravando 0 mesmo assim (honesto, nao inventa numero).")
            db.upsert_muitos(cur, "c2c_diario", [{"dia": dia, "total_pedidos": total}], "(dia)")
    print(f"  c2c {dia}: {total} pedidos")


def main():
    dias = _dias_alvo(sys.argv)
    print(f"Agregados diarios -- {datetime.now():%d/%m/%Y %H:%M:%S} -- {len(dias)} dia(s): {dias[0]} .. {dias[-1]}")
    for dia in dias:
        _processar_pudo_dia(dia)
        _processar_c2c_dia(dia)
    print("Concluido.")


if __name__ == "__main__":
    main()
