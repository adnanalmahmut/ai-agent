# Security model

Primary boundaries:

- Public network: host Nginx 80/443 only; application ports loopback; data
  services internal.
- Client identity: one trusted proxy hop, overwritten headers, canonical
  `req.ip`, spoofing tests.
- Authentication: server-only session metadata, encrypted OAuth tokens,
  verified-email flows, database limiting on sensitive native routes.
- Authorization: structurally separate global/organization RBAC and reversible
  lifecycle rather than destructive deletion.
- Abuse control: atomic Redis sliding windows; explicit observable fail-open for
  ordinary availability; independent auth limits.
- Deployment: restricted key/ForcedCommand, no Docker group, no unrestricted
  sudo, root-owned wrapper/runtime.env, fixed image repositories, SHA/digest
  validation, and exact publisher → staging → production evidence lineage.
- Runtime secrets: GitHub and coding agents know names only; the deploy user
  cannot read the root-only file; Compose passes explicit per-service allowlists
  so the worker and migration process do not inherit API-only credentials.
- Supply chain: frozen pnpm lock, current generated Prisma client, SHA-tagged
  images, provenance/SBOM, digest-pinned migration and runtime images, no
  production rebuild.
- Recovery: root-only verified backups; deploy user cannot access backups or
  restore operations.

Never log tokens, cookies, runtime.env, environment dumps, or raw GeoIP request
data. Never add runtime secrets to GitHub merely because a workflow needs to
trigger deployment. A new proxy hop, auth route, role capability, Redis failure
policy, migration, or deploy operation requires tests at its boundary.

Known operational gaps remain operator-owned: monitoring/alerting, offsite
backup, a recorded restore drill, and all Production provisioning and evidence.
Prepared Production automation does not grant agents authority to operate it.
