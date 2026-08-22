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

**Lockout.** A deactivated or banned super administrator still counts, so the
gate stays closed — deliberately, since the alternative would let anyone with
host access mint a new root credential on a live platform by deactivating the
old one. The consequence is that deactivating or demoting the last super
administrator locks the platform out with no sanctioned recovery, and repair
means restoring that account's role directly in the database. Treat the last
super administrator as load-bearing.

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
- Bad release: use application rollback only when schema remains compatible.
- Suspected credential exposure: revoke at the owning boundary, replace the VPS
  runtime file/key, and redeploy; do not paste evidence containing secret values.
