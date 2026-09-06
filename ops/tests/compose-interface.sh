#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

wrapper=infra/scripts/compose.sh
compose_file=$root/infra/compose/compose.yaml

test -x "$wrapper" || {
  echo "compose wrapper is missing or not executable: $wrapper" >&2
  exit 1
}

# Nothing outside the wrapper may reach the compose file by relative path. The
# three workspace scripts that used to do it were correct only from two levels
# down, which is the fragility this interface exists to remove.
#
# `--` is deliberately absent before the pattern: it ends option parsing, so
# the --include filters become file operands that do not exist, grep exits 2,
# and the guard silently never fires however many callers are added. Two files
# legitimately name the path and are excluded by name: the wrapper, which owns
# it, and this test, which needs a direct invocation as its equivalence
# baseline.
offenders=$(grep -rn -e '\.\./\.\./\(docker-compose\.yml\|infra/compose/compose\.yaml\)' \
  --include '*.json' --include '*.sh' --include '*.md' \
  --exclude-dir node_modules --exclude-dir .git . |
  grep -v '^\./ops/tests/compose-interface\.sh:' |
  grep -v '^\./infra/scripts/compose\.sh:' || true)
if [ -n "$offenders" ]; then
  echo 'a caller still reaches the compose file by relative path' >&2
  echo "$offenders" >&2
  exit 1
fi

# A caller that names no file at all is the other half of the same rule, and
# the one that survives a search for the path: `docker compose ...` used to
# work by falling back to a compose file in the repository root. There is none
# now, so it fails at run time with "no configuration file provided" instead.
# Only lines that name a file explicitly with -f/--file are allowed, which is
# what the equivalence baselines below do. Host tooling addressing the
# installed /opt/ai-agent copy is out of scope and is not searched.
bare=$(grep -rn 'docker compose' \
  --include '*.yml' --include '*.yaml' --include '*.sh' --include '*.json' \
  --exclude-dir node_modules \
  .github/workflows ops/tests package.json apps/backend/package.json |
  grep -v -e '-f ' -e '--file' |
  grep -v '^ops/tests/compose-interface\.sh:' || true)
