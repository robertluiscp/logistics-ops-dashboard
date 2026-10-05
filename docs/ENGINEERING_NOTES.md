# Engineering notes

Real problems hit while running this pipeline against a live, third-party
operations system, and what each one taught. Names of the upstream system and
its endpoints are intentionally omitted; the lessons are the point.

## 1. A "successful" job that wrote nothing

**Symptom.** A scheduled extraction reported `status = success` every hour while
the dashboard showed zero rows for the current day.

**Cause.** Two different things looked identical from the outside: (a) a real
lull in volume and (b) the upstream endpoint intermittently answering with an
empty page. The job treated an empty answer as valid.

**Lessons.**
- Persist **rows written** in every run log, not just the status, and surface a
  run that succeeds with `0` rows repeatedly.
- Compare against a baseline (the same hour on the previous day) before
  believing that "quiet" is normal.
- Self-heal windows only look forward. An outage needs an explicit **backfill**
  command, and the runbook must say so.

## 2. Matching parcels to legs by the wrong field (~98% silently dropped)

**Symptom.** "Dispatched but not arrived" was heavily under-counted: 3 candidates
stored where a manual cross-check found thousands on the same shipment.

**Cause.** In multi-stop secondary routes one shipment has several legs. Each
parcel was matched to a leg by its *final delivery destination*, which almost
never equals the destination of the leg being processed. The unmatched parcels
were discarded by a `continue`, with no log line.

**Fix and lessons.** Match on the parcel's **next stop**. More importantly:
silent `continue` on a lookup miss is a bug factory. Count and log every
discard, and alert when the discard ratio is implausible.

## 3. Replacing fragile pagination with the source's own export job

**Symptom.** Paginating a large list endpoint sometimes returned the *same page
forever* past a certain depth, and its "total" field occasionally reported
absurd numbers (millions for a three-day window). The loop either never ended or
finished with silently missing data.

**Fix.** Use the mechanism the source's own UI uses for large reports: trigger an
asynchronous export job, poll the job list until it completes, download one
file. Slower per call, but one complete file instead of hundreds of fragile
pages. Later hardening, each from a real incident:
- the job list is filtered by date and page; a job created "now" was invisible to
  a narrow filter and to page 1 once the day had accumulated many jobs, so the
  search window and page size were widened;
- turnaround time drifted from seconds to minutes, so the wait budget is now
  generous and the job runs inside a self-heal cycle that tolerates a miss.

## 4. The upstream silently renamed a column

**Symptom.** Extraction "worked" but stored zero rows; the log said every row was
discarded as "not a valid category".

**Cause.** A spreadsheet header changed by one word. Our column mapping looked
the field up by exact name, got `None` for every row, and the validity filter
then rejected everything.

**Lessons.** When parsing tabular files, **assert the required columns exist**
and fail loudly with the missing names. A filter that discards ~100% of rows is
a contract violation, not a data-quality result.

## 5. A cross-process rate limiter, and the leak that broke it

Several scheduled jobs call the same gateway from different processes. Per-process
"1 call per 1.5 s" does not add up, and a WAF blocks the burst. The fix was a
single Postgres row acting as a global queue plus a concurrency cap
(`etl/src/common/throttle.py`).

The cap then failed in a new way: processes killed hard never return their slot,
so the counter drifted to the cap and froze everything. The counter now
records *when* a slot was last taken or returned and resets itself if it is full
and idle for 15 minutes. It also **fails open** when the database is down.
Lesson: any resource counter needs a lease/expiry, because `finally` blocks do
not run when a process is killed.

## 6. `min(processed, loaded)` hid the real problem

**Symptom.** A leg showed `Loaded = 3` but opening it listed hundreds of parcels.

**Cause.** The pipeline stored `processed = min(processed, loaded)` so the
progress bar would never exceed 100%. For a leg where 232 parcels were unloaded
but only 3 had a load scan, it stored `3`, hiding the anomaly in the table and
revealing it only in the detail view.

**Fix.** Store the true number; cap only the *visual bar*, and colour it amber
("100%+") when the real value exceeds the cap. A regression test pins this
(`test_processado_nao_e_limitado_pela_carga`).

**Lesson.** Presentation constraints belong in the presentation layer. Never
destroy information in the database to make a chart look tidy.

## 7. Three-tier retention

Drop-off pickups are tens of thousands of rows per day. Rolling 30-day detail,
permanent **daily** totals, and permanent **monthly** totals give the operation
both drill-down and long history without unbounded storage. The daily job reads
only local tables (no upstream calls), runs just after midnight for the closed
day, and is therefore immune to upstream instability. See `docs/ARCHITECTURE.md`.

## 8. Monitoring the monitor

- A stuck-cycle alert that runs *inside* the cycle can never fire when the cycle
  stops. `verificar_ciclo.py` is a separate job that looks at the last
  successful run.
- A service can be `Running` while doing nothing useful (a tunnel with zero live
  connections is not a crash, so OS recovery actions do not trigger). The
  watchdog checks behaviour from the outside (local health, then public health)
  and restarts only after a *second* failed check.
- After an unclean shutdown, every scheduled job failed at the same dependency
  for about a day. Grouping failures by identical error text across jobs is the
  fastest way to spot a shared root cause.

## 9. Frontend notes

- Header filters in a bilingual table drifted out of alignment because titles
  wrap to 2 or 3 lines depending on column width; a fixed `min-height` and flex
  centring on the title fixed it, plus a redraw after every data reload.
- Chart colours were invisible after adding new chart containers because colour
  rules were keyed by element id; a "black hole" that looked like a sizing bug
  was really a missing CSS selector.
- No build step, on purpose: fewer moving parts for a tool maintained by one
  person.
