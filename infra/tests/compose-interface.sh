#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

wrapper=infra/scripts/compose.sh
compose_dir=$root/infra/compose
compose_file=$compose_dir/compose.yaml
dev_overlay=$compose_dir/compose.dev.yaml
test_overlay=$compose_dir/compose.test.yaml
deploy_overlay=$compose_dir/compose.deploy.yaml

test -x "$wrapper" || {
  echo "compose wrapper is missing or not executable: $wrapper" >&2
  exit 1
}

for required in "$compose_file" "$dev_overlay" "$test_overlay" "$deploy_overlay"; do
  test -f "$required" || {
    echo "compose model is incomplete: $required" >&2
    exit 1
  }
done

# Nothing outside the wrapper may reach a compose file by relative path. The
# three workspace scripts that used to do it were correct only from two levels
# down, which is the fragility this interface exists to remove.
#
# `--` is deliberately absent before the pattern: it ends option parsing, so
# the --include filters become file operands that do not exist, grep exits 2,
# and the guard silently never fires however many callers are added. Two files
# legitimately name the path and are excluded by name: the wrapper, which owns
# it, and this test, which needs a direct invocation as its equivalence
# baseline.
offenders=$(grep -rn -e '\.\./\.\./\(docker-compose\.yml\|infra/compose/compose[a-z.]*\.yaml\)' \
  --include '*.json' --include '*.sh' --include '*.md' \
  --exclude-dir node_modules --exclude-dir .git . |
  grep -v '^\./infra/tests/compose-interface\.sh:' |
  grep -v '^\./infra/scripts/compose\.sh:' || true)
if [ -n "$offenders" ]; then
  echo 'a caller still reaches a compose file by relative path' >&2
  echo "$offenders" >&2
  exit 1
fi

# A caller that names no file at all is the other half of the same rule, and
# the one that survives a search for the path: `docker compose ...` used to
# work by falling back to a compose file in the repository root. There is none
# now, so it fails at run time with "no configuration file provided" instead.
# Only lines that name a file explicitly with -f/--file are allowed, which is
# what the equivalence baselines below do. Host tooling addressing the
# installed /opt/ai-agent copies is out of scope and is not searched.
bare=$(grep -rn 'docker compose' \
  --include '*.yml' --include '*.yaml' --include '*.sh' --include '*.json' \
  --exclude-dir node_modules \
  .github/workflows infra/tests package.json apps/control-plane/package.json |
  grep -v -e '-f ' -e '--file' |
  grep -v '^infra/tests/compose-interface\.sh:' || true)
if [ -n "$bare" ]; then
  echo 'a repository caller invokes Compose without naming a file; use the wrapper' >&2
  echo "$bare" >&2
  exit 1
fi

# The root manifest is the interface: the documented commands go through the
# wrapper, and the backend workspace delegates rather than keeping a second
# copy of the invocation. Splitting the model into overlays deliberately left
# these three untouched — a developer's commands are the thing the wrapper
# exists to keep still.
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
  grep -Fq "$script" apps/control-plane/package.json || {
    echo "backend package.json must delegate: $script" >&2
    exit 1
  }
done

# The teardown the developer commands use must stay the non-destructive one.
grep -Fq '"db:down": "infra/scripts/compose.sh --profile development down"' package.json

# The development credential fallbacks belong to the development overlay and to
# nothing else. Asserted on the source as well as on the render below, because
# the render only proves what today's file says and this says where the setting
# is allowed to live at all.
for defaulted in 'POSTGRES_USER:-postgres' 'POSTGRES_PASSWORD:-postgres' 'POSTGRES_DB:-postgres'; do
  grep -Fq "$defaulted" "$dev_overlay" || {
    echo "the development overlay no longer carries the local default: $defaulted" >&2
    exit 1
  }
  for other in "$compose_file" "$test_overlay" "$deploy_overlay"; do
    if grep -Fq "$defaulted" "$other"; then
      echo "a development credential default leaked into $other: $defaulted" >&2
      exit 1
    fi
  done
done

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

# Fake values, and only the ones the development and test compositions
# interpolate. Nothing here reaches a real environment or a real credential.
fixture=$tmp_dir/fixture.env
cat >"$fixture" <<'ENV'
POSTGRES_USER=app
POSTGRES_PASSWORD=test-only-database-password
POSTGRES_DB=app
POSTGRES_TEST_USER=backend_test_user
POSTGRES_TEST_PASSWORD=test-only-database-password
POSTGRES_TEST_DB=backend_test
ENV

# Deliberately empty. The leak check below has to render with every interpolated
# name absent, because a fixture that supplies POSTGRES_PASSWORD is exactly the
# case in which a dangerous fallback stays invisible.
empty_env=$tmp_dir/empty.env
: >"$empty_env"

