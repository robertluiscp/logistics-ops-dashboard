# Scheduling

Every job is a short-lived script; the scheduler (Windows Task Scheduler, cron,
systemd timers, ...) owns the cadence. Suggested cadence:

| Job | Cadence | Purpose |
|---|---|---|
| `run.py` | hourly | legs, parcels, "Expedido nao chegou", alert, `.xlsx` |
| `run_carga_processado.py` | ~20 min | refresh loaded/processed for multi-stop routes |
| `run_pudo.py` | hourly | drop-off pickups (last 6 h, self-healing) |
| `run_c2c.py` | 30 min | C2C orders (last 3 days, self-healing) |
| `run_taxas.py` | every 3 h | on-time rate indicators (last 3 closed days) |
| `run_tickets.py` | 15 min | snapshot of open tickets |
| `run_diario.py` | daily 00:20 | permanent daily totals for the previous day |
| `run_mensal.py` | daily 02:00 | monthly totals (current + previous month) |
| `verificar_ciclo.py` | 20 min | alerts if `run.py` has not succeeded for 2 h |
| `infra/watchdog_painel.ps1` | 10 min | restarts the API / tunnel when unhealthy |

All jobs run from inside `etl/` and exit `0` on success, `1` on partial/error.

## Backfilling after an outage

Self-healing windows only look a few hours/days back. After a longer outage,
backfill explicitly:

```bash
python run_pudo.py 2026-09-22 2026-09-24     # a date range, day by day
python run_c2c.py  2026-09-22 2026-09-24
python run_taxas.py 2026-09-14 2026-09-24
python run_diario.py 2026-09-20 2026-09-24   # only days still in the rolling window
```

## Cron example

```cron
0  * * * *   cd /opt/ops/etl && python run.py
*/30 * * * * cd /opt/ops/etl && python run_c2c.py
20 0 * * *   cd /opt/ops/etl && python run_diario.py
```

## Windows example

```powershell
$acao = New-ScheduledTaskAction -Execute "C:\ops\etl\.venv\Scripts\python.exe" -Argument "run.py" -WorkingDirectory "C:\ops\etl"
$gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "OpsHub-ETL" -Action $acao -Trigger $gatilho
```

> Tip: laptops default to "don't start on battery" and "stop if running on
> battery". Turn both off for these tasks or they silently stop when unplugged.
