"""
Extrai os pedidos C2C para `c2c_pedidos` e calcula o prazo final de cada um
via `abrangencia_prazos` (Cidade Destino + UF -> dias corridos a partir do
hub de referencia do estado de origem -- ver config.HUB_POR_ESTADO --
contados da "Hora de envio"). Self-heal dos ultimos 3 dias por padrao,
backfill maior sob pedido.

Extrai o PERIODO INTEIRO numa janela so' (nao 1 chamada por dia); periodos
maiores que JANELA_MAX_DIAS_POR_CHAMADA sao divididos em pedacos desse tamanho.

Uso:
  python run_c2c.py                        -> self-heal ultimos 3 dias (rodar com frequencia)
  python run_c2c.py --backfill              -> janela completa de C2C_JANELA_DIAS dias
  python run_c2c.py 2026-08-01 2026-08-05   -> intervalo especifico (gap-fill manual)
"""
import functools
import sys
from datetime import date, datetime, timedelta

from src import config, db
from src.common.utils import normalizar_texto
from src.sources import get_source

print = functools.partial(print, flush=True)

# Estado de origem -> coluna de prazo do hub de referencia (config.HUB_POR_ESTADO).
COLUNA_PRAZO_POR_ORIGEM = config.HUB_POR_ESTADO


def _parse_data(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _carregar_abrangencia() -> dict:
    """{(municipio_norm, uf): {prazo_hub1_dias, prazo_hub2_dias, prazo_hub3_dias}}"""
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT municipio_norm, uf, prazo_hub1_dias, prazo_hub2_dias, prazo_hub3_dias FROM abrangencia_prazos")
            linhas = cur.fetchall()
    return {
        (muni, uf): {"prazo_hub1_dias": sjs, "prazo_hub2_dias": bnu, "prazo_hub3_dias": nsr}
        for muni, uf, sjs, bnu, nsr in linhas
    }


def _calcular_prazo(linha: dict, mapa_abrangencia: dict):
    coluna = COLUNA_PRAZO_POR_ORIGEM.get(linha["origin_province"])
    chave = (normalizar_texto(linha["destination_name"]), linha["destination_province"])
    achado = mapa_abrangencia.get(chave)
    prazo_dias = achado.get(coluna) if (achado and coluna) else None

    linha["prazo_dias"] = prazo_dias
    linha["abrangencia_encontrada"] = prazo_dias is not None
    linha["prazo_limite"] = (
        linha["input_time"] + timedelta(days=prazo_dias)
        if (prazo_dias is not None and linha["input_time"])
        else None
    )
    return linha


def _gravar(linhas: list[dict], mapa_abrangencia: dict):
    linhas = [l for l in linhas if l["input_time"] is not None]
    if not linhas:
        return 0, 0
    # Dedup por "id" -- achado em 2026-09-15: com a paginacao corrigida
    # (varias paginas por dia em vez de so' a 1a), retentativas no meio da
    # extracao podem pegar o MESMO pedido em paginas diferentes (a "lista"
    # do lado do LMS se move/reordena entre tentativas quando ela falha e
    # tenta de novo) -- isso fazia o upsert em lote falhar inteiro com
    # "ON CONFLICT DO UPDATE command cannot affect row a second time"
    # (Postgres nao aceita 2 linhas com o mesmo "id" no MESMO comando).
    antes = len(linhas)
    linhas = list({l["id"]: l for l in linhas}.values())
    if len(linhas) < antes:
        print(f"    c2c: {antes - len(linhas)} duplicata(s) removida(s) antes de gravar")
    linhas = [_calcular_prazo(l, mapa_abrangencia) for l in linhas]
    achados = sum(1 for l in linhas if l["abrangencia_encontrada"])
    with db.conexao() as conn:
        with conn.cursor() as cur:
            db.upsert_muitos(cur, "c2c_pedidos", linhas, "(id)")
    return len(linhas), achados


JANELA_MAX_DIAS_POR_CHAMADA = 30  # confirmado ao vivo pelo usuario 2026-09-15, ver docstring


def _periodo_alvo(argv) -> tuple[date, date]:
    if len(argv) >= 3:
        return _parse_data(argv[1]), _parse_data(argv[2])
    hoje = date.today()
    if "--backfill" in argv:
        return hoje - timedelta(days=config.C2C_JANELA_DIAS), hoje
    return hoje - timedelta(days=2), hoje


def _dividir_em_janelas(inicio: date, fim: date, max_dias: int) -> list[tuple[date, date]]:
    """[inicio, fim] em pedacos de no maximo max_dias (inclusive) cada."""
    janelas = []
    cursor = inicio
    while cursor <= fim:
        fim_pedaco = min(cursor + timedelta(days=max_dias - 1), fim)
        janelas.append((cursor, fim_pedaco))
        cursor = fim_pedaco + timedelta(days=1)
    return janelas


def _podar():
    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM c2c_pedidos WHERE input_time < now() - (%s || ' days')::interval",
                (config.C2C_JANELA_DIAS,),
            )
            apagadas = cur.rowcount
    if apagadas:
        print(f"  poda: {apagadas} linha(s) fora da janela de {config.C2C_JANELA_DIAS} dias removida(s)")


