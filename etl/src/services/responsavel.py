"""Regra das 6 horas: compara o instante em que a anomalia foi registrada
por um operador com o prazo (hora_deslacre + 6h) da perna.

Registrou ate' o prazo  -> a responsabilidade e' da base que DESPACHOU.
Registrou depois       -> passa para a base que DESCARREGOU."""


def definir_responsavel(registrado_em_lms, prazo_limite):
    if not registrado_em_lms or not prazo_limite:
        return None
    return "base anterior" if registrado_em_lms <= prazo_limite else "base atual"