# Compose lets the ambient environment win over `--env-file`, so a developer or
# runner that exports any interpolated name would otherwise turn this into an
# assertion about their shell. Taken across the whole model, not just the base
# file: the deploy overlay interpolates most of them.
unset_names=$(grep -hoE '\$\{[A-Z][A-Z0-9_]*' "$compose_file" "$dev_overlay" \
  "$test_overlay" "$deploy_overlay" | sed 's/^\${//' | sort -u)
unset_fixture=''
for unset_name in $unset_names; do
  unset_fixture="$unset_fixture -u $unset_name"
done

# The comparison that matters now that there is more than one file: the
# composition the wrapper assembles against the same two files named
# explicitly, with the project the wrapper derives. Equal output is what makes
# the wrapper a spelling of the call and not a change to the topology.
#
# One profile at a time as well as the deployment pairing: a wrapper that
# silently added a profile would render identically once every profile is
# already requested, and differently for a single one.
selection=0
check_render() {
  selected_profiles=$1
  expected_project=$2
  expected_overlay=$3

  selection=$((selection + 1))
  before=$tmp_dir/before-$selection.yml
  after=$tmp_dir/after-$selection.yml

  # shellcheck disable=SC2086
  env $unset_fixture docker compose --file "$compose_file" --file "$expected_overlay" \
    --project-name "$expected_project" --env-file "$fixture" $selected_profiles config >"$before"

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
}

check_render '--profile development' ai-agent "$dev_overlay"
check_render '--profile test' ai-agent-test "$test_overlay"
check_render '--profile staging' ai-agent "$deploy_overlay"
check_render '--profile production' ai-agent "$deploy_overlay"
check_render '--profile staging --profile migration' ai-agent "$deploy_overlay"

# The three renders every later assertion reads.
# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$fixture" --profile development config >"$tmp_dir/dev.yml"
# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$fixture" --profile test config >"$tmp_dir/test.yml"
# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$fixture" --profile staging --profile migration config \
  >"$tmp_dir/deploy.yml"

# Compose decides whether to recreate a running container by comparing this
# hash. Splitting the model must not change it for the two services a developer
# already has running, or the next `pnpm db:up` recreates them — which for
# postgres means a container swap under a live local database.
for service in postgres redis; do
  # shellcheck disable=SC2086
  split_hash=$(env $unset_fixture "$wrapper" \
    --env-file "$fixture" --profile development config --hash="$service")
  # shellcheck disable=SC2086
  explicit_hash=$(env $unset_fixture docker compose --file "$compose_file" --file "$dev_overlay" \
    --project-name ai-agent --env-file "$fixture" --profile development config --hash="$service")

  test "$split_hash" = "$explicit_hash" || {
    echo "service config hash changed for $service, so containers would be recreated" >&2
    echo "  wrapper:  $split_hash" >&2
    echo "  explicit: $explicit_hash" >&2
    exit 1
  }
done

# Resolving the repository root from the script's own location, rather than
# from the caller's, is the point of the wrapper. Prove it from a directory
# that is not the repository.
# shellcheck disable=SC2086
(cd / && env $unset_fixture "$root/$wrapper" --env-file "$fixture" \
  --profile development config) >"$tmp_dir/elsewhere.yml"

