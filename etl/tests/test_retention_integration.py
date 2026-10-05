"""Poda de `pacotes` (retencao rolante). Precisa de um PostgreSQL (PG* no
ambiente); pulado automaticamente sem ele."""
import os
import unittest

import psycopg2

from src import config, db
from src.main import _podar_pacotes

TEM_BANCO = bool(os.getenv("PGUSER") and os.getenv("PGDATABASE"))


@unittest.skipUnless(TEM_BANCO, "PostgreSQL nao configurado (PGUSER/PGDATABASE)")
class PodaPacotesTests(unittest.TestCase):
    PREFIXO = "TESTE_PODA_"

    def setUp(self):
        db.aplicar_schema()
        self.con = psycopg2.connect(**config.PG_CONFIG)
        self.con.autocommit = True
        self._limpar()

    def tearDown(self):
        self._limpar()
        self.con.close()

    def _limpar(self):
        with self.con.cursor() as cur:
            cur.execute("DELETE FROM pacotes WHERE bill_code LIKE %s", (self.PREFIXO + "%",))

    def _inserir(self, nome, deteccao_dias, atualizado_dias):
        with self.con.cursor() as cur:
            cur.execute(
                "INSERT INTO pacotes (bill_code, status, primeira_deteccao, atualizado_em) "
                "VALUES (%s, 'Recebido', now() - (%s || ' days')::interval, now() - (%s || ' days')::interval)",
                (self.PREFIXO + nome, deteccao_dias, atualizado_dias),
            )

    def _existe(self, nome):
        with self.con.cursor() as cur:
            cur.execute("SELECT 1 FROM pacotes WHERE bill_code = %s", (self.PREFIXO + nome,))
            return cur.fetchone() is not None

    def test_poda_so_o_que_esta_parado_alem_da_janela(self):
        dias = config.PACOTES_JANELA_DIAS
        self._inserir("antigo_parado", dias + 5, dias + 5)    # detectado e sem atividade ha' muito -> apaga
        self._inserir("antigo_vivo", dias + 5, 1)             # detectado ha' muito, mas atualizado ontem -> fica
        self._inserir("recente", 2, 1)                        # recente -> fica
        _podar_pacotes()
        self.assertFalse(self._existe("antigo_parado"))
        self.assertTrue(self._existe("antigo_vivo"))
        self.assertTrue(self._existe("recente"))


if __name__ == "__main__":
    unittest.main()
