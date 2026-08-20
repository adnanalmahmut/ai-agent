# Troubleshooting

| Symptom | Check | Safe response |
|---|---|---|
| 502 from Nginx | loopback listeners, container health, rendered upstream ports | restore service health; never open upstream publicly |
| Wrong client IP | proxy snippet, trust-hop environment, direct spoof tests | restore overwrite headers and one-hop trust |
| Sessions lack location | MMDB volume/file, geoipupdate logs and runtime names | authentication remains valid; repair updater |
| 429 too early | route template/subject, configured points/window, auth vs Nest limiter | inspect keys/headers; do not disable all limits blindly |
| Redis warning/headers absent | Redis readiness and bounded connection errors | ordinary routes intentionally fail open; repair and observe |
| Migration gate fails | migration image SHA, `DATABASE_URL`, migration history | stop rollout; do not start new code or mark migration applied casually |
| Worker not running | restricted status, worker logs, Redis, outbox leases | repair worker; accepted work remains in PostgreSQL |
| Publish artifact missing | main CI/publisher conclusion, exact publisher run ID, and packages permission | rerun/fix publisher; never rebuild in staging/production |
| Production rejects evidence | requested SHA, staging artifact name, embedded staging run ID, fixed GHCR repositories | repair the evidence chain; never substitute a tag or hand-entered digest |
| SSH rejected | Environment user/host/key/known-hosts and ForcedCommand syntax | correct names/key; do not weaken host-key checking or sudo |
| Cert renewal fails | DNS, port 80 ACME path, expiry, `nginx -t` | fix challenge and dry-run before reload |
| Backup exists but verify fails | checksum, archive catalog, disk/offsite transfer | mark unusable and create a new verified backup |

When diagnosing, use targeted status/log commands. Do not run `env`, `set`,
`printenv`, enable shell tracing around credentials, or copy runtime.env into an
issue or CI log.
