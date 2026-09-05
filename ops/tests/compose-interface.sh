#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

wrapper=infra/scripts/compose.sh

test -x "$wrapper" || {
  echo "compose wrapper is missing or not executable: $wrapper" >&2
  exit 1
}

# Nothing outside the wrapper may name the compose file. The three workspace
# scripts that used to do it were correct only from two levels down, which is
# the fragility this interface exists to remove.
if grep -rn -- '-f \.\./\.\./docker-compose\.yml' \
  --include '*.json' --include '*.sh' --include '*.md' \
  --exclude-dir node_modules --exclude-dir .git . >/dev/null 2>&1; then
  echo 'a caller still reaches the compose file by relative path' >&2
  exit 1
fi

# The root manifest is the interface: the documented commands go through the
# wrapper, and the backend workspace delegates rather than keeping a second
# copy of the invocation.
for script in '"db:up": "infra/scripts/compose.sh --profile development up -d postgres redis"' \
  '"db:down": "infra/scripts/compose.sh --profile development down"' \
  '"db:logs": "infra/scripts/compose.sh --profile development logs -f postgres redis"'; do
  grep -Fq "$script" package.json || {
    echo "root package.json must define: $script" >&2
    exit 1
  }
done

for script in '"db:up": "pnpm -w run db:up"' \
  '"db:down": "pnpm -w run db:down"' \
  '"db:logs": "pnpm -w run db:logs"'; do
  grep -Fq "$script" apps/backend/package.json || {
    echo "backend package.json must delegate: $script" >&2
    exit 1
  }
done

# The teardown the developer commands use must stay the non-destructive one.
grep -Fq '"db:down": "infra/scripts/compose.sh --profile development down"' package.json

