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
- Control-plane history: mutations append an atomic audit event with only
  closed, sensitivity-aware before/after projections. The event payload never
  contains a credential plaintext, ciphertext, IV, authentication tag, or other
  recoverable credential material; the Platform likewise renders only known
  safe state shapes. That client-side containment is regression-tested: an
  audit fixture carrying a recognizable secret canary inside unexpected and
  hostile `before`/`after` payloads — unknown `kind`, widened known `kind`,
  nested objects, arrays, bare strings, and markup — must not put the canary
  into `document.body.innerHTML` or its visible text, while every row still
  summarises the change from the client's own closed translated vocabulary.

  One field is a deliberate, bounded exception to that projection: a managed
  secret's encryption `keyVersion`, which the change column displays because
  re-encryption is the only action whose entire content is that field changing.
  It is filtered through `displayableKeyVersion`, which admits only the shape the
  backend's own key-version grammar admits — lowercase letters, digits, dot,
  underscore and hyphen, not beginning or ending in punctuation — under a cap
  tighter than that grammar's. A value outside it is replaced by a client-owned
  "not shown" term rather than truncated, so the cell cannot carry markup,
  quotes, whitespace, or the bidirectional-format characters that would let a
  value reorder the row it sits in. Both halves of that gate are covered by
  mutation-tested unit and rendering assertions, including hostile canaries that
  fail on the character class and on the length cap respectively.

  This gate bounds the value's *shape* and not its meaning, and the distinction
  is asserted rather than assumed: a lowercase token inside the cap is displayed
  whatever it happens to be. What keeps credential material out of that column is
  upstream — the rotation service records a key version only after the keyring
  successfully opened the row, and resolution requires the version to be one the
  process was configured with. The audit payload is read without an output
  schema, so a build, migration, restore, or direct write that put other text in
  that field could put a bounded amount of it on an operator's screen. This is
  the panel's one such field, and widening the set is a security change.

  The `action` column is projected the same way — `use-intl` renders a missing key as
  its own key path, so an action this build has no copy for resolves to a
  fall-through term rather than printing the server's string — and an
  unparseable `occurredAt` degrades to a dash instead of throwing out of the
  render and blanking the screen. The identifying columns (`actorUserId`,
  `resourceKey`, `organizationId`, and the `<time dateTime>` attribute) are
  rendered verbatim by design, as escaped React text written from closed
  server-side sets.
- Organization product history: a separate tenant-owned append-only table and
  endpoint record meaningful domain mutations, initially business-profile
  replacement. The writer accepts a closed action-specific state rather than
  metadata or request bodies, and commits the row in the same transaction as
  the profile change. Unknown fields—including a tested secret-like canary—are
  rejected before persistence and have no field in the projection. Reads are
  always scoped by the authorized path organization and reuse
  `organization:update`, so only organization admins/owners who may see those
  settings can see their history; ordinary members, outsiders, and non-member
  global operators gain no tenant visibility. No update/delete service or HTTP
  route exists for product audit rows, and a PostgreSQL trigger rejects direct
  UPDATE/DELETE statements issued through the shared application role. History
  is retained indefinitely until an approved product/legal requirement defines
  another policy; any future deletion path must deliberately revise that
  database invariant in a separately reviewed migration.
- Agent context: what an agent may read is declared on its definition as a
  `ContextPolicy` naming knowledge spaces by slug, and the slugs are resolved
  against the caller's own organization at assembly time — so a definition
  cannot name its way into another tenant's material, and an agent with no
  policy retrieves nothing rather than everything. Assembly is application code
  rather than a runtime primitive, which is what keeps the tenant predicate,
  the space policy and the context budget in this repository. Retrieved
  passages travel separately from the request and are rendered into the user
  message, fenced and labelled as quoted material, never into the instructions:
  they are text some member typed into a document. Angle brackets inside a
  passage are replaced before fencing, so a document cannot close the fence and
  continue where the preamble has told the model the caller's request appears.
  That is mitigation, not proof — nothing in a prompt makes a model incapable of
  following text it is shown — and what bounds it is that this milestone's agent
  has no tools and no side effects, so a hostile passage costs a bad answer
  inside the tenant that stored it. The fence is nonetheless made unbreakable,
  because that bound disappears the first time this agent is given a tool. The provider's answer is parsed against the definition's declared
  schema before it is stored, because a model is an untrusted source that this
  application happens to pay for.
