#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

for script in \
  infra/deploy/ai-agent-deploy \
  infra/deploy/ai-agent-deploy-dispatch \
  infra/deploy/bootstrap-host.sh \
  infra/deploy/install-host-bundle.sh \
  infra/gateway/nginx/install-nginx.sh \
  infra/gateway/nginx/issue-certificate.sh \
  infra/gateway/nginx/reload-nginx-after-renewal; do
  sh -n "$script"
done

grep -Fq 'restrict,no-user-rc,command="/usr/local/sbin/ai-agent-deploy-dispatch"' infra/deploy/bootstrap-host.sh
# First-run bootstrap and every later bundle update must install the
# release-coupled files by the same path, so that both record a manifest. When
# bootstrap listed the `install` commands itself, nothing on the host recorded
# which release its compose file and deploy script came from.
#
# Matched on the installer's name rather than on a repository path: bootstrap
# resolves it as its own neighbour now, so that it no longer depends on which
# directory the operator was standing in. What has to stay true is that the
# installer is what runs, not how the call spells its location.
grep -Fq 'install-host-bundle.sh' infra/deploy/bootstrap-host.sh
if grep -Eq '^install .*(ai-agent-deploy|runtime-preflight|host-preflight|sudoers)' infra/deploy/bootstrap-host.sh; then
  echo 'release-coupled host files must be installed by the bundle installer' >&2
  exit 1
fi
grep -Fq 'host-bundle.manifest' infra/deploy/host-preflight.sh
grep -Fq 'sha256sum' infra/deploy/install-host-bundle.sh
grep -Fq 'gpasswd -d deploy docker' infra/deploy/bootstrap-host.sh
grep -Fq 'fallocate -l 2G /swapfile' infra/deploy/bootstrap-host.sh
grep -Fq '/swapfile none swap sw 0 0' infra/deploy/bootstrap-host.sh
grep -Fq 'vm.swappiness=10' infra/deploy/bootstrap-host.sh
grep -Fq 'install_certbot_tls_asset options-ssl-nginx.conf /etc/letsencrypt/options-ssl-nginx.conf' infra/gateway/nginx/issue-certificate.sh
grep -Fq 'install_certbot_tls_asset ssl-dhparams.pem /etc/letsencrypt/ssl-dhparams.pem' infra/gateway/nginx/issue-certificate.sh
grep -Fq 'SHA must be 40 lowercase hex characters' infra/deploy/ai-agent-deploy
grep -Fq 'digest must be 64 lowercase hex characters' infra/deploy/ai-agent-deploy
grep -Fq 'runtime_env=/etc/ai-agent/runtime.env' infra/deploy/ai-agent-deploy
grep -Fq 'ai-agent-runtime-preflight' infra/deploy/ai-agent-deploy
grep -Fq 'BACKEND_MIGRATION_IMAGE="$registry/backend-migration@sha256:$migration_digest"' infra/deploy/ai-agent-deploy
grep -Fq 'for service in platform web backend migrate; do' infra/deploy/ai-agent-deploy
grep -Fq 'compose pull "$service"' infra/deploy/ai-agent-deploy
if grep -Fq 'compose pull backend worker web platform migrate' infra/deploy/ai-agent-deploy; then
  echo 'release images must not be pulled concurrently on small hosts' >&2
  exit 1
fi
grep -Fq 'compose up -d --wait postgres redis geoipupdate' infra/deploy/ai-agent-deploy
grep -Fq 'running=$(compose ps --status running --services "$service")' infra/deploy/ai-agent-deploy
grep -Fq '[ "$running" = "$service" ] || die "$service is not running"' infra/deploy/ai-agent-deploy
grep -Fq 'compose up -d --wait --no-deps backend' infra/deploy/ai-agent-deploy
grep -Fq 'compose up -d --wait --no-deps worker' infra/deploy/ai-agent-deploy
grep -Fq 'compose up -d --wait --no-deps web platform' infra/deploy/ai-agent-deploy
if grep -Fq 'compose ps --status running worker >/dev/null' infra/deploy/ai-agent-deploy; then
  echo 'deployment must compare the returned running service name' >&2
  exit 1
