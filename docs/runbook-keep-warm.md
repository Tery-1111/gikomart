# Runbook — Keep-warm (Render free tier anti-idle)

The production service (`https://gikomart.onrender.com`) runs on Render's free
tier: it spins down after ~15 minutes without inbound HTTP traffic and pays a
cold start (~30–60s) on the next request (see
`docs/runbook-deploy-free-grant.md` §2). This runbook documents the chosen
anti-idle measure and how to set it up. It is intentionally a DOCS-ONLY
change: nothing in the app or CI participates in keep-warm.

## Options considered

- **(a) External uptime monitor pinging `/health` every 10 minutes — CHOSEN.**
  Zero app code, zero dependencies, and the monitor doubles as a real outage
  detector when paired with an alerting service. cron-job.org is the
  recommended primary because it is the only free tool whose creation-time
  verification survives Render's 30–60s cold start. Tools that fail this
  requirement are documented below under "Tools that do NOT work and why".
- **(b) node-cron inside the app pinging its own public URL — rejected.** The
  timer lives in the process, so it must egress to the public URL to count as
  traffic. That adds a self-referential network dependency, pollutes the
  request log with self-pings, and still proves nothing about how the site
  looks from outside. An in-app heartbeat also fails exactly when the app
  fails — the one moment independent signal matters most.
- **(c) Upgrade to a paid Render instance — the CORRECT long-term fix** (no
  spin-down at all, better latency). Out of scope to patch; listed so the
  trade-off stays explicit. If traffic ever justifies it, delete the monitor.

Note on terms: generating artificial traffic to keep a free instance awake
sits in tension with the spirit of Render's free tier. (a) is the mildest
form (one health check per 10 minutes), but if that ever matters, (c) is the
answer.

## Setup — cron-job.org (recommended)

Target: `https://gikomart.onrender.com/health`
Expected response: HTTP 200 with `{"status":"healthy"}`. `/health` reports
the MongoDB connection state only (a `readyState` check, no query — see
`src/routes/health.js`); a 503 with `{"status":"unhealthy"}` means Mongo is
down, not the web process.

Why cron-job.org is primary:
- No creation-time verification gate and no timeout ceiling the 30–60s cold
  start can exceed — the check simply waits out the boot.
- Free tier permits commercial use; GikoMart handles payments.
- Keep-warm only: no alerting, no uptime history. Pair with Better Stack
  below if you want an outage alarm.

Setup:
1. Create a free account at cron-job.org.
2. Add a cron job:
   - URL: `https://gikomart.onrender.com/health`
   - Method: GET
   - Interval: **10 minutes** (safely inside the ~15-minute idle window)
3. Save, then verify (below).

No inactivity requirement: cron-job.org has no rule that pauses or deletes
free monitors for not logging in, so nothing silently stops if you forget
the dashboard exists.

### Optional secondary — Better Stack (alerting only)

cron-job.org will not tell you when the site is actually down. If you want
an outage alarm, add a Better Stack HTTP monitor on the same URL:

- Free tier: 3-minute checks, commercial use allowed.
- Setup: create account → add HTTP monitor (URL as above, method GET) →
  alert on 3 consecutive failures.
- Expect one possible false alert after a long idle: a fresh 30–60s Render
  cold start exceeds the monitor's default timeout, so the wake-up request
  can read as down. Subsequent 3-minute checks see a live site; cron-job.org's
  10-minute heartbeat keeps this steady state rather than permanent.
- Login-based inactivity pause: none found in Better Stack's documentation
  at the time of writing (NOT ESTABLISHED beyond that — confirm at signup).

### Tools that do NOT work and why

- **HetrixTools** — 15-second maximum monitor timeout vs Render's 30–60s
  cold start: the platform's initial verification check rejects the monitor
  before it can be created, and this is not fixable by configuration.
  HetrixTools also requires a dashboard login every 90 days or monitors are
  silently paused. A recurring calendar reminder would be a load-bearing
  part of ANY future HetrixTools setup, not a nice-to-have.
- **UptimeRobot** — free tier is licensed for personal use only; a
  commercial marketplace is not eligible.
- **Site24x7** — free-tier check timeout ceiling of 30–45s: same cold-start
  rejection risk as HetrixTools.
- **Freshping** — shut down in 2025.

## Verify

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://gikomart.onrender.com/health
# expect: 200 and sub-second once warm
```

On the cron-job.org dashboard, open the job's execution history and confirm
consecutive successful runs ~10 minutes apart (the first run after creation
pays the cold start and may appear slow — expected). If you added the
Better Stack monitor, confirm it also reports the site live with an empty
failure counter in steady state. In the Render logs you will see one
`GET /health 200` line per ping — expected log noise, ~6 lines/hour.

## Interactions with existing behavior

- **Rate limiting:** `/health` counts toward the global limiter
  (100 req/min/IP). At 6 pings/hour the monitor uses ~0.1% of the budget —
  do not add an exclusion for it.
- **Metrics/audit:** pings write no collections and trigger no cleanup jobs.
- **Deploys:** Render redeploys on push to `main`
  (see `docs/runbook-deploy-free-grant.md`); the monitor is unaffected and
  will simply show the brief deploy gap.

## Baseline for future comparison

As of 2026-10-07, app.js is loaded with `defer` from `<head>` (cache-buster
`?v=20261006d`): the browser starts fetching and compiling it during initial
HTML parsing, while execution remains non-render-blocking and ordered before
DOMContentLoaded. This is a METRICS-AFFECTING change: any before/after
comparison of LCP/INP/CLS that spans this change measures the delivery
change, not a trend — segment `VitalsSample` data at the deploy that carries
it. (The previous baseline, up to and including the Phase 2 commit:
render-blocking script at the end of `<body>`, no `defer`, `?v=20261006c`.)

## Rollback

Delete the monitor. Nothing in the app, tests, or CI references it; the app
behaves identically without it (it just goes back to cold-starting after 15
idle minutes).