diff -q "$tmp_dir/dev.yml" "$tmp_dir/elsewhere.yml" >/dev/null || {
  echo 'the compose interface depends on the current working directory' >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Which composition each profile selects
# ---------------------------------------------------------------------------

services_in() {
  grep -E '^  [a-z][a-z0-9-]*:$' "$1" | sed -e 's/^  //' -e 's/:$//' | sort
}

dev_services=$(services_in "$tmp_dir/dev.yml")
test_services=$(services_in "$tmp_dir/test.yml")
deploy_services=$(services_in "$tmp_dir/deploy.yml")

expect_services() {
  description=$1
  actual=$2
  expected=$3

  test "$actual" = "$expected" || {
    echo "the $description composition renders the wrong services" >&2
    echo "  expected: $(printf '%s' "$expected" | tr '\n' ' ')" >&2
    echo "  actual:   $(printf '%s' "$actual" | tr '\n' ' ')" >&2
    exit 1
  }
}

# `data` and `edge` are the network keys, which sit at the same indentation in
# the rendered document; they are part of the expected list rather than
# filtered out, so a network disappearing is caught here too.
expect_services development "$dev_services" 'data
edge
postgres
redis'
expect_services test "$test_services" 'data
edge
postgres-test
redis-test'
expect_services deployment "$deploy_services" 'backend
data
edge
geoipupdate
migrate
platform
postgres
redis
tmpfs
web
worker'

# ---------------------------------------------------------------------------
# Test isolation: no identity a CI run creates may collide with a developer's
# ---------------------------------------------------------------------------

# The wrapper passes `--project-name`, which wins over the `name:` in the files,
# so a render cannot tell whether the two still agree — and the file's value is
# what someone running Compose against these files by hand would get. Asserted
# against the sources as well as against the render below.
grep -Eq '^name: ai-agent$' "$compose_file" || {
  echo 'the shared compose file no longer declares the ai-agent project' >&2
  exit 1
}
grep -Eq '^name: ai-agent-test$' "$test_overlay" || {
  echo 'the test overlay no longer declares its own project, so a direct docker compose call would land in ai-agent' >&2
  exit 1
}
for overlay in "$dev_overlay" "$deploy_overlay"; do
  if grep -Eq '^name: ' "$overlay"; then
    echo "an overlay renames the project it merges into: $overlay" >&2
    exit 1
  fi
done

project_of() {
  sed -n 's/^name: //p' "$1"
}

dev_project=$(project_of "$tmp_dir/dev.yml")
test_project=$(project_of "$tmp_dir/test.yml")
deploy_project=$(project_of "$tmp_dir/deploy.yml")

test "$dev_project" = ai-agent || {
  echo "development project name is no longer ai-agent: $dev_project" >&2
  exit 1
}
test "$deploy_project" = ai-agent || {
  echo "deployment project name is no longer ai-agent: $deploy_project" >&2
  exit 1
}
test "$test_project" != "$dev_project" || {
  echo 'the test composition shares a project with development, so it shares every name derived from it' >&2
  exit 1
}

# Container names are `<project>-<service>-<index>`, so distinct projects and
# distinct service names are together what make a collision impossible. Both
# are asserted, because either one alone can be undone without the other
# looking wrong.
for test_service in $test_services; do
  case "$test_service" in data | edge) continue ;; esac
  printf '%s\n' "$dev_services" | grep -Fxq "$test_service" && {
    echo "a test service shares its name with a development service: $test_service" >&2
    exit 1
  }
done

# Network and volume names are `<project>_<key>`, and those are the identities
# that would let a CI run join a developer's network or write to their data.
# Asserted as whole values against the development project's, not merely as
# "the test render mentions ai-agent-test": the failure to catch is a name that
# still carries the bare `ai-agent` prefix.
collisions=$(grep -E '^    name: ' "$tmp_dir/test.yml" | sed 's/^    name: //' |
  grep -E '^ai-agent_' || true)
if [ -n "$collisions" ]; then
  echo 'the test composition renders a development identity' >&2
  echo "$collisions" >&2
  exit 1
fi

for developer_volume in ai-agent_postgres_data ai-agent_redis_data; do
  if grep -Fq "name: $developer_volume" "$tmp_dir/test.yml"; then
    echo "the test composition can reach a development volume: $developer_volume" >&2
    exit 1
  fi
done

for named_volume in postgres_data redis_data; do
  grep -Eq "^    name: ai-agent_${named_volume}$" "$tmp_dir/dev.yml" || {
    echo "development named volume identity changed: $named_volume" >&2
    exit 1
  }
done
grep -Eq '^    name: ai-agent_geoip_data$' "$tmp_dir/deploy.yml" || {
  echo 'deployment named volume identity changed: geoip_data' >&2
  exit 1
}

for network in data edge; do
  grep -Eq "^    name: ai-agent_${network}$" "$tmp_dir/dev.yml" || {
    echo "development network identity changed: $network" >&2
    exit 1
  }
  grep -Eq "^    name: ai-agent_${network}$" "$tmp_dir/deploy.yml" || {
    echo "deployment network identity changed: $network" >&2
    exit 1
  }
done