- Provider credentials at execution: the key is resolved per run from the
  encrypted store and handed to the SDK on its model config. It is never
  exported to the environment, never placed in a job payload, and never read
  back from one — Mastra's default of resolving a `provider/model` string
  through a provider environment variable would put the platform's key in the
  worker's process environment for the life of the process. A provider with no
  credential mapping is a configuration error, never a fallback to the
  environment; an unreadable credential is reported as the provider being
  unavailable and carries nothing from the cause, because the one thing that
  report must not do is describe the secret it failed to read.
- Agent spend: acceptance checks `agents.enabled` before the per-feature flag,
  so an operator has one switch that stops every agent. It also enforces
  `agents.max_concurrent_runs_per_organization` against the organization's
  in-flight runs — the per-user rate limit bounds one member, and the bill is
  the organization's. The generation call carries an output-token ceiling, a
  wall-clock timeout, and no SDK-level retry, so retry stays with BullMQ where
  each attempt is recorded against the run. A definition may also declare an
  `outputContract`, checked after the output schema and before durable success,
  so a promise about the request/answer pair — `content-idea@1` must return
  exactly the requested number of ideas — is enforced rather than merely
  prompted for. A violation is a closed `AgentOutputContractViolation` — a listed
  code, plus two integers for a count, never a string — and
  `AgentOutputContractError` composes the message from it, so no provider output
  can reach a log, BullMQ's `failedReason`, or `AgentRun.lastError`. The type is
  what enforces that, not a convention. A contract that cannot reach a verdict
  refuses (`unverifiable`) rather than passing, so the promise cannot switch
  itself off silently. The class is read by the worker only to choose the word
  `contract_violation` in its log; the retry classification is unchanged.
- Agent installation configuration: code definitions own the Zod schema and
  default for each exact installable revision. The database is never a generic
  agent-definition or arbitrary-JSON authority, and the current production
  definition accepts only `{}`; unknown keys, including credential-shaped
  values, are refused before persistence. Installation management and history
  require path-scoped organization `update`, so members receive 403 while
  outsiders and non-member platform administrators receive the same 404 as an
  unknown organization. Every resource predicate repeats the path tenant, and
  composite foreign keys bind both a version and the active pointer to their
  installation identity. A compound database constraint makes revision numbers
  unique within, but only within, one installation. The active-pointer foreign
  key is commit-deferred so pointer CAS happens before candidate insertion;
  only the CAS winner can write the next version, and any later failure rolls
  the pointer change back. Versions have no update/delete route, and
  installations have no delete route.
- Agent run entitlement: control-plane flags authorize product execution but do
  not create tenant product state. A new run must resolve an explicit
  organization installation and its enabled active version inside the same
  tenant-scoped transaction that writes the run and outbox event. Missing and
  disabled installations produce only the bounded `agent_not_installed` and
  `agent_disabled` reasons; there is no backfill, lazy or first-run install,
  feature-flag-as-install shortcut, or fallback to a global definition. That
  separation prevents the application from fabricating organization-owned
  state the organization never selected. The run/version composite foreign key
  includes `organizationId`, worker lookup also binds agent id and definition
  revision, and BullMQ carries only `{ runId }`, so neither a caller nor Redis
  can substitute another tenant's version. Historical null-version runs are a
  narrow pre-AGT-02 compatibility case: they execute the pinned definition's
  code-owned default and never read today's installation. The current Platform
  has no installation-management UI; the frontend reports the bounded state and
  never converts it into an install action.
- Browser storage: the Platform's ambiguous-submission record in
  `sessionStorage` holds only `{ idempotencyKey, requestDigest }`, where the
  digest is SHA-256 over the canonical normalized request. Sameness across a
  reload is all the value is ever asked for, so the operator-authored request
  text — topic, goal, audience, guidance — is never written to a store every
  script on the origin can read. It is a sameness check between two of this
  tab's own submissions rather than a secret, so it stays per-tab and is cleared
  as soon as acceptance or refusal is unambiguous.
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
