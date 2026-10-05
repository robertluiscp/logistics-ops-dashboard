"""
Snapshot dos tickets de reclamacao do SAC ainda EM ABERTO (nao tratados),
dos 2 relatorios da fonte de dados:

  comum      -> clientes comuns (Client A, Client B, Client C...)
  plataforma -> exclusivo Marketplace

Cada execucao substitui todas as linhas do `tipo` na tabela
`tickets_reclamacao` -- ticket que foi tratado sai do relatorio do LMS e
some daqui no ciclo seguinte. Roda de tempos em tempos (agendar ~15 min).

Os dois lados sao independentes: se a extracao de um falhar, o outro ainda
e' atualizado, e o que falhou fica com o snapshot anterior (nunca zera a
tabela por causa de uma falha de rede).

Uso: python run_tickets.py
"""
import functools
import sys

from src import db
from src.sources import get_source

print = functools.partial(print, flush=True)


def _substituir(tipo: str, linhas: list[dict]):
    """Apaga as linhas do `tipo` e insere o snapshot novo, numa transacao."""
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM tickets_reclamacao WHERE tipo = %s", (tipo,))
            db.upsert_muitos(cur, "tickets_reclamacao", linhas, "(id)")
    print(f"  {tipo}: {len(linhas)} tickets gravados")


def main():
    fonte = get_source()

    houve_erro = False
    for tipo in ("comum", "plataforma"):
        try:
            linhas = [l for l in fonte.fetch_open_tickets(tipo) if l["data_registro"] and l["prazo_limite"]]
            _substituir(tipo, linhas)
        except Exception as exc:
            houve_erro = True
            print(f"  {tipo}: FALHOU ({type(exc).__name__}: {exc}) -- mantendo snapshot anterior")

    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT tipo, count(*) FROM tickets_reclamacao GROUP BY tipo ORDER BY tipo")
            print("Total na tabela:", dict(cur.fetchall()))

    sys.exit(1 if houve_erro else 0)


if __name__ == "__main__":
    main()