# The ports the backend test suite connects to are a fixed contract; splitting
# the model was not allowed to move them.
grep -Fq 'published: "5433"' "$tmp_dir/test.yml" || {
  echo 'the test database no longer publishes 5433' >&2
  exit 1
}
grep -Fq 'published: "6378"' "$tmp_dir/test.yml" || {
  echo 'the test redis no longer publishes 6378' >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Nothing local reaches a deployment
# ---------------------------------------------------------------------------

# Rendered with every interpolated name absent, which is the only state in
# which a fallback is visible. Before the split this rendered the published
# default `postgres` for all three, one profile flag away from a host.
# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$empty_env" --profile staging config \
  >"$tmp_dir/deploy-bare.yml"
# shellcheck disable=SC2086
env $unset_fixture "$wrapper" --env-file "$empty_env" --profile development config \
  >"$tmp_dir/dev-bare.yml"

for credential in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  grep -Eq "^      $credential: \"\"$" "$tmp_dir/deploy-bare.yml" || {
    echo "the deployment composition supplies a default for $credential" >&2
    grep -E "^      $credential:" "$tmp_dir/deploy-bare.yml" >&2 || true
    exit 1
  }
  # The other direction: the local default has to still be there, or `pnpm
  # db:up` on a fresh checkout stops working and this check passes for the
  # wrong reason.
  grep -Eq "^      $credential: postgres$" "$tmp_dir/dev-bare.yml" || {
    echo "the development composition lost its local default for $credential" >&2
    exit 1
  }
done

if grep -Eq '^  [a-z0-9-]*-test:$' "$tmp_dir/deploy.yml"; then
  echo 'a test service renders in the deployment composition' >&2
  exit 1
fi
if grep -Fq backend_test "$tmp_dir/deploy.yml"; then
  echo 'a test credential renders in the deployment composition' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------

# Everything below asserts a refusal. The wrapper is a way around the agent
# safety hook, which recognises the destructive teardown only when it is
# spelled as a docker command, and a way around the file and project identity
# this interface exists to own. Both long forms take `--flag=value` as well as
# a separate argument, so both spellings are covered: matching only the bare
# flag would leave the `=` spelling working.
# Everything from here to the end exercises the argument guards, and a guard
# that has regressed would otherwise let the command through to the real
# daemon — which for the teardown cases means actually removing this machine's
# volumes. A safety test must not be the thing that destroys the data.
#
# So the guard cases run against a fake `docker` that records what it was asked
# to do and does nothing. A missing guard then fails the test because the fake
# was reached, and no real container, image, network, or volume is touched.
# Real Docker was used only for the read-only renders above.
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

# Not refused, and actually forwarded — the pinned files and project name must
# still be on the command the wrapper builds.
forwards() {
  description=$1
  expected=$2
  shift 2

  : >"$invocations"
  PATH="$fake_bin:$PATH" "$wrapper" "$@" >"$tmp_dir/forwarded.out" 2>&1 || true

  if grep -q '^refusing ' "$tmp_dir/forwarded.out"; then
    echo "the compose interface refused its own documented command: $description ($*)" >&2
    exit 1
  fi

  grep -Fq -- "$expected" "$invocations" || {
    echo "the compose interface did not forward the pinned files and project for: $description" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $(cat "$invocations")" >&2
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

# Selecting the composition is the wrapper's job, so a request that spans two
# of them has no answer. Merging them is the specific outcome to prevent: it
# would put the throwaway databases and the developer's own into one project.
refuses 'development mixed with test' --profile development --profile test config
refuses 'development mixed with test, in the other order' --profile test --profile development config
refuses 'test mixed with a deployment' --profile test --profile staging config
refuses 'development mixed with a deployment' --profile development --profile production config
refuses 'test mixed with a deployment, spelled with =' --profile=test --profile=staging config

# An unrecognised profile must not fall through to the development composition
# and start development containers.
refuses 'an unknown profile' --profile observability config
refuses 'an unknown profile, spelled with =' --profile=observability config

pinned_dev="--file $compose_file --file $dev_overlay --project-name ai-agent"
pinned_test="--file $compose_file --file $test_overlay --project-name ai-agent-test"
pinned_deploy="--file $compose_file --file $deploy_overlay --project-name ai-agent"

# The guards are position-sensitive, and asserting only the text of the manifest
# entries missed that once: `-f` before the subcommand selects the compose file,
# but the documented `db:logs` spells `logs -f` for follow, and refusing it
# everywhere broke that command. Run the three documented shapes for real —
# against the fake docker, so `up` starts nothing and `logs` cannot follow.
forwards 'db:up' "$pinned_dev" --profile development up -d postgres redis
forwards 'db:down' "$pinned_dev" --profile development down
forwards 'db:logs' "$pinned_dev" --profile development logs -f postgres redis

# Each composition reaches Compose as its own pair of files under its own
# project. `--profile=test` as well as `--profile test`, because the value of
# the `=` spelling has to be read out of the same argument.
forwards 'the test composition' "$pinned_test" --profile test up -d postgres-test redis-test
forwards 'the test composition, spelled with =' "$pinned_test" --profile=test config
forwards 'the staging composition' "$pinned_deploy" --profile staging config
forwards 'the production composition' "$pinned_deploy" --profile production config
forwards 'the deployment migration pairing' "$pinned_deploy" --profile staging --profile migration run --rm migrate

# A profile-less command is a local one and must keep resolving the way it did
# when there was a single file: the development project, not an empty one.
forwards 'a profile-less local command' "$pinned_dev" ps

# `--env-file` takes a separate value, and that value is neither a subcommand
# nor a profile. Reading it as one would select the wrong composition — which
# is exactly what the deploy-smoke job in CI passes.
forwards 'an env file before the profile' "$pinned_deploy" --env-file "$fixture" --profile staging config

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
