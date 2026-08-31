# Operations runbook

## Routine checks

1. `systemctl status nginx docker ai-agent-postgres-backup.timer`.
2. Run restricted `status <environment>` and `health <environment>`.
3. Check public `/`, `/platform/`, and `/api/health/ready` over HTTPS.
4. Check certificate expiry/renewal, disk and volume capacity, backup age,
   offsite presence, PostgreSQL health, Redis AOF, worker status, and outbox age.
5. Review structured warnings for Redis fail-open, GeoIP unavailability, mail,
   queue retries, and rate limits without dumping environment data.

## First-run platform bootstrap

A freshly provisioned environment has no super administrator, and no authorized
route can create one — granting that role is itself a super-administrator
action. Run the operator command once, on the host, as root:

```bash
ai-agent-deploy bootstrap-super-admin <environment> \
  --email <address> --name '<display name>'
```

You are prompted twice for the password, without echo.

Three things about that command are load-bearing, and hand-rolling a
`docker compose run` gets all three wrong:

- **The image is pinned to the running release.** The compose file resolves the
  backend to the mutable `:development` tag unless `BACKEND_IMAGE` is exported,
  which only a deployment does. An ad-hoc invocation would pull a tag from the
  registry and run it against the live database to mint the platform's root
  credential. The subcommand takes the digest from `CURRENT_RELEASE.json`.
- **It allocates a terminal.** Whether the password is prompted for is decided
  by whether stdin is a TTY inside the container. Without one the command
  silently takes its piped path: no prompt, no echo suppression, no
  confirmation — the operator types the password into a terminal that echoes it,
  which is precisely the persistence the design exists to avoid.
- **It is not reachable over the deploy key.** `ai-agent-deploy-dispatch`'s
  forced-command allowlist covers `deploy`, `status`, `health` and `rollback`
  only. Minting the root credential requires local host access, not possession
  of a deployment secret.

From a repository checkout — development, or a host that has one. The first
form runs the compiled output, so build once; the second compiles on the fly:

```bash
pnpm --filter backend build   # once, if dist/ is absent or stale
pnpm --filter backend cli super-admin:create \
  --email <address> --name '<display name>'

# or, without a build step
pnpm --filter backend cli:dev super-admin:create \
  --email <address> --name '<display name>'
```

Never pass the password as an argument: `--password` is rejected, because by the
time the command could reject it the value is already in shell history and was
visible in `ps`. Never put it in the environment either — it would persist in
`/proc/<pid>/environ` and in anything that serializes the environment. If a
scripted bootstrap is ever genuinely needed, pipe the password into the
checkout form and read it with `read -rs` or from a file, never from a literal.

Exit codes:

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | Created | Sign in through the Platform |
| 1 | Bad arguments; or a password that is empty, mismatched, cancelled, or outside the configured length | Re-run |
| 2 | A super administrator already exists | Grant the role from the Platform |
| 3 | Another bootstrap is running | Wait, then re-check with code 2 |
| 4 | That email already has an account | Choose another address |
| 5 | The command failed | See below — the platform may hold a partial account |

Argument errors and `--help` are answered without connecting to anything, so
they still work while the database is unreachable. Interrupting the password
prompt exits 1 and creates nothing.

**On exit 5.** Account creation is two writes and no transaction: the user row,
then the hashed credential. A failure between them would leave an account with
the role and nothing to sign in with, after which the command would refuse
forever and the platform would be unrecoverable without direct SQL. The command
deletes that half-created row before returning, so a retry is normally the right
next step. If the cleanup could not run either, confirm before re-running:

```sql
SELECT u.id, u.email, u.role
FROM "user" u LEFT JOIN account a ON a."userId" = u.id
WHERE a.id IS NULL AND u.role LIKE '%super_admin%';
```

Any row returned is an unusable account and must be deleted before the bootstrap
can succeed.

The created address is marked verified. Sign-in requires a verified address,
and on a platform being bootstrapped the verification mail has nowhere useful to
go — the mail driver defaults to the log. The operator running this command on
the host is the person who owns the platform, so the check adds no security
here; it would only produce an account nobody can use.

The command changes nothing on a platform that already has a super
administrator, so re-running it is safe.

**Last usable super administrator.** The bootstrap gate still counts every
super administrator, including a banned or deactivated one: host access is the
trust boundary for bootstrap and must not become an account-recovery path.
Separately, application account mutations are prevented from leaving zero
*usable* super administrators. The Better Auth hooks reject a demotion, ban,
deactivation, or deletion that would do so, and a PostgreSQL trigger with a
transaction-scoped advisory lock enforces the same floor for concurrent or
bypassing application writes. Operators can therefore keep at least one
sign-in-capable platform administrator without relying on direct database
repair; out-of-band database administration remains an exceptional recovery
procedure, not part of normal account management.

## First version-aware encryption release

