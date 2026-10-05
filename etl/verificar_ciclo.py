"""
Verifica se o ciclo automático do ETL (Task Scheduler, a cada 1h) está
rodando de verdade -- roda como uma tarefa PRÓPRIA e SEPARADA do main.py
de propósito: se o ciclo parou de rodar (ex.: a maquina reiniciou e
o agendador nao voltou), um alerta
que só disparasse DE DENTRO do próprio ciclo nunca dispararia.

Rodar via Task Scheduler como SYSTEM, a cada ~15-30min -- não precisa de
sessão ativa nem admin pra RODAR (só pra registrar a tarefa), já que só
consulta o Postgres e manda um HTTP pro Feishu.

Uso: python verificar_ciclo.py
"""
import json
from datetime import datetime, timedelta

from src import config, db
from src.services.alerta_feishu import enviar_alerta_ciclo_travado

# Ciclo e' de 1h -- da' 1 ciclo inteiro de folga antes de alertar, pra nao
# disparar por um unico atraso pontual.
LIMITE_HORAS_SEM_SUCESSO = 2.0
# Nao repete o alerta a cada 15-30min enquanto o problema persiste --
# reenvia no maximo de hora em hora, ate' resolver.
INTERVALO_MINIMO_ENTRE_ALERTAS_HORAS = 1.0
ARQUIVO_ESTADO = config.PASTA_DATA / "ultimo_alerta_ciclo.json"


def _ultimo_alerta_enviado_em():
    if not ARQUIVO_ESTADO.exists():
        return None
    try:
        dado = json.loads(ARQUIVO_ESTADO.read_text(encoding="utf-8"))
        return datetime.fromisoformat(dado["enviado_em"])
    except Exception:
        return None


def _registrar_alerta_enviado():
    config.PASTA_DATA.mkdir(parents=True, exist_ok=True)
    ARQUIVO_ESTADO.write_text(
        json.dumps({"enviado_em": datetime.now().isoformat()}), encoding="utf-8"
    )


def verificar():
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT MAX(finalizado_em) FROM execucoes_etl WHERE status = 'sucesso'")
            ultimo_sucesso_em = cur.fetchone()[0]

    if ultimo_sucesso_em is None:
        # nunca teve nenhuma execucao bem-sucedida registrada -- caso
        # extremo (banco novo/zerado), trata como "sempre travado".
        horas_desde = float("inf")
    else:
        horas_desde = (datetime.now() - ultimo_sucesso_em).total_seconds() / 3600

    if horas_desde < LIMITE_HORAS_SEM_SUCESSO:
        return

    ultimo_alerta = _ultimo_alerta_enviado_em()
    if ultimo_alerta and (datetime.now() - ultimo_alerta) < timedelta(hours=INTERVALO_MINIMO_ENTRE_ALERTAS_HORAS):
        return

    print(f"ciclo travado ha {horas_desde:.1f}h (ultimo sucesso: {ultimo_sucesso_em}) -- enviando alerta.", flush=True)
    enviar_alerta_ciclo_travado(horas_desde, ultimo_sucesso_em)
    _registrar_alerta_enviado()


if __name__ == "__main__":
    verificar()