fi
# The first-run bootstrap mints the platform's root credential, so it must
# require local host access rather than possession of the CI deploy key. The
# forced-command allowlist is what enforces that: if bootstrap-super-admin ever
# becomes remotely dispatchable, a compromised deployment secret becomes a
# platform takeover.
grep -Fq 'bootstrap-super-admin)' infra/deploy/ai-agent-deploy
# Extracted from the shipped dispatch script rather than restated here, so
# widening the real allowlist fails this test instead of passing beside it.
dispatch_allowlist=$(sed -n "/grep -Eq/s/.*grep -Eq '\([^']*\)'.*/\1/p" infra/deploy/ai-agent-deploy-dispatch)
[ -n "$dispatch_allowlist" ] || {
  echo 'could not read the forced-command allowlist from the dispatch script' >&2
  exit 1
}
for rejected in 'bootstrap-super-admin staging' 'bootstrap-super-admin production'; do
  if printf '%s\n' "$rejected" | grep -Eq "$dispatch_allowlist"; then
    echo 'super-admin bootstrap must not be reachable over the deploy key' >&2
    exit 1
  fi
done

# Key rotation reads and rewrites every stored provider credential, with the
# master key in the container's environment. It is a local-root operation for
# the same reason the bootstrap is: a compromised deployment secret must not
# reach the credential table.
grep -Fq 'rotate-managed-secret-keys)' infra/deploy/ai-agent-deploy || {
  echo 'the wrapper must expose the managed-secret rotation subcommand' >&2
  exit 1
}
for rejected in 'rotate-managed-secret-keys staging' 'rotate-managed-secret-keys production'; do
  if printf '%s\n' "$rejected" | grep -Eq "$dispatch_allowlist"; then
    echo 'managed-secret rotation must not be reachable over the deploy key' >&2
    exit 1
  fi
done
# The allowlist must still admit what it is for, or the extraction silently
# matched nothing and the loop above proves nothing.
printf '%s\n' 'status staging' | grep -Eq "$dispatch_allowlist" || {
  echo 'extracted allowlist does not admit a known-good command' >&2
  exit 1
}

# The grammar itself, pinned. Everything above reads the allowlist out of the
# shipped script, which catches a widening but moves with the script if the
# pattern is ever rewritten. RF-06 moved this file from ops/lightsail to
# infra/deploy, and a relocation must not be able to change what the CI deploy
# key can say -- so the pattern is also compared against the literal that
# shipped before the move. Editing this string is the deliberate act of changing
# the forced-command grammar, and it should be reviewed as one.
expected_allowlist='^(deploy (staging|production) [0-9a-f]{40}( [0-9a-f]{64}){4}|(status|health|rollback) (staging|production))$'
[ "$dispatch_allowlist" = "$expected_allowlist" ] || {
  echo 'the forced-command grammar changed' >&2
  echo "  expected: $expected_allowlist" >&2
  echo "  actual:   $dispatch_allowlist" >&2
  exit 1
}

# And the script's own behaviour, not only its pattern: the argument-count arms
# after the match are part of the grammar too. Run against a fake `sudo` that
# records what it was asked to run, so an accepted command proves the exact
# wrapper invocation and no privileged command is ever actually reached.
dispatch_dir=$(mktemp -d)
trap 'rm -rf "$dispatch_dir"' EXIT HUP INT TERM
dispatched=$dispatch_dir/dispatched
: >"$dispatched"
cat >"$dispatch_dir/sudo" <<SUDO
#!/bin/sh
printf '%s\n' "\$*" >>"$dispatched"
SUDO
chmod +x "$dispatch_dir/sudo"

sha=$(printf 'a%.0s' $(seq 40))
upper_sha=$(printf 'A%.0s' $(seq 40))
digest=$(printf 'b%.0s' $(seq 64))
digests="$digest $digest $digest $digest"

dispatches() {
  expected=$1
  : >"$dispatched"
  SSH_ORIGINAL_COMMAND="$2" PATH="$dispatch_dir:$PATH" \
    infra/deploy/ai-agent-deploy-dispatch >/dev/null 2>&1 || {
    echo "the dispatcher rejected a command it has always accepted: $2" >&2
    exit 1
  }
  [ "$(cat "$dispatched")" = "$expected" ] || {
    echo "the dispatcher ran something else for: $2" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $(cat "$dispatched")" >&2
    exit 1
  }
}

