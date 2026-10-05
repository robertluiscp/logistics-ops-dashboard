"""
Alertas proativos via bot personalizado do Feishu/Lark (webhook de grupo)
-- fecha a lacuna de "o painel só existe se alguém abrir e olhar". Dois
tipos, mesmo webhook:

1. `enviar_alerta_candidatos`: candidatos a "Expedido não chegou" mais
   urgentes. Manda de novo A CADA CICLO enquanto existir algum candidato
   dentro da janela urgente -- decisão combinada com o usuário em
   2026-08-30: melhor repetitivo do que deixar passar despercebido.
2. `enviar_alerta_ciclo_travado`: o ciclo automático parou de rodar com
   sucesso (ver etl/verificar_ciclo.py, 2026-08-31) -- esse roda
   INDEPENDENTE do main.py, senão nunca dispararia justamente quando o
   ETL parou.

Setup do bot: grupo do Feishu > Configurações > Bots > Adicionar bot >
Bot personalizado > copiar a URL do Webhook (e o segredo de assinatura,
se a verificação estiver habilitada) -- ver .env.example.
"""

import hashlib
import hmac
import base64
import time

import requests

from .. import config

MAX_LINHAS_NO_CARTAO = 8


def _assinar(timestamp: str, secret: str) -> str:
    """Receita oficial do Feishu: HmacSHA256 de "{timestamp}\\n{secret}",
    usado como CHAVE com mensagem vazia (nao e' engano -- e' assim mesmo
    que a documentacao deles especifica), depois Base64."""
    string_para_assinar = f"{timestamp}\n{secret}"
    codigo = hmac.new(string_para_assinar.encode("utf-8"), digestmod=hashlib.sha256).digest()
    return base64.b64encode(codigo).decode("utf-8")


def _formatar_intervalo(td) -> str:
    """str(timedelta) sai em ingles ("2 days, 1:48:00") -- formato curto
    em portugues pro alerta ("2d 1h48min")."""
    total_min = int(td.total_seconds() // 60)
    dias, resto_min = divmod(total_min, 1440)
    horas, minutos = divmod(resto_min, 60)
    partes = []
    if dias:
        partes.append(f"{dias}d")
    if horas or dias:
        partes.append(f"{horas}h")
    partes.append(f"{minutos}min")
    return " ".join(partes)


def _situacao_bilingue(tempo_restante) -> str:
    """PT／ZH lado a lado na mesma linha -- time da equipe chinesa le sem
    precisar duplicar o cartao inteiro em duas secoes."""
    if tempo_restante is None:
        return "prazo desconhecido／期限未知"
    intervalo = _formatar_intervalo(abs(tempo_restante))
    if tempo_restante.total_seconds() < 0:
        return f"vencido há {intervalo}／超期{intervalo}"
    return f"restam {intervalo}／剩余{intervalo}"


def _montar_linha(pacote: dict) -> str:
    situacao = _situacao_bilingue(pacote.get("tempo_restante"))
    return f"• {pacote.get('bill_code')} ({pacote.get('shipment_no')}) — {situacao}"


def _enviar_cartao(titulo: str, template: str, corpo_markdown: str, contexto_log: str) -> None:
    """Motor compartilhado de envio -- usado tanto pelo alerta de
    candidatos quanto pelo alerta de ciclo travado (ver
    verificar_ciclo.py). Silencioso (so' print de aviso) se
    FEISHU_WEBHOOK_URL nao estiver configurado ou se a chamada falhar --
    um alerta quebrado nao pode derrubar quem chamou."""
    if not config.FEISHU_WEBHOOK_URL:
        print("  aviso: FEISHU_WEBHOOK_URL não configurado -- alerta não enviado (ver .env.example).", flush=True)
        return

    payload = {
        "msg_type": "interactive",
        "card": {
            "header": {"title": {"content": titulo, "tag": "plain_text"}, "template": template},
            "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": corpo_markdown}}],
        },
    }

    if config.FEISHU_WEBHOOK_SECRET:
        timestamp = str(int(time.time()))
        payload["timestamp"] = timestamp
        payload["sign"] = _assinar(timestamp, config.FEISHU_WEBHOOK_SECRET)

    try:
        resposta = requests.post(config.FEISHU_WEBHOOK_URL, json=payload, timeout=15)
        corpo = resposta.json()
        if corpo.get("code") not in (0, None):
            print(f"  aviso: Feishu recusou o alerta ({corpo})", flush=True)
        else:
            print(f"  -> alerta enviado ao Feishu ({contexto_log}).", flush=True)
    except Exception as exc:
        print(f"  aviso: falha ao enviar alerta ao Feishu ({exc})", flush=True)


