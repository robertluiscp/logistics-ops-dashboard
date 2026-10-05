"""Fontes de dados do ETL. Use `get_source()` -- ela escolhe pela variavel
de ambiente DATA_SOURCE (padrao: "demo")."""
from __future__ import annotations

from .. import config
from .base import DataSource


def get_source() -> DataSource:
    if config.DATA_SOURCE == "demo":
        from .demo import DemoSource
        return DemoSource(seed=config.DEMO_SEED)
    raise RuntimeError(
        f"DATA_SOURCE={config.DATA_SOURCE!r} nao e' suportado neste repositorio. "
        "Implemente o contrato de src/sources/base.py (ver src/sources/README.md) "
        "para conectar um sistema real."
    )