The managed-secret keyring adds two runtime names,
`APP_ENCRYPTION_ACTIVE_KEY_VERSION` and `APP_ENCRYPTION_DECRYPT_KEYS`, and the
first of them is required with no default. The release that introduces them
therefore cannot deploy onto a host prepared for the release before it, and both
halves of that preparation are the operator's.

**This is not a key rotation.** The bytes in `APP_ENCRYPTION_KEY` do not change.
The only thing being added is a stable name for the key already in use, so that
every row written from now on records which key sealed it. No credential is
re-encrypted, nothing is re-entered, and `APP_ENCRYPTION_DECRYPT_KEYS` stays
empty — there is no older key yet for it to hold.

Do both steps **before** the release merges, or the automatic Staging deployment
will refuse. Refusing is the designed outcome, not a failure: the bundle check
and the runtime preflight both run ahead of `compose run --rm migrate`, so a
host that is not ready is turned away with nothing applied.

**1. Name the existing key.** As root on the host, add one line to
`/etc/ai-agent/runtime.env`, leaving `APP_ENCRYPTION_KEY` exactly as it is:

```
APP_ENCRYPTION_ACTIVE_KEY_VERSION=v1
APP_ENCRYPTION_DECRYPT_KEYS=
```

`v1` is a label, not a claim about history. Lowercase letters, digits, `.`, `_`
and `-`, up to 64 characters, not starting or ending with punctuation.

**2. Install host bundle 4.** From a checkout of the release you are about to
deploy: `sudo ops/lightsail/install-host-bundle.sh`. Bundle 3's compose file has
no mapping for the new names and the compose file deliberately does not use
`env_file`, so without this the variable cannot reach the backend however
correctly step 1 was done.

Either order works, and both are safe to do while the current release is still
serving. Bundle 4's new mappings default to empty and the running image ignores
them; the extra line in `runtime.env` is likewise ignored by the running image.

**Verify, without printing the key.** The preflight validates the whole file and
prints no values:

```sh
sudo ai-agent-host-preflight integrity
sudo ai-agent-runtime-preflight staging /etc/ai-agent/runtime.env
grep -c '^APP_ENCRYPTION_ACTIVE_KEY_VERSION=v1$' /etc/ai-agent/runtime.env
grep -q '^APP_ENCRYPTION_KEY=' /etc/ai-agent/runtime.env && echo 'key line present'
```

The third command prints `1` and the fourth confirms the key line is still
there. Neither shows key material. Do not `cat` the file.

**After the deployment.** Existing credentials keep working and are readable
unchanged: their rows carry no key version, and the keyring resolves them by
matching their recorded fingerprint against the one configured key. Nothing is
re-encrypted in bulk, and no background job rewrites them — a row moves to the
versioned form only when a `super_admin` next saves that credential.

**Rollback.** Rolling back to the pre-keyring image is safe for every credential
that image itself wrote. It is *not* safe for one saved after the keyring
deployed: the keyring binds new ciphertext to authenticated data naming the slot
and key version, and the older image supplies no such binding, so it cannot read
those rows whatever key is configured. Treat the first save through the new
image as the point the rollback window closes. Leave bundle 4 installed on a
rollback — it is compatible with the older image, and reinstalling bundle 3
would only have to be undone again.

## Managed secret key rotation

Managed secrets are sealed under a versioned key. Replacing the active key does
not re-encrypt anything, so until every row is migrated the previous key must
stay configured or those credentials become unreadable. This command performs
that migration.

```sh
sudo ai-agent-deploy rotate-managed-secret-keys <environment> --dry-run
sudo ai-agent-deploy rotate-managed-secret-keys <environment>
```

From a checkout, against the local database:

```sh
pnpm --filter backend cli managed-secret:rotate-key --dry-run
```

Rotation does not change any credential's value. It decrypts each row with the
exact key version that row records and re-seals it under
`APP_ENCRYPTION_ACTIVE_KEY_VERSION`. A row already on the active version is
skipped, so running the command twice is the same as running it once, and an
interrupted run is finished by running it again. A row an operator changes
during the run is left as their newer value and rotates on the next pass.

### Rolling out a new key

Do these in order. Skipping D is what makes a credential unrecoverable.

**A.** Deploy the version-aware image while the current key is still the active
one. Nothing is re-encrypted; the deployment simply becomes able to record and
resolve a key version.

This step, not the rotation, is where the rollback window for the *previous*
image closes. A version-aware image binds each credential it writes to
authenticated data naming the slot and key version, and an image from before this
change supplies no such binding — so any credential saved from here on is
unreadable to it whatever key is configured. Confirm you would not roll back past
this release before continuing.

**B.** Add the new key as `APP_ENCRYPTION_KEY` with a new
`APP_ENCRYPTION_ACTIVE_KEY_VERSION`, and move the previous key and its version
into `APP_ENCRYPTION_DECRYPT_KEYS`. Both must be present: new writes use the
active key, existing rows still need the old one. Deploy.

**C.** Run the rotation command.

**D.** Confirm with `--dry-run` that nothing remains. It must exit 0. A non-zero
dry run names every row that is not yet current and why; each has its own remedy
below, and none of them is "continue anyway".