command -v docker >/dev/null 2>&1 || {
  echo 'docker unavailable: compose interface render checks skipped'
  exit 0
}
docker compose version >/dev/null 2>&1 || {
  echo 'docker compose unavailable: compose interface render checks skipped'
  exit 0
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

# Fake values, and only the ones the development and test profiles interpolate.
# Nothing here reaches a real environment or a real credential.
fixture=$tmp_dir/fixture.env
cat >"$fixture" <<'ENV'
POSTGRES_USER=app
POSTGRES_PASSWORD=test-only-database-password
POSTGRES_DB=app
POSTGRES_TEST_USER=backend_test_user
POSTGRES_TEST_PASSWORD=test-only-database-password
POSTGRES_TEST_DB=backend_test
ENV

# Compose lets the ambient environment win over `--env-file`, so a developer or
# runner that exports any interpolated name would otherwise turn this into an
# assertion about their shell.
unset_names=$(grep -oE '\$\{[A-Z][A-Z0-9_]*' docker-compose.yml | sed 's/^\${//' | sort -u)
unset_fixture=''
for unset_name in $unset_names; do
  unset_fixture="$unset_fixture -u $unset_name"
done

profiles='--profile development --profile test --profile staging --profile production --profile migration'

# The comparison that matters: the previous invocation, spelled exactly as the
# backend workspace spelled it and run from where it ran, against the same
# request through the wrapper. Equal output is what makes the wrapper a
# relocation of the call and not a change to the topology.
#
# One profile at a time as well as all of them together: a wrapper that
# silently added a profile would render identically once every profile is
# already requested, and differently for a single one.
#
# `migration` is not in this list on its own: the migrate service depends on
# postgres, which only a deployment profile brings in, so it renders only in
# the pairing CI already validates.
selection=0
for selected_profiles in '--profile development' '--profile test' \
  '--profile staging' '--profile production' '--profile staging --profile migration'; do
  selection=$((selection + 1))
  before=$tmp_dir/before-$selection.yml
  after=$tmp_dir/after-$selection.yml

  # shellcheck disable=SC2086
  (cd apps/backend && env $unset_fixture docker compose -f ../../docker-compose.yml \
    --env-file "$fixture" $selected_profiles config) >"$before"

  # shellcheck disable=SC2086
  env $unset_fixture "$wrapper" --env-file "$fixture" $selected_profiles config >"$after"

  # An empty render means both sides failed identically, which would compare
  # equal and prove nothing.
  test -s "$before" || {
    echo "no configuration rendered for: $selected_profiles" >&2
    exit 1
  }

  if ! diff -u "$before" "$after" >"$tmp_dir/render-$selection.diff"; then
    echo "the compose interface renders a different configuration for: $selected_profiles" >&2
    cat "$tmp_dir/render-$selection.diff" >&2
    exit 1
  fi
done

# shellcheck disable=SC2086
(cd apps/backend && env $unset_fixture docker compose -f ../../docker-compose.yml \
  --env-file "$fixture" $profiles config) >"$tmp_dir/before.yml"

# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$fixture" $profiles config >"$tmp_dir/after.yml"

if ! diff -u "$tmp_dir/before.yml" "$tmp_dir/after.yml" >"$tmp_dir/render.diff"; then
  echo 'the compose interface renders a different configuration than the call it replaces' >&2
  cat "$tmp_dir/render.diff" >&2
  exit 1
fi

# Compose decides whether to recreate a running container by comparing this
# hash. Equal rendered output already implies equal hashes, but this is the
# value the daemon actually compares, and an unequal one would mean the change
# recreates every developer's containers on their next command.
for service in postgres redis; do
  # shellcheck disable=SC2086
  legacy_hash=$(cd apps/backend && env $unset_fixture docker compose -f ../../docker-compose.yml \
    --env-file "$fixture" --profile development config --hash="$service")
  # shellcheck disable=SC2086
  wrapper_hash=$(env $unset_fixture "$wrapper" \
    --env-file "$fixture" --profile development config --hash="$service")

  test "$legacy_hash" = "$wrapper_hash" || {
    echo "service config hash changed for $service, so containers would be recreated" >&2
    echo "  before: $legacy_hash" >&2
    echo "  after:  $wrapper_hash" >&2
    exit 1
  }
done

# Resolving the repository root from the script's own location, rather than
# from the caller's, is the point of the wrapper. Prove it from a directory
# that is not the repository.
# shellcheck disable=SC2086
(cd / && env $unset_fixture "$root/$wrapper" --env-file "$fixture" $profiles config) >"$tmp_dir/elsewhere.yml"

diff -q "$tmp_dir/after.yml" "$tmp_dir/elsewhere.yml" >/dev/null || {
  echo 'the compose interface depends on the current working directory' >&2
  exit 1
}

# Identity that must survive RF-04 moving the file.
grep -Eq '^name: ai-agent$' "$tmp_dir/after.yml" || {
  echo 'compose project name is no longer ai-agent' >&2
  exit 1
}

for service in backend geoipupdate migrate platform postgres postgres-test redis redis-test web worker; do
  grep -Eq "^  ${service}:$" "$tmp_dir/after.yml" || {
    echo "service disappeared from the rendered configuration: $service" >&2
    exit 1
  }
done

for named_volume in geoip_data postgres_data redis_data; do
  grep -Eq "^    name: ai-agent_${named_volume}$" "$tmp_dir/after.yml" || {
    echo "named volume identity changed: $named_volume" >&2
    exit 1
  }
done

for network in data edge; do
  grep -Eq "^    name: ai-agent_${network}$" "$tmp_dir/after.yml" || {
    echo "network identity changed: $network" >&2
    exit 1
  }
done

# A wrapper is a way around the safety hook, which only recognises the
# destructive teardown when it is spelled as a docker command. It has to refuse
# on its own.
for destructive_flag in --volumes --rmi; do
  if "$wrapper" down "$destructive_flag" >/dev/null 2>&1; then
    echo "the compose interface accepted a destructive teardown: $destructive_flag" >&2
    exit 1
  fi
done

if "$wrapper" >/dev/null 2>&1; then
  echo 'the compose interface accepted an empty argument list' >&2
  exit 1
fi

echo 'compose interface checks passed'
