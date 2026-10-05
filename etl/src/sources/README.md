# Data sources

The ETL depends only on the `DataSource` contract in [`base.py`](base.py). A
source returns **neutral** structures; nothing else in the pipeline knows where
the data came from.

| `DATA_SOURCE` | What it is |
|---|---|
| `demo` (default) | `demo.py` - a fully synthetic operation. Deterministic for a given `DEMO_SEED` and instant of time. No network. |

## Writing a real adapter

1. Create `etl/src/sources/my_system.py` with a class implementing every method
   of `DataSource` (see the docstrings in `base.py` for the exact shapes).
2. Register it in `get_source()` in `__init__.py` under a new `DATA_SOURCE` value.
3. Keep authentication, endpoint URLs and credentials **out of the repository**
   (environment variables or a secrets manager).
4. Follow the lessons in `docs/ENGINEERING_NOTES.md`:
   - **assert required fields/columns** and fail loudly when they are missing;
   - **count and log every discarded record**;
   - route every outbound call through `common.throttle.GlobalThrottle`;
   - prefer bulk/export mechanisms over deep pagination.

## The neutral shapes at a glance

```text
leg                -> columns of table `pernas` (+ base_origem_nome/base_destino_nome)
scan event         -> {direction: "load"|"unload", site_code, site_name, count,
                       only_loaded, only_unloaded}
loaded parcel      -> {bill_code, origin_code, next_station_code, scanned_at}
unloaded parcel    -> {bill_code, site_code, site_name, scanned_at}
audit status       -> {is_abnormal, reason, registered_at, registered_site_code}
```

## What the demo source guarantees (and the tests check)

- Same seed and same `now` -> identical data.
- A leg's stage never regresses as time advances (Planned -> ... -> Done).
- The load count in the scan summary equals the number of loaded parcels.
- "Flying parcels" appear in the unloaded set but never in the loaded set.
- Closed-day indicators only exist for days before today; open tickets respect
  their SLA; drop-off and C2C rows never lie in the future.
