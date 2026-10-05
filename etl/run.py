"""Ponto de entrada. Rodar de dentro da pasta etl/: `python run.py`
Agendar externamente a cada 1 hora (Task Scheduler / cron / PM2)."""

from src.main import executar_etl

if __name__ == "__main__":
    executar_etl()