if [ -n "$bare" ]; then
  echo 'a repository caller invokes Compose without naming a file; use the wrapper' >&2
  echo "$bare" >&2
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
  echo 'Docker Compose unavailable: compose interface render checks skipped'
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
unset_names=$(grep -oE '\$\{[A-Z][A-Z0-9_]*' infra/compose/compose.yaml | sed 's/^\${//' | sort -u)
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
  (cd apps/backend && env $unset_fixture docker compose -f ../../infra/compose/compose.yaml \
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
(cd apps/backend && env $unset_fixture docker compose -f ../../infra/compose/compose.yaml \
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
  legacy_hash=$(cd apps/backend && env $unset_fixture docker compose -f ../../infra/compose/compose.yaml \
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

# Everything below asserts a refusal. The wrapper is a way around the agent
# safety hook, which recognises the destructive teardown only when it is
# spelled as a docker command, and a way around the file and project identity
# this interface exists to own. Both long forms take `--flag=value` as well as
# a separate argument, so both spellings are covered: matching only the bare
# flag would leave the `=` spelling working.
# Everything from here to the equivalence checks exercises the argument guards,
# and a guard that has regressed would otherwise let the command through to the
# real daemon — which for the teardown cases means actually removing this
# machine's volumes. A safety test must not be the thing that destroys the data.
#
# So the guard cases run against a fake `docker` that records what it was asked
# to do and does nothing. A missing guard then fails the test because the fake
# was reached, and no real container, image, network, or volume is touched.
# Real Docker is used only for the read-only renders further down.
fake_bin=$tmp_dir/fake-bin
invocations=$tmp_dir/docker-invocations
mkdir -p "$fake_bin"
: >"$invocations"

cat >"$fake_bin/docker" <<FAKE
#!/bin/sh
# The wrapper probes for Compose before doing anything; that probe is not an
# invocation worth recording.
case "\$*" in
  'compose version') exit 0 ;;
esac
printf '%s\n' "\$*" >>"$invocations"
exit 0
FAKE
chmod +x "$fake_bin/docker"

# The fake has to be convincing enough that reaching it proves the guard failed
# rather than the harness.
PATH="$fake_bin:$PATH" "$wrapper" config >/dev/null 2>&1 || {
  echo 'the fake docker harness is not usable' >&2
  exit 1
}
test -s "$invocations" || {
  echo 'the fake docker harness records nothing, so it cannot prove a guard failed' >&2
  exit 1
}

# A file that renders cleanly on its own. Without it, a `--file` refusal could
# pass because Compose could not read the substitute rather than because the
# interface turned it down.
cat >"$tmp_dir/other.yml" <<'OTHER'
name: substituted-project
services:
  substituted:
    image: busybox
OTHER

refuses() {
  description=$1
  shift

  : >"$invocations"

  if PATH="$fake_bin:$PATH" "$wrapper" "$@" >/dev/null 2>&1; then
    echo "the compose interface accepted $description: $*" >&2
    exit 1
  fi

  # The exit status alone is not enough: a refusal must happen before Compose
  # is reached, not be inferred from Compose failing afterwards.
  test ! -s "$invocations" || {
    echo "the compose interface reached docker for $description: $*" >&2
    exit 1
  }
}

# Not refused, and actually forwarded — the pinned file and project name must
# still be on the command the wrapper builds.
forwards() {
  description=$1
  shift

  : >"$invocations"
  PATH="$fake_bin:$PATH" "$wrapper" "$@" >"$tmp_dir/forwarded.out" 2>&1 || true

  if grep -q '^refusing ' "$tmp_dir/forwarded.out"; then
    echo "the compose interface refused its own documented command: $description ($*)" >&2
    exit 1
  fi

  grep -Fq -- "--file $compose_file --project-name ai-agent" "$invocations" || {
    echo "the compose interface did not forward the pinned file and project for: $description" >&2
    exit 1
  }
}

teardown=down
refuses 'a volume-removing teardown' "$teardown" -v
refuses 'a volume-removing teardown' "$teardown" -v=true
refuses 'a volume-removing teardown' "$teardown" --volume
refuses 'a volume-removing teardown' "$teardown" --volume=true
refuses 'a volume-removing teardown' "$teardown" --volumes
refuses 'a volume-removing teardown' "$teardown" --volumes=true
refuses 'an image-removing teardown' "$teardown" --rmi all
refuses 'an image-removing teardown' "$teardown" --rmi=all
refuses 'an image-removing teardown' "$teardown" --rmi=local

refuses 'a project rename' --project-name other config
refuses 'a project rename' --project-name=other config
refuses 'a project rename' -p other config
refuses 'a project rename' -pother config
refuses 'a substituted compose file' --file "$tmp_dir/other.yml" config
refuses 'a substituted compose file' --file="$tmp_dir/other.yml" config
refuses 'a substituted compose file' -f "$tmp_dir/other.yml" config
refuses 'a relocated project directory' --project-directory "$tmp_dir" config
refuses 'a relocated project directory' --project-directory="$tmp_dir" config

refuses 'an empty argument list'

# The guards are position-sensitive, and asserting only the text of the manifest
# entries missed that once: `-f` before the subcommand selects the compose file,
# but the documented `db:logs` spells `logs -f` for follow, and refusing it
# everywhere broke that command. Run the three documented shapes for real —
# against the fake docker, so `up` starts nothing and `logs` cannot follow.
forwards 'db:up' --profile development up -d postgres redis
forwards 'db:down' --profile development down
forwards 'db:logs' --profile development logs -f postgres redis

# The shapes above have to be the ones the manifest actually ships.
for manifest_shape in 'compose.sh --profile development up -d postgres redis' \
  'compose.sh --profile development down' \
  'compose.sh --profile development logs -f postgres redis'; do
  grep -Fq "$manifest_shape" package.json || {
    echo "a tested shape is no longer the one in package.json: $manifest_shape" >&2
    exit 1
  }
done

# The refusals must not have cost the ordinary flags their meaning.
# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$fixture" --profile development config \
  >"$tmp_dir/still-works.yml"
grep -Eq '^name: ai-agent$' "$tmp_dir/still-works.yml" || {
  echo 'the refusals broke an ordinary invocation' >&2
  exit 1
}

echo 'compose interface checks passed'