rejects() {
  : >"$dispatched"
  if SSH_ORIGINAL_COMMAND="$1" PATH="$dispatch_dir:$PATH" \
    infra/deploy/ai-agent-deploy-dispatch >/dev/null 2>&1; then
    echo "the dispatcher accepted a command it must refuse: $1" >&2
    exit 1
  fi
  # A refusal that still reached sudo is not a refusal.
  [ ! -s "$dispatched" ] || {
    echo "the dispatcher reached sudo while refusing: $1" >&2
    exit 1
  }
}

for environment in staging production; do
  dispatches "-n /usr/local/sbin/ai-agent-deploy deploy $environment $sha $digests" \
    "deploy $environment $sha $digests"
  for verb in status health rollback; do
    dispatches "-n /usr/local/sbin/ai-agent-deploy $verb $environment" "$verb $environment"
  done
done

rejects ''
rejects 'deploy staging'
rejects "deploy staging $sha"
rejects "deploy staging $sha $digest $digest $digest"
rejects "deploy staging $sha $digests $digest"
rejects "deploy development $sha $digests"
rejects "deploy staging ${sha}a $digests"
rejects "DEPLOY staging $sha $digests"
rejects "deploy staging $upper_sha $digests"
rejects 'status staging; id'
rejects 'status staging && id'
rejects 'status staging $(id)'
rejects 'status staging production'
rejects 'health'
rejects 'bootstrap-super-admin staging'
rejects 'rotate-managed-secret-keys staging'
rejects 'reclaim-locked staging'

# The same question asked of every verb the wrapper implements, rather than of
# the two that happened to warrant their own loop above. A third local-only verb
# would otherwise arrive with no boundary assertion at all, and whether the
# deploy key can reach it would depend on nobody having noticed.
#
# The pattern allows trailing content and digits/underscores on purpose. The
# wrapper already writes its `*)` arm on one line, so a future verb written in
# that same style -- `  dump-secrets) do_thing "$@" ;;` -- is idiomatic here,
# and an extraction anchored to end-of-line would silently drop it. That is
# precisely the verb this sweep exists to catch, so it would fail open.
wrapper_verbs=$(sed -n 's/^  \([a-z0-9][a-z0-9|_-]*\)).*$/\1/p' infra/deploy/ai-agent-deploy |
  tr '|' '\n' | sort -u)
[ -n "$wrapper_verbs" ] ||
  { echo 'could not read the verbs the deploy wrapper implements' >&2; exit 1; }
# The extraction is load-bearing, so it is checked against verbs known to exist.
for required in deploy rollback status health bootstrap-super-admin \
  rotate-managed-secret-keys; do
  printf '%s\n' "$wrapper_verbs" | grep -Fxq "$required" ||
    { echo "the wrapper verb sweep does not cover $required" >&2; exit 1; }
done
for verb in $wrapper_verbs; do
  case $verb in deploy | status | health | rollback) continue ;; esac
  for environment in staging production; do
    if printf '%s\n' "$verb $environment" | grep -Eq "$dispatch_allowlist"; then
      echo "the CI deploy key must not reach the $verb verb" >&2
      exit 1
    fi
  done
done

# Retention runs on the deployment's own lock. `reclaim` would open the lock file
# again, get a distinct open file description, and be refused by the deployment
# that is calling it -- every time, silently, so retention would simply never
# run. `reclaim-locked` re-locks the inherited description instead.
grep -Fq '"$retention" reclaim-locked' infra/deploy/ai-agent-deploy ||
  { echo 'the wrapper must invoke retention through the inherited-lock entry point' >&2; exit 1; }
if grep -Eq '\$retention"? +reclaim( |$)' infra/deploy/ai-agent-deploy; then
  echo 'the wrapper must not invoke the standalone retention entry point; it already holds the lock' >&2
  exit 1
