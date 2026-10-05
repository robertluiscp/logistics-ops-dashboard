import re
import unicodedata
from datetime import datetime


def parse_dt(valor):
    if not valor:
        return None
    for formato in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(valor, formato)
        except ValueError:
            continue
    return None


def normalizar_texto(texto) -> str:
    """Maiusculo, sem acento, espacos colapsados -- pra join robusto entre
    nomes de municipio vindos de fontes diferentes (pedidos vs tabela de
    prazos por municipio). Ver run_c2c.py / seed_demo.py."""
    if not texto:
        return ""
    sem_acento = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", sem_acento).strip().upper()


def derivar_etapa(hora_lacre, hora_deslacre, partida_real, chegada_real):
    """A fonte devolve um codigo de estado numerico cujo mapeamento
    completo nao e' confiavel -- derivamos a etapa pelos
    timestamps, que sao inequívocos, igual ao painel de referência.

    chegada_real sozinho ja basta pra "Concluido" (antes exigia
    hora_deslacre tambem) -- achado em 2026-09-09 comparando contra export
    real: rota Secundaria de 3+ paradas pode ter chegada_real preenchido
    na perna final sem hora_deslacre capturado (a LMS as vezes nao devolve
    o evento de deslacre de paradas intermediarias/finais em rotas longas
    -- ainda em investigacao o motivo exato). Sem esse ajuste, uma perna
    JA CHEGADA caia pro fallback errado ("Planejado", o estagio menos
    avancado possivel) so por faltar um campo intermediario -- chegada e'
    sempre o sinal mais definitivo disponivel, nao devia depender de
    nenhum outro campo pra valer."""
    if chegada_real:
        return "Concluído"
    if hora_deslacre:
        return "Em Descarregamento"
    if partida_real:
        return "Em Trânsito"
    if hora_lacre:
        return "Carregando"
    return "Planejado"