def enviar_alerta_candidatos(candidatos: list[dict]) -> None:
    """`candidatos`: mesma lista de status.candidatos_perto_do_prazo() --
    cada item já tem bill_code, shipment_no, tempo_restante."""
    if not candidatos:
        return

    candidatos_ordenados = sorted(candidatos, key=lambda p: p.get("tempo_restante"))
    linhas = [_montar_linha(p) for p in candidatos_ordenados[:MAX_LINHAS_NO_CARTAO]]
    resto = len(candidatos_ordenados) - len(linhas)
    if resto > 0:
        linhas.append(f"_+ {resto} outro(s) na lista completa／清单中还有 {resto} 个_")

    corpo_markdown = (
        f"**{len(candidatos)}** candidato(s) a Expedido não chegou dentro da janela urgente "
        f"(prazo de 6h desde o deslacre perto de vencer ou já vencido).\n"
        f"**{len(candidatos)}** 个「发出未到」疑似异常件进入紧急处理窗口"
        f"(解封后6小时期限即将到期或已超期)。\n\n"
        f"**Mais urgentes／最紧急:**\n" + "\n".join(linhas) +
        f"\n\n[👉 Ver lista completa e exportar pra registrar no LMS／查看完整清单并导出登记]({config.PAINEL_URL})"
    )

    _enviar_cartao(
        titulo="🚨 Expedido Não Chegou — Candidatos Urgentes／发出未到——紧急预警",
        template="red",
        corpo_markdown=corpo_markdown,
        contexto_log=f"{len(candidatos)} candidatos urgentes",
    )


def enviar_alerta_ciclo_travado(horas_desde_ultimo_sucesso: float, ultimo_sucesso_em) -> None:
    """Ciclo automático (agendador, a cada 1h) parou de rodar com sucesso --
    geralmente porque a máquina reiniciou e o agendador não voltou.
    Chamado por verificar_ciclo.py, que roda TOTALMENTE independente do ETL em
    si (senão nunca dispararia justamente quando o ETL parou de rodar).
    """
    ultimo_texto = ultimo_sucesso_em.strftime("%d/%m %H:%M") if ultimo_sucesso_em else "nunca registrado／从未记录"
    horas_texto = f"{horas_desde_ultimo_sucesso:.1f}h"

    corpo_markdown = (
        f"O ciclo automático (roda a cada 1h) não completa com sucesso há **{horas_texto}**.\n"
        f"自动周期（每小时运行一次）已 **{horas_texto}** 未成功完成。\n\n"
        f"Última execução bem-sucedida／最后一次成功执行: **{ultimo_texto}**\n\n"
        f"Causa mais provável: a máquina reiniciou ou o agendador de tarefas parou.\n"
        f"最可能的原因：机器重启了，或任务计划程序已停止。\n\n"
        f"[👉 Ver painel／查看面板]({config.PAINEL_URL})"
    )

    _enviar_cartao(
        titulo="⚠️ Ciclo Automático Travado／自动周期已停止",
        template="orange",
        corpo_markdown=corpo_markdown,
        contexto_log=f"ciclo travado há {horas_texto}",
    )
