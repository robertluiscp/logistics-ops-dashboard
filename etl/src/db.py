import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from . import config


@contextmanager
def conexao():
    conn = psycopg2.connect(**config.PG_CONFIG)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def aplicar_schema():
    caminho_schema = config.RAIZ_PROJETO / "db" / "schema.sql"
    sql = caminho_schema.read_text(encoding="utf-8")
    with conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)


def upsert_muitos(cur, tabela, linhas, colunas_conflito):
    """
    Upsert em lote. `linhas`: lista de dicts com as mesmas chaves.
    `colunas_conflito`: nome da coluna, ou "(col1, col2)" para chave composta.
    """
    if not linhas:
        return

    colunas = list(linhas[0].keys())
    colunas_sql = ", ".join(colunas)
    placeholders = ", ".join(["%s"] * len(colunas))
    conflito_cols = {c.strip() for c in colunas_conflito.strip("()").split(",")}
    atualizacoes = ", ".join(
        f"{c} = EXCLUDED.{c}" for c in colunas if c not in conflito_cols and c != "atualizado_em"
    )

    alvo_conflito = colunas_conflito if colunas_conflito.startswith("(") else f"({colunas_conflito})"
    sql = f"""
        INSERT INTO {tabela} ({colunas_sql})
        VALUES %s
        ON CONFLICT {alvo_conflito}
        DO UPDATE SET {atualizacoes}, atualizado_em = now()
    """

    valores = [tuple(linha[c] for c in colunas) for linha in linhas]
    psycopg2.extras.execute_values(cur, sql, valores, template=f"({placeholders})")


def buscar_um(cur, sql, params=None):
    cur.execute(sql, params or ())
    row = cur.fetchone()
    return row
