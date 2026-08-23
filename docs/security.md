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
- Managed credentials: provider secrets are AES-256-GCM ciphertext in
  PostgreSQL under a bootstrap-only master key, with a fresh nonce per write and
  a full-length authentication tag, so a tampered row fails loudly instead of
  decrypting to something a provider would be handed. The tag length is pinned:
  Node accepts truncated GCM tags and verifies them against a prefix of the
  correct one, which would put forgery within reach of anyone able to write the
  column. No API returns a stored credential, no
  masked preview exists, and none is copied into `process.env` — the plaintext
  goes straight to the adapter that needs it. Writing one requires a
  super-admin-only permission that is separate from reading control-plane
  metadata.
- Knowledge isolation: an organization's chunks are reachable only through a
  query whose `WHERE` carries both `organizationId` and the granted `spaceId`s.
  The predicate is in the statement that ranks, not applied to its results,
  because ranking the whole table first lets another tenant's closer material
  displace this one's from the requested top-N before any filter runs — which
  presents as missing results, not as an error. Both columns are denormalized
  onto the chunk so the predicate cannot be lost to a forgotten join, and the
  agreement between a chunk's tenant and its space's tenant is a composite
  foreign key rather than a convention — a row that claims one organization
  while sitting in another's space cannot be written. A search
  with no organization is refused before a query is built rather than allowed to
  match nothing, and an empty granted-space list retrieves nothing rather than
  everything. The write that attaches an embedding is scoped the same way and
  reports whether it matched, so a cross-tenant chunk id is a visible no-op
  rather than a silent success. Retrieved passages are untrusted context and are
  never used as instructions.
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