def main():
    iniciado_em = datetime.now()
    inicio, fim = _periodo_alvo(sys.argv)
    janelas = _dividir_em_janelas(inicio, fim, JANELA_MAX_DIAS_POR_CHAMADA)
    print(f"C2C -- {inicio} .. {fim} ({len(janelas)} janela(s) de ate' {JANELA_MAX_DIAS_POR_CHAMADA} dias)")

    total, total_achados = 0, 0
    erro_fatal = None
    falhas = []

    try:
        fonte = get_source()
        mapa_abrangencia = _carregar_abrangencia()
        if not mapa_abrangencia:
            print("  aviso: abrangencia_prazos esta vazia -- rode seed_demo.py (ou carregue a tabela) primeiro. "
                  "Prosseguindo, mas ninguem vai ter prazo calculado.")

        for jan_inicio, jan_fim in janelas:
            try:
                linhas, incompleto = fonte.fetch_c2c(datetime.combine(jan_inicio, datetime.min.time()), datetime.combine(jan_fim, datetime.max.time()))
            except Exception as exc:
                msg = f"{jan_inicio}..{jan_fim}: {type(exc).__name__}: {exc}"
                print(f"  {msg} -- seguindo pras outras janelas")
                falhas.append(msg)
                continue
            # incompleto=True -- a fonte devolveu menos do que o total real.
            # Ainda grava o que foi coletado (nunca descarta o parcial), mas
            # marca a execucao como "parcial" pra nao esconder que a janela
            # pode estar com dado faltando.
            if incompleto:
                falhas.append(f"{jan_inicio}..{jan_fim}: extracao parcial ({len(linhas)} registro(s) obtido(s))")
            try:
                gravadas, achados = _gravar(linhas, mapa_abrangencia)
            except Exception as exc:
                # nao deixa um erro ao GRAVAR uma janela (ex.: dado
                # inesperado) derrubar o backfill inteiro das janelas
                # seguintes -- achado em 2026-09-15 (CardinalityViolation
                # abortou um backfill de 5 dias na primeira falha, perdendo
                # os outros 4).
                msg = f"{jan_inicio}..{jan_fim}: falha ao gravar -- {type(exc).__name__}: {exc}"
                print(f"  {msg} -- seguindo pras outras janelas")
                falhas.append(msg)
                continue
            print(f"  {jan_inicio}..{jan_fim}: {len(linhas)} extraidos, {gravadas} gravados, {achados} com prazo calculado")
            total += gravadas
            total_achados += achados

        _podar()
    except Exception as exc:
        erro_fatal = f"{type(exc).__name__}: {exc}"
        print(f"FALHA GERAL: {erro_fatal}")

    if erro_fatal:
        status = "erro"
    elif falhas:
        status = "parcial"
    else:
        status = "sucesso"

    with db.conexao() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO execucoes_dropoff (relatorio, iniciado_em, finalizado_em, status,
                                                linhas_gravadas, erro_mensagem, duracao_segundos)
                VALUES ('c2c', %s, now(), %s, %s, %s, EXTRACT(EPOCH FROM (now() - %s))::int)
                """,
                (iniciado_em, status, total, erro_fatal or ("\n".join(falhas) or None), iniciado_em),
            )

    print(f"Concluido -- {total} pedido(s) gravado(s) ({total_achados} com prazo). Status: {status}")
    sys.exit(1 if status != "sucesso" else 0)


if __name__ == "__main__":
    main()