fi
# Retention must not be asked to take the deployment's word for it: the inherited
# descriptor is the lock, and a variable saying it is held would only be a claim.
# Asserted from retention's side, where it is a property rather than a pattern --
# infra/tests/release-retention.sh requires that the script expand no environment
# variable at all, which leaves the wrapper nothing it could assert through.

grep -Fq 'CURRENT_RELEASE.json' infra/deploy/ai-agent-deploy
grep -Fq 'PREVIOUS_RELEASE.json' infra/deploy/ai-agent-deploy
if grep -Eq 'ghcr\.io/.+:\$sha' infra/deploy/ai-agent-deploy; then
  echo 'deployment must not resolve a mutable SHA tag' >&2
  exit 1
fi
grep -Fq 'storage: '\''database'\''' apps/control-plane/src/infrastructure/auth/auth.factory.ts

# Everything an operator runs as root, gathered once and swept twice below.
#
# One list rather than a root list per sweep, because the two drifted apart
# every time the tree moved. RF-06 took the deploy wrapper and the forced
# -command dispatcher out of ops/lightsail -- the dispatcher being the one
# script that must never `eval` what the SSH key sent it -- and RF-07 took the
# gateway and backup scripts out of ops/ altogether. Each time a sweep naming
# the old directory went on passing while covering less.
#
# Not restricted to `*.sh`: the renewal hook and the dispatcher carry no
# extension, and a systemd unit runs a command as root as surely as a script
# does. Only `.md` is excluded, because the runbooks name these commands
# precisely to tell operators not to use them. Fragments are split so this file
# does not contain the literals either.
host_scripts=$(find ops infra/deploy infra/gateway infra/backup \
  -type f ! -name '*.md' | sort)
[ -n "$host_scripts" ] || {
  echo 'found no host scripts to check' >&2
  exit 1
}
# The sweeps must actually include the files that could do the damage, or they
# are checking nothing. Named one per root, so a root that falls out of the
# list above fails here instead of passing with less to check.
for required in infra/deploy/release-retention.sh infra/deploy/ai-agent-deploy \
  infra/deploy/ai-agent-deploy-dispatch infra/backup/restore-drill.sh \
  infra/backup/backup-postgres.sh infra/backup/ai-agent-postgres-backup.service \
  infra/gateway/nginx/install-nginx.sh infra/gateway/nginx/reload-nginx-after-renewal \
  ops/lightsail/README.md; do
  case $required in
    *.md)
      # The one exclusion, asserted so that widening it later is deliberate.
      printf '%s\n' "$host_scripts" | grep -Fxq "$required" && {
        echo "the sweep list must not include documentation: $required" >&2
        exit 1
      }
      continue
      ;;
  esac
  printf '%s\n' "$host_scripts" | grep -Fxq "$required" || {
    echo "the host script sweep does not cover $required" >&2
    exit 1
  }
done

for forbidden in 'down'' -v' 'volume'' prune' 'system'' prune.*--volumes' 'eval .*SSH_ORIGINAL_COMMAND'; do
  # shellcheck disable=SC2086
  if printf '%s\n' "$host_scripts" | xargs grep -En "$forbidden"; then
    echo 'destructive or evaluative deployment command found' >&2
    exit 1
  fi
done

# The patterns below are deliberately wider than the ones above, which only
# caught a system reclaim carrying --volumes. A bare system reclaim, an -a
# system reclaim, and an -a image reclaim all passed until they were added.
# None of them can distinguish a rollback target from garbage, and rollback
# capability is exactly what release retention exists to protect.

for reclaim in \
  'system'' prune' \
  'image'' prune' \
  'volume'' prune' \
  'container'' prune' \
  'builder'' prune' \
  'buildx'' prune'; do
  if printf '%s\n' "$host_scripts" | xargs grep -En "docker[[:space:]]+$reclaim"; then
    echo 'a blanket Docker reclaim cannot distinguish a rollback target from garbage' >&2
    exit 1
  fi
done

# Forced image removal defeats the container check that makes retention safe.
if printf '%s\n' "$host_scripts" | xargs grep -En 'image rm[^|]*(--force|[[:space:]]-f([[:space:]]|$))'; then
  echo 'forced image removal is never permitted' >&2
  exit 1
fi

echo 'Lightsail deployment boundary: ok'