**E.** Keep the old key in `APP_ENCRYPTION_DECRYPT_KEYS` until no database backup
predating step C could still be restored.

The rows this command rewrote do **not** need the old key — they are sealed under
the new one, and that is the point. What still needs it is a table restored from
before the sweep, which comes back full of rows recorded against the old version.
Rolling the *application* back does not undo the re-encryption and does not
recreate that need; rolling the *data* back does.

**F.** Only then remove the old key. This command never removes one: rotation
completing and a key becoming safe to delete are separate facts, and only an
operator can decide the second.

### Exit codes

The command reports whether the table is current, which is not the same question
as whether the run had errors — so a dry run and a live run reach exit 2 for
different reasons.

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | Every secret is on the active key version | Continue the rollout |
| 1 | Bad arguments | Re-run; see `--help` |
| 2 | Ran correctly; the table is not fully current | Read the report — see below |
| 3 | The run itself did not finish | Nothing can be concluded about the table; investigate and re-run |
| 5 | The process failed outside the command | As for 3, and check the host |

On a **live** run, exit 2 means rows were left behind: unreadable, changed
mid-run, or outside this build's registry. On a **dry** run it additionally
includes the rows that *would* rotate — a dry run reporting work still to do is
the answer "not yet", so it must not exit 0 and must never be read as permission
to reach step F.

**On exit 2.** The report names each row and what to do:

- *Unreadable* — no configured key could decrypt it, and the ciphertext was
  verified rather than inferred from its metadata. Either the key that sealed it
  is missing from `APP_ENCRYPTION_DECRYPT_KEYS`, or the stored bytes were
  altered. Restore the key if you have it; otherwise re-enter that credential
  through the Platform. This is the one disposition that can also appear for a
  row already on the active version, and it means that row is corrupt.
- *Changed during the run* — benign. An operator supplied a new value while the
  sweep was in flight; their value was kept and the row rotates on a re-run.
- *Not in this build's registry* — the row names a managed-secret slot this
  release does not define, so nothing here can verify or re-seal it. It is left
  untouched. Retiring the old key does not endanger it if it is already on the
  active version, but the command cannot confirm that, so it reports rather than
  assumes. Resolve it deliberately: deploy a release that defines the slot, or
  remove the row through the Platform once you have established it is obsolete.

Do not proceed to step F while a dry run still reports any row.

## Host bundle updates

The compose file, deploy wrapper, dispatcher, and both preflights are a
versioned host bundle, and the host records what it has in
`/etc/ai-agent/host-bundle.manifest`. When a release changes any of them, check
out that release on the host and run `sudo ops/lightsail/install-host-bundle.sh`;
confirm with `sudo ai-agent-host-preflight integrity`. Never edit an installed
bundle file or the manifest by hand — the wrapper compares recorded digests on
every deployment and will refuse the next release rather than the one after.
[The host bundle document](host-bundle.md) has the inventory and the refusal
order.

## Release

Merge only after stacked PR review. Main CI publishes once; Staging deploys
automatically from the exact publisher-run manifest. Verify Staging behavior
and its `staging-success-<SHA>` evidence. Production is not provisioned: do not
dispatch its workflow. After future operator provisioning, its promotion
procedure requires the staged SHA, Environment approval, and retained evidence.
Never run migrations manually after a failed migration gate without
understanding the database state.

## Incident priorities

- Nginx/TLS failure: keep containers private, validate config/certificate/DNS,
  then reload; do not expose upstream ports as a workaround.
- Redis failure: API ordinary routes fail open for limits and accepted async
  work accumulates durably; recover Redis/worker and monitor outbox drainage.
- PostgreSQL failure: stop writes/traffic, preserve failed state, use the last
  verified restore evidence, and follow the recovery runbook.
- Agent runs failing with `Agent execution failed` and no configuration change:
  a provider answering in the wrong shape *or* with the wrong number of results
  is a retryable failure, so it spends the run's whole queue attempt budget
  (`QUEUE_JOB_ATTEMPTS`, default 3) in paid provider calls, holds one of the
  organization's `agents.max_concurrent_runs_per_organization` slots across the
  backoff, and then lands `FAILED` with nothing delivered. A model that has
  started consistently miscounting therefore shows up as a spend multiplier
  rather than as an error rate. The worker names it: `reason:
  contract_violation` is a contract failure, `runtime_error` is anything else —
  filter on the affected `agentId`/`agentVersion`. The mitigation is the
  per-feature flag or `agents.enabled`, not a retry.
- Deployment refused before migrations: the wrapper names which condition
  failed, and nothing has been applied. Repair the named condition — most often
  by reinstalling the host bundle from the release checkout — rather than
  reaching past the wrapper to run Compose directly.
- Bad release: use application rollback only when schema remains compatible.
- Suspected credential exposure: revoke at the owning boundary, replace the VPS
  runtime file/key, and redeploy; do not paste evidence containing secret values.
