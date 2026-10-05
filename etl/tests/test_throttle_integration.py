"""Teste de integracao do throttle global -- precisa de um PostgreSQL
(variaveis PG* no ambiente); e' pulado automaticamente sem elas (ex.: no CI
basico). Usa a tabela `throttle_global` do proprio banco de teste."""
import os
import threading
import time
import unittest

import psycopg2

from src import config
from src.common.throttle import GlobalThrottle

TEM_BANCO = bool(os.getenv("PGUSER") and os.getenv("PGDATABASE"))


@unittest.skipUnless(TEM_BANCO, "PostgreSQL nao configurado (PGUSER/PGDATABASE)")
class GlobalThrottleTests(unittest.TestCase):
    def setUp(self):
        self.t = GlobalThrottle(intervalo_s=0.0, max_concorrencia=3, stale_minutos=15)
        self.t._conexao()  # garante a tabela
        self.espia = psycopg2.connect(**config.PG_CONFIG)
        self.espia.autocommit = True
        self._sql("UPDATE throttle_global SET em_andamento = 0, slot_atualizado_em = now() WHERE id = 1")

    def tearDown(self):
        self._sql("UPDATE throttle_global SET em_andamento = 0 WHERE id = 1")
        self.espia.close()

    def _sql(self, sql, params=None):
        with self.espia.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone() if cur.description else None

    def _em_andamento(self):
        return self._sql("SELECT em_andamento FROM throttle_global WHERE id = 1")[0]

    def test_slot_pega_e_devolve_a_vaga(self):
        with self.t.slot():
            self.assertEqual(self._em_andamento(), 1)
        self.assertEqual(self._em_andamento(), 0)

    def test_devolve_a_vaga_mesmo_com_excecao(self):
        with self.assertRaises(RuntimeError):
            with self.t.slot():
                raise RuntimeError("falha no meio da chamada")
        self.assertEqual(self._em_andamento(), 0)

    def test_release_nunca_fica_negativo(self):
        self.t.release()
        self.t.release()
        self.assertEqual(self._em_andamento(), 0)

    def test_teto_de_concorrencia_e_respeitado_entre_threads(self):
        pico, atual, trava = [0], [0], threading.Lock()

        def trabalhar():
            t = GlobalThrottle(intervalo_s=0.0, max_concorrencia=3)
            with t.slot():
                with trava:
                    atual[0] += 1
                    pico[0] = max(pico[0], atual[0])
                time.sleep(0.15)
                with trava:
                    atual[0] -= 1

        threads = [threading.Thread(target=trabalhar) for _ in range(9)]
        [th.start() for th in threads]
        [th.join() for th in threads]
        self.assertLessEqual(pico[0], 3)
        self.assertEqual(self._em_andamento(), 0)

    def test_auto_recuperacao_de_slot_vazado(self):
        # simula processo morto: teto cheio ha' 20min sem nenhuma atividade
        self._sql("UPDATE throttle_global SET em_andamento = 3, slot_atualizado_em = now() - interval '20 minutes' WHERE id = 1")
        inicio = time.monotonic()
        self.t.acquire(timeout_s=5)
        self.assertLess(time.monotonic() - inicio, 2)  # nao ficou esperando o timeout
        self.assertEqual(self._em_andamento(), 1)  # reiniciado e ja' com a vaga tomada

    def test_teto_cheio_recente_nao_e_tratado_como_vazamento(self):
        self._sql("UPDATE throttle_global SET em_andamento = 3, slot_atualizado_em = now() WHERE id = 1")
        inicio = time.monotonic()
        self.t.acquire(timeout_s=1)  # sem vaga e sem vazamento: espera ate' o timeout (fail-open)
        self.assertGreaterEqual(time.monotonic() - inicio, 0.9)


if __name__ == "__main__":
    unittest.main()
