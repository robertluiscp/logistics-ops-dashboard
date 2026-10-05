"""
Popula um banco (vazio ou nao) com uma operacao DEMO completa -- 100%
sintetica, gerada por src/sources/demo.py.

O que faz, nesta ordem:
  1. aplica o schema
  2. seed da tabela de prazos por municipio (abrangencia_prazos)
  3. ciclo principal de transporte (run.py)
  4. backfill de 30 dias: Pudo, C2C e taxas de expedicao
  5. tickets em aberto e carga/processado
  6. agregados diarios (30 dias) e mensais (8 meses) para os graficos de referencia

Uso (de dentro de etl/):
  python seed_demo.py
"""
import subprocess
import sys
from datetime import date, timedelta

from src import db
from src.common.utils import normalizar_texto
from src.sources import get_source
from src.sources.demo import municipios_demo

DIAS_HISTORICO = 30
MESES_HISTORICO = 8


def _rodar(*args):
    print(f"\n>>> python {' '.join(args)}")
    resultado = subprocess.run([sys.executable, *args])
    if resultado.returncode not in (0, 1):  # 1 = "parcial" nos jobs; outros codigos = falha real
        raise SystemExit(f"falha ao rodar {args[0]} (codigo {resultado.returncode})")


def seed_abrangencia():
    linhas = [{
        "municipio": m["municipio"], "municipio_norm": normalizar_texto(m["municipio"]),
        "estado": m["uf"], "uf": m["uf"], "regiao": "Demo",
        "prazo_hub1_dias": m["prazo_hub1_dias"], "prazo_hub2_dias": m["prazo_hub2_dias"],
        "prazo_hub3_dias": m["prazo_hub3_dias"], "versao_arquivo": "demo",
    } for m in municipios_demo()]
    with db.conexao() as conn:
        with conn.cursor() as cur:
            db.upsert_muitos(cur, "abrangencia_prazos", linhas, "(municipio_norm, uf)")
    print(f"abrangencia_prazos: {len(linhas)} municipios ficticios")


def seed_mensal():
    fonte = get_source()
    hoje = date.today()
    ano, mes = hoje.year, hoje.month
    with db.conexao() as conn:
        with conn.cursor() as cur:
            for _ in range(MESES_HISTORICO):
                r = fonte.count_pudo_month(ano, mes)
                db.upsert_muitos(cur, "pudo_mensal", [{
                    "mes": date(ano, mes, 1), "total_pacotes": r["total_pacotes"],
                    "total_dropoffs": r["total_dropoffs"], "bases_ativas": r["bases_ativas"],
                }], "(mes)")
                cur.execute(
                    "SELECT count(*) FROM c2c_pedidos WHERE date_trunc('month', input_time) = %s", (date(ano, mes, 1),)
                )
                total_c2c = cur.fetchone()[0] or (r["total_pacotes"] // 55)
                db.upsert_muitos(cur, "c2c_mensal", [{"mes": date(ano, mes, 1), "total_pedidos": total_c2c}], "(mes)")
                ano, mes = (ano - 1, 12) if mes == 1 else (ano, mes - 1)
    print(f"agregados mensais: {MESES_HISTORICO} meses")


def main():
    db.aplicar_schema()
    seed_abrangencia()
    _rodar("run.py")
    _rodar("run_pudo.py", "--backfill")
    _rodar("run_c2c.py", "--backfill")
    inicio = (date.today() - timedelta(days=DIAS_HISTORICO)).isoformat()
    ontem = (date.today() - timedelta(days=1)).isoformat()
    _rodar("run_taxas.py", inicio, ontem)
    _rodar("run_tickets.py")
    _rodar("run_carga_processado.py")
    _rodar("run_diario.py", inicio, ontem)
    seed_mensal()
    print("\nSeed concluido. Crie um usuario admin com:  node ../api/scripts/criar_usuario.js demo \"Demo Admin\" --admin")


if __name__ == "__main__":
    main()
