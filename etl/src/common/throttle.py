"""Throttle GLOBAL entre processos, apoiado numa linha do PostgreSQL.

Problema: varias tarefas agendadas (processos diferentes) chamam o mesmo
gateway externo. Cada uma respeitando "1 chamada a cada N segundos" sozinha
NAO respeita o limite somadas -- e o WAF do gateway bloqueia a rajada.

Solucao (dois mecanismos, ambos atomicos num unico UPDATE):
  1. Espacamento: `ultima_chamada` funciona como uma fila global. Cada chamada
     reserva o proximo slot (ultima_chamada + intervalo) e dorme ate' la'.
  2. Teto de concorrencia: `em_andamento` conta chamadas abertas AGORA,
     somando todos os processos, e bloqueia (poll curto) enquanto estiver no
     limite -- evita rajada de handshakes TLS simultaneos.

Robustez:
  - Auto-recuperacao de vazamento: um processo encerrado na marra (kill,
    queda de energia) nunca devolve o slot. `slot_atualizado_em` marca a
    ultima vez que um slot foi pego ou devolvido; se o teto ficar cheio por
    mais de `stale_minutos` sem nenhuma dessas duas coisas, e' vazamento e o
    contador e' reiniciado sozinho.
  - Fail-open: se o Postgres cair, cai para um throttle local (por processo)
    em vez de travar o ciclo.

Uso:
    throttle = GlobalThrottle(intervalo_s=1.5, max_concorrencia=6)
    with throttle.slot():
        resposta = sessao.get(url)
"""
from __future__ import annotations

import contextlib
import threading
import time

import psycopg2

from .. import config

_DDL = (
    "CREATE TABLE IF NOT EXISTS throttle_global ("
    "  id int PRIMARY KEY,"
    "  ultima_chamada timestamptz NOT NULL DEFAULT now(),"
    "  em_andamento int NOT NULL DEFAULT 0,"
    "  slot_atualizado_em timestamptz NOT NULL DEFAULT now())"
)


class GlobalThrottle:
    def __init__(self, intervalo_s: float = 1.5, max_concorrencia: int = 6,
                 stale_minutos: int = 15, pg_config: dict | None = None):
        self.intervalo_s = intervalo_s
        self.max_concorrencia = max_concorrencia
        self.stale_minutos = stale_minutos
        self._pg_config = pg_config or config.PG_CONFIG
        self._lock = threading.Lock()
        self._conn = None
        self._ultima_local = 0.0  # fallback quando o Postgres cai

    # ---------------------------------------------------------------- conexao
    def _conexao(self):
        if self._conn is None or self._conn.closed:
            self._conn = psycopg2.connect(**self._pg_config)
            self._conn.autocommit = True
            with self._conn.cursor() as cur:
                cur.execute(_DDL)
                cur.execute("INSERT INTO throttle_global (id) VALUES (1) ON CONFLICT DO NOTHING")
        return self._conn

    def _perdeu_conexao(self):
        self._conn = None

    # ------------------------------------------------------------ concorrencia
    def acquire(self, timeout_s: float = 120.0) -> None:
        """Bloqueia ate' haver vaga no teto global. Nao trava o ciclo para
        sempre: se o Postgres cair ou o timeout estourar, segue sem capar."""
        inicio = time.monotonic()
        while True:
            try:
                with self._lock, self._conexao().cursor() as cur:
                    cur.execute(
                        "UPDATE throttle_global SET em_andamento = em_andamento + 1, slot_atualizado_em = now() "
                        "WHERE id = 1 AND em_andamento < %s RETURNING em_andamento",
                        (self.max_concorrencia,),
                    )
                    if cur.fetchone() is not None:
                        return
                    # teto cheio: e' uso legitimo ou vazamento?
                    cur.execute(
                        "UPDATE throttle_global SET em_andamento = 1, slot_atualizado_em = now() "
                        "WHERE id = 1 AND em_andamento >= %s "
                        "AND slot_atualizado_em < now() - (%s || ' minutes')::interval "
                        "RETURNING em_andamento",
                        (self.max_concorrencia, self.stale_minutos),
                    )
                    if cur.fetchone() is not None:
                        print(f"    aviso: throttle preso no teto ha' mais de {self.stale_minutos}min "
                              f"(slot vazado por processo morto) -- reiniciado sozinho")
                        return
            except Exception:
                self._perdeu_conexao()
                return
            if time.monotonic() - inicio > timeout_s:
                return
            time.sleep(0.3)

    def release(self) -> None:
        try:
            with self._lock, self._conexao().cursor() as cur:
                cur.execute(
                    "UPDATE throttle_global SET em_andamento = GREATEST(em_andamento - 1, 0), "
                    "slot_atualizado_em = now() WHERE id = 1"
                )
        except Exception:
            self._perdeu_conexao()

    # -------------------------------------------------------------- espacamento
    def wait_turn(self) -> None:
        with self._lock:
            try:
                with self._conexao().cursor() as cur:
                    # reserva o proximo slot de forma ATOMICA (um UPDATE): varios
                    # processos batendo aqui pegam slots `intervalo_s` afastados.
                    cur.execute(
                        "UPDATE throttle_global "
                        "SET ultima_chamada = GREATEST(ultima_chamada + %s * interval '1 second', now()) "
                        "WHERE id = 1 RETURNING ultima_chamada, now()",
                        (self.intervalo_s,),
                    )
                    slot, agora_db = cur.fetchone()
                espera = (slot - agora_db).total_seconds()
            except Exception:
                self._perdeu_conexao()
                agora = time.monotonic()
                espera = self._ultima_local + self.intervalo_s - agora
                self._ultima_local = max(agora, self._ultima_local) + self.intervalo_s
        if espera > 0:
            time.sleep(espera)

    # ------------------------------------------------------------------ uso
    @contextlib.contextmanager
    def slot(self):
        """Reserva vaga de concorrencia + slot de tempo; devolve a vaga no fim
        (mesmo com excecao)."""
        self.acquire()
        try:
            self.wait_turn()
            yield
        finally:
            self.release()
