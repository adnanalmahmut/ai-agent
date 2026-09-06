#!/bin/sh
set -eu

# Reproduces, against the real shipped scripts, every failure that had to be
# repaired by hand to bring the `b50b0f7` release up on Staging: a stale compose
# file, a PostgreSQL image without pgvector, a deploy script older than the
# release it was deploying, and a runtime.env with no APP_ENCRYPTION_KEY.
#
# The bundle is installed into a sandbox by the same installer the operator
# runs, and the deploy script under test is the copy that installer put there —
# so this exercises the recorded manifest, not a description of it. Absolute
# paths are rewritten the way infra/tests/release-manifest.sh already does; the
# host scripts take no path from the environment on purpose.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

version_file=infra/host-bundle/VERSION
minimum_file=infra/host-bundle/MIN_VERSION
inventory=infra/host-bundle/files

fail() { echo "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# The two version numbers
# ---------------------------------------------------------------------------

bundle_version=$(sed -n '1p' "$version_file")
bundle_minimum=$(sed -n '1p' "$minimum_file")
printf '%s' "$bundle_version" | grep -Eq '^[1-9][0-9]*$' ||
  fail 'host bundle VERSION must be a positive integer'
printf '%s' "$bundle_minimum" | grep -Eq '^[1-9][0-9]*$' ||
  fail 'host bundle MIN_VERSION must be a positive integer'
[ "$bundle_minimum" -le "$bundle_version" ] ||
  fail 'host bundle MIN_VERSION must not exceed the bundle VERSION it ships with'

# Both numbers are load-bearing for an operator deciding whether to reinstall, so
# the documents that explain them must be describing the bundle that actually
# ships. A bump with no doc revisit is the drift this catches.
# The version number against what the bundle actually contains.
#
# The doc checks below run in one direction only: bump VERSION and the docs must
# mention it. Nothing ran the other way, so changing a listed file while leaving
# VERSION alone was invisible -- and `docs/host-bundle.md` keeps the older
# "bundle N" strings in its history, so even the doc check stays green. Two
# changes shipped that way before this existed.
ledger=infra/host-bundle/CONTENTS
recorded=$(grep -v '^[[:space:]]*#' "$ledger" | grep -v '^[[:space:]]*$' || true)
[ -n "$recorded" ] || fail 'the host bundle contents ledger is empty'

# Versions must be unique and ascending, or "the line for this version" is not
# a well-defined thing to look up.
printf '%s\n' "$recorded" | awk '{ print $1 }' | sort -c -n 2>/dev/null ||
  fail 'host bundle contents ledger versions are not in ascending order'
[ "$(printf '%s\n' "$recorded" | awk '{ print $1 }' | sort -u | wc -l)" \
  -eq "$(printf '%s\n' "$recorded" | wc -l)" ] ||
  fail 'host bundle contents ledger records a version more than once'

ledger_line=$(printf '%s\n' "$recorded" | awk -v v="$bundle_version" '$1 == v')
[ -n "$ledger_line" ] ||
  fail "infra/host-bundle/CONTENTS has no entry for bundle $bundle_version; a changed bundle file needs a new VERSION and a new line"

# The same construction the ledger documents: the inventory, then a digest of
# every file it lists, hashed together.
bundle_entries=$(grep -v '^[[:space:]]*#' "$inventory" | grep -v '^[[:space:]]*$')
actual_digest=$(
  {
    printf '%s\n' "$bundle_entries"
    printf '%s\n' "$bundle_entries" | while read -r source _ _; do
      sha256sum "$source"
    done
  } | sha256sum | cut -d' ' -f1
)
recorded_digest=$(printf '%s\n' "$ledger_line" | awk '{ print $2 }')
[ "$actual_digest" = "$recorded_digest" ] || fail "the installed host bundle files no longer match what infra/host-bundle/CONTENTS records for bundle $bundle_version.
  recorded: $recorded_digest
  actual:   $actual_digest
  A listed file changed. Bump infra/host-bundle/VERSION and append a line for the
  new version, rather than rewriting the entry for one already installed."

# A new version has to mean a different bundle, or the number is decoration.
[ "$(printf '%s\n' "$recorded" | awk '{ print $2 }' | sort -u | wc -l)" \
  -eq "$(printf '%s\n' "$recorded" | wc -l)" ] ||
  fail 'two host bundle versions record identical contents'

grep -Fq "bundle $bundle_version" docs/host-bundle.md ||
  fail "docs/host-bundle.md does not describe bundle $bundle_version"
grep -Fq "host bundle $bundle_version" docs/release-retention.md ||
  fail "docs/release-retention.md does not describe host bundle $bundle_version"

# ---------------------------------------------------------------------------
# The inventory is the contract; nothing release-coupled may fall out of it
# ---------------------------------------------------------------------------

entries=$(grep -v '^[[:space:]]*#' "$inventory" | grep -v '^[[:space:]]*$' || true)
[ -n "$entries" ] || fail 'host bundle inventory is empty'

for required in \
  /opt/ai-agent/docker-compose.yml \
  /opt/ai-agent/docker-compose.deploy.yml \
  /usr/local/sbin/ai-agent-deploy \
  /usr/local/sbin/ai-agent-deploy-dispatch \
  /usr/local/sbin/ai-agent-runtime-preflight \
  /usr/local/sbin/ai-agent-host-preflight \
  /usr/local/sbin/ai-agent-release-retention \
  /etc/sudoers.d/ai-agent-deploy; do
  printf '%s\n' "$entries" | awk '{ print $2 }' | grep -Fxq "$required" ||
    fail "host bundle inventory does not cover $required"
done

printf '%s\n' "$entries" | while read -r source destination mode; do
  [ -f "$source" ] || fail "host bundle source is missing: $source"
  case $destination in /*) ;; *) fail "host bundle destination is not absolute: $destination" ;; esac
  printf '%s' "$mode" | grep -Eq '^0[0-7]{3}$' || fail "host bundle mode is malformed: $mode"
  case $source in *.sh | */ai-agent-deploy | */ai-agent-deploy-dispatch) sh -n "$source" ;; esac
done

sh -n infra/deploy/install-host-bundle.sh

# ---------------------------------------------------------------------------
# The release-side declaration
# ---------------------------------------------------------------------------

grep -Fq 'variable "HOST_BUNDLE_MIN_VERSION"' docker-bake.hcl ||
  fail 'docker-bake.hcl must declare the host bundle minimum as a variable'
grep -Fq '"io.ai-agent.release.sha" = "${IMAGE_TAG}"' docker-bake.hcl ||
  fail 'release images must be labelled with the release SHA'
grep -Fq '"io.ai-agent.host-bundle.min-version" = "${HOST_BUNDLE_MIN_VERSION}"' docker-bake.hcl ||
  fail 'release images must be labelled with the host bundle minimum'
grep -Fq "sed -n '1p' infra/host-bundle/MIN_VERSION" .github/workflows/publish-images.yml ||
  fail 'the publish workflow must read the host bundle minimum from its file'
grep -Fq 'hostBundleMinVersion' .github/workflows/publish-images.yml ||
  fail 'the release manifest must record the host bundle minimum'
grep -Fq 'hostBundleMinVersion' .github/workflows/deploy-staging.yml ||
  fail 'staging CD must require a declared host bundle minimum'

# The deploy script must read the requirement from the images rather than accept
# it as an argument: a new argument would have to pass the dispatcher's
# forced-command grammar, which is the trust boundary for the CI deploy key.
grep -Fq 'io.ai-agent.host-bundle.min-version' infra/deploy/ai-agent-deploy ||
  fail 'the deploy script must read the host bundle minimum from the release images'
if grep -Eq 'min-version|host-bundle' infra/deploy/ai-agent-deploy-dispatch; then
  fail 'the forced-command grammar must not carry the host bundle requirement'
fi

# Asserted against Bake's own resolution rather than the file text, because
# `labels` reaching all four targets is a property of `inherits`, not of the
# block it is written in. Skipped only where Buildx genuinely is not installed —
# never silently, on a bake error.
if docker buildx version >/dev/null 2>&1; then
  printed=$(HOST_BUNDLE_MIN_VERSION="$bundle_minimum" \
    docker buildx bake --file docker-bake.hcl release --print 2>/dev/null) ||
    fail 'the release bake definition does not resolve'
  stamped=$(printf '%s\n' "$printed" |
    grep -c "\"io.ai-agent.host-bundle.min-version\": \"$bundle_minimum\"" || true)
  [ "$stamped" -eq 4 ] ||
    fail 'every release target must inherit the host bundle minimum label'
else
  echo 'buildx unavailable: bake label resolution not asserted' >&2
fi

# ---------------------------------------------------------------------------
# Contracts that drift silently
# ---------------------------------------------------------------------------

# A compose variable whose default is empty is a value the host must supply, and
# the runtime preflight's required list is hand-maintained. Without this check
# the next such variable ships unchecked — which is exactly how
# APP_ENCRYPTION_KEY reached Staging absent and took the backend down after the
# migrations had already been applied.

# Required only when a driver selects them, so the preflight checks these inside
# a branch rather than in its unconditional list.
conditional='GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET RESEND_API_KEY AWS_REGION SMTP_HOST SMTP_USER SMTP_PASSWORD'

# Deliberately unchecked: SES resolves credentials from the instance role when
# these are absent, so requiring them would refuse a correctly configured host.
# APP_ENCRYPTION_DECRYPT_KEYS is unchecked for the opposite reason to
# APP_ENCRYPTION_KEY just above it: empty is its normal, common state (no
# decrypt-only keys configured), and the preflight already validates its
# format when it is present.
optional='AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN APP_ENCRYPTION_DECRYPT_KEYS'

# The list is a single-quoted shell here-string, so the quotes and the
# assignment prefix are stripped to leave one variable name per line.
required_block=$(sed -n '/^required=/,/^$/p' infra/deploy/runtime-preflight.sh |
  tr -d "'" | sed 's/^required=//')

# The shared file and the deployment overlay together are what a host
# installs, so both contracts below are asserted against the pair. Asserting
# the shared file alone would have gone quiet the moment the application
# services moved into the overlay, which is where every one of these variables
# now lives.
deploy_composition='infra/compose/compose.yaml infra/compose/compose.deploy.yaml'

# shellcheck disable=SC2086
for variable in $(grep -hoE '\$\{[A-Z][A-Z0-9_]*:-\}' $deploy_composition |
  sed -e 's/^\${//' -e 's/:-}$//' | sort -u); do
  classified=no

  for name in $optional; do
    [ "$name" = "$variable" ] && classified=yes
  done
  [ "$classified" = yes ] && continue

  for name in $conditional; do
    if [ "$name" = "$variable" ]; then
      classified=yes
      grep -Fq "$variable" infra/deploy/runtime-preflight.sh ||
        fail "conditionally required compose variable is unknown to the runtime preflight: $variable"
    fi
  done
  [ "$classified" = yes ] && continue

  printf '%s\n' "$required_block" | grep -Fxq "$variable" ||
    fail "compose requires a non-empty $variable and the runtime preflight does not"
done

# The same contract in the other direction, which is the one that bites during a
# host bundle rollout. The preflight validates `/etc/ai-agent/runtime.env`, but
# the compose file is what actually hands a value to a container, and it uses an
# explicit per-service `environment` allowlist rather than `env_file` — so a
# name the preflight requires and the compose file never mentions is a value the
# operator is told to set and the application never receives. An installed
# bundle older than the release is exactly how the two part company:
# APP_ENCRYPTION_ACTIVE_KEY_VERSION is required at boot, and a bundle-3 compose
# file cannot deliver it no matter what runtime.env says.
for variable in $required_block; do
  # Anchored on the character that must follow the name -- `}` for a bare
  # interpolation, `:` for a defaulted one -- so a name cannot be satisfied by
  # being a prefix of some longer variable elsewhere in the file. Or the name
  # appears directly as a service's own environment key.
  #
  # This asks only whether the compose file passes the value to *something*.
  # Which services receive it is a separate property, asserted per service
  # against a real render in infra/tests/container-environment.sh; the two are
  # deliberately not merged, because that one needs `jq` and this one must keep
  # working without it.
  # shellcheck disable=SC2086
  grep -Fq "\${$variable}" $deploy_composition ||
    grep -Fq "\${$variable:" $deploy_composition ||
    grep -q "^      $variable:" $deploy_composition ||
    fail "the runtime preflight requires $variable and the deployment composition never passes it to any service"
done

# `CREATE EXTENSION` runs inside the migration container, which can only report
# that the image cannot provide it. The deploy script asks the running database
# first; this keeps the two lists from parting company.
for extension in $(grep -rhoiE 'create extension (if not exists )?[a-z_]+' \
  apps/backend/prisma/migrations |
  awk '{ print tolower($NF) }' | sort -u); do
  grep -Eq "^required_extensions=.*\\b${extension}\\b" infra/deploy/ai-agent-deploy ||
    fail "a migration creates the $extension extension and the deploy script does not require it"
done

# ---------------------------------------------------------------------------
# Behaviour: install the bundle into a sandbox and drive the installed scripts
# ---------------------------------------------------------------------------

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

mkdir -p "$tmp_dir/bin" "$tmp_dir/src" "$tmp_dir/control"
control=$tmp_dir/control

rewrite() {
  sed \
    -e "s#/etc/sudoers.d#$tmp_dir/etc/sudoers.d#g" \
    -e "s#/etc/ai-agent#$tmp_dir/etc/ai-agent#g" \
    -e "s#/opt/ai-agent#$tmp_dir/opt/ai-agent#g" \
    -e "s#/var/lib/ai-agent#$tmp_dir/state#g" \
    -e "s#/usr/local/sbin#$tmp_dir/sbin#g" \
    "$1" >"$2"
}

# The sources the sandbox installs are pre-rewritten copies, so the manifest
# records digests of exactly what a deploy in this sandbox will execute.
rewrite infra/deploy/host-preflight.sh "$tmp_dir/src/host-preflight.sh"
rewrite infra/deploy/runtime-preflight.sh "$tmp_dir/src/runtime-preflight.sh"
rewrite infra/deploy/ai-agent-deploy-dispatch "$tmp_dir/src/ai-agent-deploy-dispatch"
cp infra/deploy/ai-agent-deploy.sudoers "$tmp_dir/src/ai-agent-deploy.sudoers"
cp infra/compose/compose.yaml "$tmp_dir/src/docker-compose.yml"
cp infra/compose/compose.deploy.yaml "$tmp_dir/src/docker-compose.deploy.yml"
rewrite infra/deploy/ai-agent-deploy "$tmp_dir/src/ai-agent-deploy"

# Stands in for ai-agent-release-retention. Retention's own behaviour is owned by
# infra/tests/release-retention.sh, which drives the real script against a modelled
# image store; what matters here is the wiring -- which entry point the wrapper
# calls, when it calls it, whether the deployment lock reaches it, and what the
# wrapper does with the answer. A stand-in also keeps this suite from needing a
# second image-store model that could drift from the first.
cat >"$tmp_dir/src/release-retention" <<'SH'
#!/bin/sh
set -eu
printf 'retention %s\n' "$*" >>"$TEST_LOG"

# What descriptor 9 is at the moment retention is entered. The real script
# refuses unless this is the deployment lock, so recording it here proves the
# wrapper actually passes its lock down.
readlink "/proc/$$/fd/9" >"$TEST_CONTROL/retention_fd9" 2>/dev/null ||
  printf 'none\n' >"$TEST_CONTROL/retention_fd9"

# The release state retention can see when it starts. This is the ordering proof:
# retention must never run before the rotation, or the release that has just
# started is not yet recorded and would look removable.
#
# Recorded once, for the earliest invocation only. A probe that adds a second,
# correctly-placed call would otherwise overwrite the pre-rotation observation
# and hide exactly what it was inserted to expose.
if [ ! -f "$TEST_CONTROL/retention_saw_current" ]; then
  if [ -f "$TEST_STATE_DIR/CURRENT_RELEASE.json" ]; then
    cat "$TEST_STATE_DIR/CURRENT_RELEASE.json" >"$TEST_CONTROL/retention_saw_current"
  else
    printf 'absent\n' >"$TEST_CONTROL/retention_saw_current"
  fi
fi

[ ! -f "$TEST_CONTROL/retention_fails" ] || {
  echo 'release retention failed: stand-in was told to fail' >&2
  exit 64
}
echo 'release retention: stand-in completed'
SH
chmod 0755 "$tmp_dir/src/release-retention"

# The deploy script's free-space floor is a property of the release, not of
# whatever the CI runner happens to have left. Its refusal is asserted directly
# against the host preflight further down.
sed -i 's/^required_free_mib=.*/required_free_mib=1/' "$tmp_dir/src/ai-agent-deploy"

{
  printf '%s %s %s\n' "$tmp_dir/src/docker-compose.yml" "$tmp_dir/opt/ai-agent/docker-compose.yml" 0644
  printf '%s %s %s\n' "$tmp_dir/src/docker-compose.deploy.yml" "$tmp_dir/opt/ai-agent/docker-compose.deploy.yml" 0644
  printf '%s %s %s\n' "$tmp_dir/src/ai-agent-deploy" "$tmp_dir/sbin/ai-agent-deploy" 0755
  printf '%s %s %s\n' "$tmp_dir/src/ai-agent-deploy-dispatch" "$tmp_dir/sbin/ai-agent-deploy-dispatch" 0755
  printf '%s %s %s\n' "$tmp_dir/src/runtime-preflight.sh" "$tmp_dir/sbin/ai-agent-runtime-preflight" 0755
  printf '%s %s %s\n' "$tmp_dir/src/host-preflight.sh" "$tmp_dir/sbin/ai-agent-host-preflight" 0755
  printf '%s %s %s\n' "$tmp_dir/src/release-retention" "$tmp_dir/sbin/ai-agent-release-retention" 0755
  printf '%s %s %s\n' "$tmp_dir/src/ai-agent-deploy.sudoers" "$tmp_dir/etc/sudoers.d/ai-agent-deploy" 0440
} >"$tmp_dir/files"

sed \
  -e "s#^root=.*#root=$root#" \
  -e "s#^inventory=.*#inventory=$tmp_dir/files#" \
  -e '/id -u/d' \
  -e 's/-o root -g root //g' \
  -e '/^chown root:root /d' \
  -e "s#/etc/sudoers.d#$tmp_dir/etc/sudoers.d#g" \
  -e "s#/etc/ai-agent#$tmp_dir/etc/ai-agent#g" \
  -e "s#/opt/ai-agent#$tmp_dir/opt/ai-agent#g" \
  -e "s#/var/lib/ai-agent#$tmp_dir/state#g" \
  -e "s#/usr/local/sbin#$tmp_dir/sbin#g" \
  infra/deploy/install-host-bundle.sh >"$tmp_dir/install"
chmod +x "$tmp_dir/install"

# Rejects a fragment that does not parse, the way the real visudo would: a stub
# that always succeeds would let the sudoers case below pass without exercising
# anything.
cat >"$tmp_dir/bin/visudo" <<'SH'
#!/bin/sh
for argument in "$@"; do file=$argument; done
grep -q 'ALL=(root)' "$file" || { echo "parse error in $file" >&2; exit 1; }
exit 0
SH
cat >"$tmp_dir/bin/curl" <<'SH'
#!/bin/sh
exit 0
SH
cat >"$tmp_dir/bin/flock" <<'SH'
#!/bin/sh
exit 0
SH
cat >"$tmp_dir/bin/docker" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$TEST_LOG"

# The wrapper pins images by exporting BACKEND_IMAGE rather than by passing it
# as an argument, so `$*` cannot see it and an assertion on the log alone would
# quietly pass whatever image was pinned -- including a mutable tag.
printf 'BACKEND_IMAGE=%s\n' "${BACKEND_IMAGE:-}" >>"$TEST_CONTROL/docker_env.log"

case ${1:-} in
  info)
    cat "$TEST_CONTROL/docker_root"
    exit 0
    ;;
  image)
    format=
    for argument in "$@"; do
      case $argument in *Config.Labels*) format=$argument ;; esac
      image=$argument
    done
    label=$(printf '%s' "$format" | sed -n 's/.*"\(io\.ai-agent[^"]*\)".*/\1/p')
    case $label in
      io.ai-agent.release.sha) label_key=release-sha ;;
      io.ai-agent.host-bundle.min-version) label_key=min-version ;;
      io.ai-agent.component.name) label_key=component-name ;;
      *) printf '<no value>\n'; exit 0 ;;
    esac
    case $image in
      *"/backend-migration@"*) image_key=backend-migration ;;
      *"/backend@"*) image_key=backend ;;
      *"/web@"*) image_key=web ;;
      *"/platform@"*) image_key=platform ;;
      *) image_key=unknown ;;
    esac
    # The component label answers with the image's own identity unless a test
    # deliberately overrides it, which is how a digest in the wrong slot is
    # simulated.
    if [ "$label_key" = component-name ] && [ ! -f "$TEST_CONTROL/label.component-name.$image_key" ]; then
      printf '%s\n' "$image_key"
      exit 0
    fi
    if [ -f "$TEST_CONTROL/label.$label_key.$image_key" ]; then
      cat "$TEST_CONTROL/label.$label_key.$image_key"
    elif [ -f "$TEST_CONTROL/label.$label_key" ]; then
      cat "$TEST_CONTROL/label.$label_key"
    else
      printf '<no value>\n'
    fi
    exit 0
    ;;
esac

# Lets a case above ask the rotation command for a specific exit code, so the
# wrapper's propagation of it can be asserted rather than assumed.
case " $* " in
  *' managed-secret:rotate-key '*)
    if [ -f "$TEST_CONTROL/rotate_exit" ]; then
      exit "$(cat "$TEST_CONTROL/rotate_exit")"
    fi
    ;;
esac

case " $* " in
  *' config --images '*)
    cat "$TEST_CONTROL/compose_images"
    exit 0
    ;;
  *' exec -T postgres '*)
    cat "$TEST_CONTROL/pg_extension_count"
    exit 0
    ;;
  *' ps --status running --services '*)
    service=
    for argument in "$@"; do service=$argument; done
    printf '%s\n' "$service"
    exit 0
    ;;
esac
exit 0
SH
chmod +x "$tmp_dir/bin/visudo" "$tmp_dir/bin/curl" "$tmp_dir/bin/flock" "$tmp_dir/bin/docker"

PATH="$tmp_dir/bin:$PATH"
export PATH
export TEST_LOG=$tmp_dir/commands.log
export TEST_CONTROL=$control
export TEST_STATE_DIR=$tmp_dir/state

registry=ghcr.io/adnanalmahmut/ai-agent
release_sha=1111111111111111111111111111111111111111
backend_digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
migration_digest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
web_digest=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
platform_digest=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd

printf '%s\n' "$tmp_dir" >"$control/docker_root"
printf '%s\n' "$release_sha" >"$control/label.release-sha"
printf '%s\n' "$bundle_minimum" >"$control/label.min-version"
printf '1\n' >"$control/pg_extension_count"
{
  printf '%s/backend@sha256:%s\n' "$registry" "$backend_digest"
  printf '%s/backend-migration@sha256:%s\n' "$registry" "$migration_digest"
  printf '%s/web@sha256:%s\n' "$registry" "$web_digest"
  printf '%s/platform@sha256:%s\n' "$registry" "$platform_digest"
  printf 'pgvector/pgvector:pg16\n'
  printf 'redis:7-alpine\n'
} >"$control/compose_images"

"$tmp_dir/install" >/dev/null

manifest=$tmp_dir/etc/ai-agent/host-bundle.manifest
[ -f "$manifest" ] || fail 'the installer recorded no host bundle manifest'
grep -Fxq "version $bundle_version" "$manifest" ||
  fail 'the recorded manifest does not carry the bundle version'
[ "$(grep -c '^file ' "$manifest")" -eq 8 ] ||
  fail 'the recorded manifest does not cover every installed file'

preflight=$tmp_dir/sbin/ai-agent-host-preflight
"$preflight" integrity >/dev/null

mkdir -p "$tmp_dir/etc/ai-agent"
printf 'staging\n' >"$tmp_dir/etc/ai-agent/environment"
cat >"$tmp_dir/etc/ai-agent/runtime.env" <<'ENV'
NODE_ENV=staging
POSTGRES_USER=app
POSTGRES_PASSWORD=test-only-explicit-password
POSTGRES_DB=app
DATABASE_URL=postgresql://app:test-only-explicit-password@postgres:5432/app?schema=public
REDIS_URL=redis://redis:6379
APP_ENCRYPTION_KEY=dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=
APP_ENCRYPTION_ACTIVE_KEY_VERSION=v1
APP_ENCRYPTION_DECRYPT_KEYS=
BETTER_AUTH_SECRET=test-only-better-auth-secret-000000000000
BETTER_AUTH_URL=https://staging.invalid/api/auth
BETTER_AUTH_TRUSTED_ORIGINS=https://staging.invalid
APP_PLATFORM_URL=https://staging.invalid/platform
MAIL_DRIVER=log
MAIL_FROM_ADDRESS=no-reply@staging.invalid
GEOIPUPDATE_ACCOUNT_ID=test-account
GEOIPUPDATE_LICENSE_KEY=test-license
GOOGLE_AUTH_ENABLED=false
ENV

deploy=$tmp_dir/sbin/ai-agent-deploy
attempt_deploy() {
  "$deploy" deploy staging "$release_sha" "$backend_digest" "$migration_digest" \
    "$web_digest" "$platform_digest"
}

# The expected message is part of the assertion, not decoration. Without it a
# case passes as long as *something* refuses, so a later refactor could move a
# gate, have a different one fire first, and leave the suite green while the
# refusal being tested no longer exists.
refuses() {
  expected=$1
  description=$2
  shift 2
  before=$(grep -c 'run --rm migrate' "$TEST_LOG" || true)
  if "$@" >"$tmp_dir/out" 2>&1; then
    fail "deployment was accepted despite $description"
  fi
  after=$(grep -c 'run --rm migrate' "$TEST_LOG" || true)
  [ "$after" = "$before" ] || fail "migrations ran despite $description"
  grep -Fq "$expected" "$tmp_dir/out" || {
    echo "refusal for $description did not name the expected cause" >&2
    echo "  expected to contain: $expected" >&2
    echo "  actual: $(cat "$tmp_dir/out")" >&2
    exit 1
  }
}

# The happy path first, so every refusal below is known to be caused by the one
# thing the case changes.
attempt_deploy >/dev/null
[ "$(grep -c 'run --rm migrate' "$TEST_LOG")" -eq 1 ] ||
  fail 'a satisfied host did not reach migrations'
grep -Fq "\"sha\":\"$release_sha\"" "$tmp_dir/state/CURRENT_RELEASE.json" ||
  fail 'a successful deployment recorded no release manifest'

# ---------------------------------------------------------------------------
# Retention is invoked by a successful deployment, and only afterwards
# ---------------------------------------------------------------------------

# Each case that inspects the recorded release state deploys a SHA that is not
# already recorded. Reusing one would make the ordering assertion hold whether
# retention ran before or after the rotation, because CURRENT would carry that
# SHA either way -- which the ordering probe caught.
second_sha=3333333333333333333333333333333333333333
third_sha=4444444444444444444444444444444444444444

deploy_sha() {
  printf '%s\n' "$1" >"$control/label.release-sha"
  "$deploy" deploy staging "$1" "$backend_digest" "$migration_digest" \
    "$web_digest" "$platform_digest"
}
deploy_second() { deploy_sha "$second_sha"; }
deploy_third() { deploy_sha "$third_sha"; }
restore_first_sha() { printf '%s\n' "$release_sha" >"$control/label.release-sha"; }

# A second release, so CURRENT changes value. With one SHA the ordering assertion
# below would hold whether retention ran before or after the rotation, and would
# be proving nothing.
rm -f "$control/retention_fd9" "$control/retention_saw_current"
deploy_second >"$tmp_dir/out" 2>&1 || fail 'a second deployment did not succeed'

grep -Fq 'retention reclaim-locked 1' "$TEST_LOG" ||
  fail 'a successful deployment did not invoke retention through the inherited-lock entry point'
if grep -Eq '^retention reclaim( |$)' "$TEST_LOG"; then
  fail 'the wrapper invoked the standalone retention entry point, which its own lock would refuse'
fi

# The deployment lock reaches retention as descriptor 9. Without this the real
# script refuses, so the wiring and the contract are asserted in one place.
[ "$(cat "$control/retention_fd9")" = "$tmp_dir/state/deploy.lock" ] ||
  fail "retention did not receive the deployment lock on descriptor 9: $(cat "$control/retention_fd9")"

# Ordering. Retention must see the release that was just deployed already
# recorded as CURRENT; anything earlier and that release is an unrecorded image
# on disk, which is exactly the description of a removal candidate.
grep -Fq "\"sha\":\"$second_sha\"" "$control/retention_saw_current" ||
  fail 'retention ran before CURRENT was rotated to the release being deployed'

# The wrapper reports the outcome in its own voice rather than leaving a reader
# to infer it from retention's output.
grep -Fq 'release retention: completed' "$tmp_dir/out" ||
  fail 'a successful deployment did not report the retention outcome'

# --- A retention failure is loud, and does not fail a healthy deployment ---
: >"$control/retention_fails"
rm -f "$control/retention_saw_current"
deploy_second >"$tmp_dir/out" 2>&1 ||
  fail 'a retention failure turned a healthy deployment into a failed one'
grep -Fq 'release retention FAILED' "$tmp_dir/out" ||
  fail 'a retention failure was not reported'
grep -Fq 'exit 64' "$tmp_dir/out" ||
  fail 'a retention failure did not report its exit status'
grep -Fq 'this deployment is healthy and complete' "$tmp_dir/out" ||
  fail 'a retention failure did not distinguish itself from a deployment failure'
grep -Fq "\"sha\":\"$second_sha\"" "$tmp_dir/state/CURRENT_RELEASE.json" ||
  fail 'a retention failure lost the recorded release state'
rm -f "$control/retention_fails"

# --- The retention executable is a bundle requirement ---
# Refused at the top of the wrapper, before anything irreversible, the same way
# every other installed bundle file is.
mv "$tmp_dir/sbin/ai-agent-release-retention" "$tmp_dir/retention.absent"
refuses 'release retention is not installed' \
  'a host bundle with no retention executable' deploy_second
# ...but only for `deploy`. `health` is what staging CD and an operator during an
# incident both call, and it does not use retention, so a missing retention
# executable must not turn the diagnostic into a refusal.
"$deploy" health staging >/dev/null 2>&1 ||
  fail 'health refused because the retention executable was absent'
mv "$tmp_dir/retention.absent" "$tmp_dir/sbin/ai-agent-release-retention"

# ---------------------------------------------------------------------------
# The bundle version gate, at the minimum this release actually declares
# ---------------------------------------------------------------------------

# The recorded version is not covered by the manifest's file digests, so it can
# be rewritten without disturbing the integrity check -- which is the point: this
# is a host genuinely on an older bundle, not a tampered one.
set_recorded_version() {
  sed "s/^version .*/version $1/" "$manifest" >"$manifest.next"
  mv "$manifest.next" "$manifest"
}

set_recorded_version 1
refuses "requires host bundle $bundle_minimum and the host has 1" \
  "a host still on bundle 1 deploying a release that declares a minimum of $bundle_minimum" \
  deploy_second

# Accepted at exactly the declared minimum. The wrapper installed here is the
# OPS-03B one, so this asserts the version arithmetic rather than claiming a real
# bundle-2 host would invoke retention -- a real one carries the bundle-2
# wrapper, which does not.
set_recorded_version "$bundle_minimum"
deploy_second >/dev/null 2>&1 ||
  fail 'a host at exactly the declared minimum was refused'
set_recorded_version "$bundle_version"

# ---------------------------------------------------------------------------
# The rotation verb arrives with the bundle, not with the release
# ---------------------------------------------------------------------------
#
# Bundle 5 adds `rotate-managed-secret-keys` to the wrapper and deliberately
# leaves MIN_VERSION at 4, so a release carrying it deploys onto a host that
# cannot run it. That is only defensible if both halves hold: the installed
# bundle really does have the verb, and a deployment really does not use it.
# The bundle-4 half -- a wrapper without the verb still deploying, and refusing
# the verb -- is probed further down, where the wrapper can be edited and
# reinstalled.

# Deployed with a backend digest no other release in this sandbox uses, so the
# assertion below can tell the CURRENT release from the PREVIOUS one. Sharing
# one digest across every release -- which the rest of this suite does, having
# no reason not to -- would let a wrapper that read PREVIOUS_RELEASE.json pass a
# check whose message claims it read CURRENT.
rotation_sha=5555555555555555555555555555555555555555
rotation_digest=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
printf '%s\n' "$rotation_sha" >"$control/label.release-sha"
# The compose-resolved image list is checked against the pinned digests, so it
# has to name the same backend digest this deployment pins.
write_compose_images() {
  {
    printf '%s/backend@sha256:%s\n' "$registry" "$1"
    printf '%s/backend-migration@sha256:%s\n' "$registry" "$migration_digest"
    printf '%s/web@sha256:%s\n' "$registry" "$web_digest"
    printf '%s/platform@sha256:%s\n' "$registry" "$platform_digest"
    printf 'pgvector/pgvector:pg16\n'
    printf 'redis:7-alpine\n'
  } >"$control/compose_images"
}
write_compose_images "$rotation_digest"
"$deploy" deploy staging "$rotation_sha" "$rotation_digest" "$migration_digest" \
  "$web_digest" "$platform_digest" >/dev/null 2>&1 ||
  fail 'the sandbox could not deploy the release the rotation verb runs against'

: >"$TEST_LOG"
: >"$control/docker_env.log"
"$deploy" rotate-managed-secret-keys staging --dry-run >"$tmp_dir/out" 2>&1 ||
  fail "the installed bundle $bundle_version wrapper could not run the rotation verb: $(cat "$tmp_dir/out")"
grep -Fq 'managed-secret:rotate-key' "$TEST_LOG" ||
  fail 'the rotation verb did not reach the backend rotation command'
# Pinned to the recorded release digest rather than a mutable tag: this reads
# and rewrites every stored credential with the master key in its environment,
# so an ad-hoc `:development` resolution would be an arbitrary image handed the
# whole credential table.
grep -Fxq "BACKEND_IMAGE=$registry/backend@sha256:$rotation_digest" \
  "$control/docker_env.log" ||
  fail "the rotation verb did not pin the digest recorded for the current release: $(cat "$control/docker_env.log")"
grep -Fq -- '--dry-run' "$TEST_LOG" ||
  fail 'the rotation verb did not forward its arguments to the backend command'

# The backend's exit code has to survive the wrapper unchanged. The runbook's
# retirement gate is "the dry run must exit 0", so a stray `|| true` or a
# trailing command in this case arm would turn "rows are still on the old key"
# into permission to delete that key.
printf '7\n' >"$control/rotate_exit"
rotate_status=0
# Captured through `||` because `set -e` would otherwise abort the suite on the
# non-zero exit this case exists to observe.
"$deploy" rotate-managed-secret-keys staging --dry-run >/dev/null 2>&1 ||
  rotate_status=$?
rm -f "$control/rotate_exit"
[ "$rotate_status" -eq 7 ] ||
  fail "the wrapper did not propagate the rotation exit code: got $rotate_status, expected 7"

# Nothing a deployment does calls it. Rotation is an operator action taken after
# a separate decision, and a deployment that rotated keys on its own would be
# re-encrypting every credential on the platform unasked.
write_compose_images "$backend_digest"
restore_first_sha
: >"$TEST_LOG"
deploy_second >/dev/null 2>&1 || fail 'a deployment failed'
if grep -Fq 'managed-secret:rotate-key' "$TEST_LOG"; then
  fail 'a deployment invoked managed-secret key rotation'
fi

# ---------------------------------------------------------------------------
# Mutation probes on the wrapper itself
# ---------------------------------------------------------------------------
#
# The wrapper source is edited and the bundle reinstalled, so the manifest
# records digests of exactly what the sandbox then executes -- the same route the
# operator takes, not a way around the integrity check.

probe_wrapper() {
  expression=$1
  cp "$tmp_dir/src/ai-agent-deploy" "$tmp_dir/wrapper.pristine"
  python3 - "$tmp_dir/wrapper.pristine" "$tmp_dir/src/ai-agent-deploy" "$expression" <<'PROBE'
import sys
source, destination, expression = sys.argv[1], sys.argv[2], sys.argv[3]
old, new = expression.split('=>', 1)
text = open(source).read()
if old not in text:
    sys.stderr.write('wrapper probe anchor missing: %r\n' % old)
    sys.exit(2)
open(destination, 'w').write(text.replace(old, new, 1))
PROBE
  "$tmp_dir/install" >/dev/null
}

probe_wrapper_done() {
  cp "$tmp_dir/wrapper.pristine" "$tmp_dir/src/ai-agent-deploy"
  "$tmp_dir/install" >/dev/null
}

# Retention moved ahead of the rotation. This is the ordering mistake that would
# put the release being deployed into the candidate set, and the ordering
# assertion above has to be what catches it.
probe_wrapper '  if [ -f "$current_release" ]; then=>  run_retention
  if [ -f "$current_release" ]; then'
rm -f "$control/retention_saw_current"
deploy_third >/dev/null 2>&1 || true
if grep -Fq "\"sha\":\"$third_sha\"" "$control/retention_saw_current"; then
  probe_wrapper_done
  fail 'retention called before the rotation still saw the new release as CURRENT; the ordering assertion proves nothing'
fi
# ...and it did see the release the rotation was about to replace, which is what
# makes this the dangerous case rather than merely a different one.
grep -Fq "\"sha\":\"$second_sha\"" "$control/retention_saw_current" ||
  fail 'the pre-rotation probe did not observe the superseded release as CURRENT'
probe_wrapper_done

# The retention invocation removed entirely.
probe_wrapper '    run_retention
    ;;=>    ;;'
: >"$TEST_LOG"
deploy_second >/dev/null 2>&1 || true
if grep -Fq 'retention reclaim-locked' "$TEST_LOG"; then
  probe_wrapper_done
  fail 'retention appeared to run with its invocation removed; the invocation assertion proves nothing'
fi
probe_wrapper_done

# Retention failure made fatal. The tolerance is what keeps a healthy deployment
# green, so removing it has to be visible.
probe_wrapper "    status=\$?=>    die 'retention failed'"
: >"$control/retention_fails"
if deploy_second >/dev/null 2>&1; then
  rm -f "$control/retention_fails"
  probe_wrapper_done
  fail 'a fatal retention failure still reported a successful deployment; the tolerance assertion proves nothing'
fi
rm -f "$control/retention_fails"
probe_wrapper_done

# The verb scoping on the retention requirement. With it gone, a host missing the
# retention executable can no longer answer `health` -- the diagnostic staging CD
# and an operator during an incident both call.
probe_wrapper '[ "${1:-}" != deploy ] || [ -x "$retention" ] ||=>[ -x "$retention" ] ||'
mv "$tmp_dir/sbin/ai-agent-release-retention" "$tmp_dir/retention.absent"
if "$deploy" health staging >/dev/null 2>&1; then
  mv "$tmp_dir/retention.absent" "$tmp_dir/sbin/ai-agent-release-retention"
  probe_wrapper_done
  fail 'health still answered with the verb scoping removed; the scoping assertion proves nothing'
fi
mv "$tmp_dir/retention.absent" "$tmp_dir/sbin/ai-agent-release-retention"
probe_wrapper_done

# The declared minimum permits a host whose wrapper lacks the rotation verb.
# That host must still deploy and must refuse only the unsupported operation.
probe_wrapper '  rotate-managed-secret-keys)=>  rotate-managed-secret-keys-is-not-in-bundle-4)'
# Record the declared minimum as well as using its verb-limited wrapper.
set_recorded_version "$bundle_minimum"
if "$deploy" rotate-managed-secret-keys staging --dry-run >"$tmp_dir/out" 2>&1; then
  probe_wrapper_done
  fail 'a wrapper without the rotation verb still ran it; the bundle assertion above proves nothing'
fi
grep -Fq 'unsupported operation' "$tmp_dir/out" || {
  probe_wrapper_done
  fail 'a wrapper without the rotation verb did not refuse with a stated cause'
}
: >"$TEST_LOG"
deploy_second >/dev/null 2>&1 || {
  set_recorded_version "$bundle_version"
  probe_wrapper_done
  fail 'a bundle-4 host could not deploy a release that ships bundle 5'
}
set_recorded_version "$bundle_version"
probe_wrapper_done

# Leave the sandbox as the happy path left it, so every case below is still
# caused by the one thing it changes.
restore_first_sha
attempt_deploy >/dev/null

# Staging failure 1: the installed compose file predated the release.
cp "$tmp_dir/opt/ai-agent/docker-compose.yml" "$tmp_dir/compose.saved"
printf '\n# hand-edited on the host\n' >>"$tmp_dir/opt/ai-agent/docker-compose.yml"
refuses 'does not match the recorded bundle' \
  'a compose file that no longer matches the recorded bundle' attempt_deploy
cp "$tmp_dir/compose.saved" "$tmp_dir/opt/ai-agent/docker-compose.yml"
attempt_deploy >/dev/null

# Staging failure 2: the deploy script itself was older than the release.
cp "$deploy" "$tmp_dir/deploy.saved"
printf '\n# hand-edited on the host\n' >>"$deploy"
refuses 'does not match the recorded bundle' \
  'a deploy script that no longer matches the recorded bundle' attempt_deploy
cp "$tmp_dir/deploy.saved" "$deploy"

# A recorded file that has been made writable by others is as much a bundle
# mismatch as an edited one.
chmod 0777 "$tmp_dir/opt/ai-agent/docker-compose.yml"
refuses 'has the wrong mode' \
  'an installed bundle file with the wrong mode' attempt_deploy
chmod 0644 "$tmp_dir/opt/ai-agent/docker-compose.yml"

# Staging failure 3: the image had no pgvector, and the migration container was
# the first thing to find out.
printf '0\n' >"$control/pg_extension_count"
refuses 'does not provide a required extension: vector' \
  'a PostgreSQL image without the required extension' attempt_deploy
printf '1\n' >"$control/pg_extension_count"

# Staging failure 4: APP_ENCRYPTION_KEY was absent, and the backend refused to
# boot after migrations had already been applied.
cp "$tmp_dir/etc/ai-agent/runtime.env" "$tmp_dir/runtime.saved"
grep -v '^APP_ENCRYPTION_KEY=' "$tmp_dir/runtime.saved" >"$tmp_dir/etc/ai-agent/runtime.env"
refuses 'APP_ENCRYPTION_KEY' \
  'a runtime environment with no encryption key' attempt_deploy
cp "$tmp_dir/runtime.saved" "$tmp_dir/etc/ai-agent/runtime.env"

# The release requires a newer bundle than the host has recorded. Derived from
# the bundle VERSION the sandbox installed, not from MIN_VERSION: those two are
# equal only while every shipped capability is also required, and a release that
# adds an installed-but-unused capability deliberately leaves MIN_VERSION behind
# VERSION. Keying off MIN_VERSION made this case stop refusing the moment that
# happened, which is precisely when it needs to keep working.
printf '%s\n' "$((bundle_version + 1))" >"$control/label.min-version"
refuses 'reinstall the bundle from the release checkout' \
  'a release that requires a newer host bundle' attempt_deploy
printf '%s\n' "$bundle_minimum" >"$control/label.min-version"

# Four immutable digests that do not belong to one release.
printf '2222222222222222222222222222222222222222\n' >"$control/label.release-sha.platform"
refuses 'does not belong to the requested release' \
  'an image that belongs to a different release' attempt_deploy
rm -f "$control/label.release-sha.platform"

# One image built from a tree that declared a different host requirement.
printf '%s\n' "$((bundle_minimum + 1))" >"$control/label.min-version.web"
refuses 'disagree on the host bundle minimum' \
  'release images that disagree on the host requirement' attempt_deploy
rm -f "$control/label.min-version.web"

# A digest in the wrong slot. Both images are real, both belong to this release,
# and both declare the same host requirement -- every other check here passes.
# What makes it a refusal is that the image the manifest handed over as the web
# component says it is the platform image.
printf 'platform\n' >"$control/label.component-name.web"
refuses 'not the web component' \
  'the platform image handed over as the web component' attempt_deploy
rm -f "$control/label.component-name.web"

# Releases published before the component label exist, and a host has to stay
# able to roll back to one, so a release carrying no component label at all is
# read as the legacy release it is (asserted in infra/tests/release-manifest.sh,
# where a rollback to one succeeds). A release labelled on only part of itself
# is not that: it is images from more than one publish, and it is exactly the
# case a per-image check has to catch, since half a label proves nothing.
printf '<no value>\n' >"$control/label.component-name.backend"
refuses 'component names for only part of itself' \
  'a release where one image carries no component label' attempt_deploy
rm -f "$control/label.component-name.backend"

printf '<no value>\n' >"$control/label.component-name.web"
printf '<no value>\n' >"$control/label.component-name.platform"
refuses 'component names for only part of itself' \
  'a release labelled on half its images' attempt_deploy
rm -f "$control/label.component-name.web" "$control/label.component-name.platform"

# An unlabelled image cannot state what it needs, so it cannot be accepted.
printf '<no value>\n' >"$control/label.min-version"
refuses 'does not declare io.ai-agent.host-bundle.min-version' \
  'a release that declares no host requirement' attempt_deploy
printf '%s\n' "$bundle_minimum" >"$control/label.min-version"

# A compose file that ignores the exported image variable resolves something
# other than the digest it was handed, which is how Staging deployed a release
# against a compose file that predated it.
cp "$control/compose_images" "$tmp_dir/images.saved"
sed "s#$registry/web@sha256:$web_digest#$registry/web:$release_sha#" \
  "$tmp_dir/images.saved" >"$control/compose_images"
refuses 'does not resolve the pinned release images' \
  'a compose file that drops a pinned digest' attempt_deploy

# Distinct from the case above, and reachable on its own: every pinned digest is
# present, but some other application service — `worker` shares the backend
# image through its own `image:` line — still resolves a tag. A release that
# resolves a mutable tag anywhere silently becomes whatever the registry points
# at by the time it is pulled.
{
  cat "$tmp_dir/images.saved"
  printf '%s/backend:development\n' "$registry"
} >"$control/compose_images"
refuses 'resolves a mutable application tag' \
  'a compose file that resolves a mutable application tag alongside the digests' attempt_deploy
cp "$tmp_dir/images.saved" "$control/compose_images"

# A manifest that simply omits the release-coupled files must not verify.
cp "$manifest" "$tmp_dir/manifest.saved"
grep -v 'docker-compose\.yml' "$tmp_dir/manifest.saved" >"$manifest"
refuses 'does not cover the installed compose file' \
  'a manifest that does not cover the installed compose file' attempt_deploy
cp "$tmp_dir/manifest.saved" "$manifest"

# The deployment overlay is the half carrying every application service, so an
# unrecorded overlay is the same failure as an unrecorded compose file: the host
# would resolve nothing but the datastores, and a tampered file would read as a
# topology change rather than as tampering.
grep -v 'docker-compose\.deploy\.yml' "$tmp_dir/manifest.saved" >"$manifest"
refuses 'does not cover the installed deployment compose overlay' \
  'a manifest that does not cover the installed deployment overlay' attempt_deploy
cp "$tmp_dir/manifest.saved" "$manifest"

# A near-miss entry must not satisfy the coverage check either: the recorded
# path is compared as a whole field, so an entry for `<path>.bak` leaves the
# real compose file unrecorded and therefore unverified.
sed 's#docker-compose.yml$#docker-compose.yml.bak#' "$tmp_dir/manifest.saved" >"$manifest"
refuses 'does not cover the installed compose file' \
  'a manifest whose compose entry is a near-miss path' attempt_deploy
cp "$tmp_dir/manifest.saved" "$manifest"

# No recorded bundle at all: the host cannot claim to satisfy anything.
mv "$manifest" "$tmp_dir/manifest.absent"
refuses 'no host bundle is recorded' \
  'a host with no recorded bundle' attempt_deploy
mv "$tmp_dir/manifest.absent" "$manifest"

# ---------------------------------------------------------------------------
# The installer refuses before it changes anything
# ---------------------------------------------------------------------------

# A refusal must leave the host no worse than it found it. The installer
# validates the whole inventory first for that reason: a half-installed bundle
# would leave a manifest describing a host that does not exist, and — for the
# sudoers fragment — a file that does not parse can make sudo refuse every
# command for every user, locking the operator out of the host and the deploy
# user out of the one command it is allowed to run.
installer_refuses() {
  expected=$1
  description=$2
  inventory_body=$3

  cp "$manifest" "$tmp_dir/manifest.keep"
  printf '%s' "$inventory_body" >"$tmp_dir/files.bad"
  bad_install=$tmp_dir/install-bad
  sed "s#^inventory=.*#inventory=$tmp_dir/files.bad#" "$tmp_dir/install" >"$bad_install"
  chmod +x "$bad_install"

  if "$bad_install" >"$tmp_dir/out" 2>&1; then
    fail "the installer accepted $description"
  fi
  grep -Fq "$expected" "$tmp_dir/out" || {
    echo "the installer's refusal for $description did not name the expected cause" >&2
    echo "  expected to contain: $expected" >&2
    echo "  actual: $(cat "$tmp_dir/out")" >&2
    exit 1
  }
  cmp -s "$manifest" "$tmp_dir/manifest.keep" ||
    fail "a refused installation rewrote the recorded manifest for $description"
}

installer_refuses 'host bundle source is missing' 'an inventory naming a source that does not exist' \
  "$tmp_dir/src/absent.sh $tmp_dir/sbin/absent.sh 0755
"
installer_refuses 'host bundle destination must be absolute' 'a relative destination' \
  "$tmp_dir/src/host-preflight.sh relative/path 0755
"
installer_refuses 'host bundle mode is malformed' 'a malformed mode' \
  "$tmp_dir/src/host-preflight.sh $tmp_dir/sbin/probe 0o755
"
installer_refuses 'host bundle inventory is empty' 'an inventory with nothing in it' \
  "# only a comment
"

# The sudoers fragment specifically: validated on the source, so a fragment that
# does not parse is refused while the working one is still in place. Validating
# after `install` would already have replaced it.
printf 'this is not valid sudoers syntax %%%%\n' >"$tmp_dir/src/bad.sudoers"
cp "$tmp_dir/etc/sudoers.d/ai-agent-deploy" "$tmp_dir/sudoers.keep"
installer_refuses 'sudoers fragment is invalid' 'a sudoers fragment that does not parse' \
  "$tmp_dir/src/bad.sudoers $tmp_dir/etc/sudoers.d/ai-agent-deploy 0440
"
cmp -s "$tmp_dir/etc/sudoers.d/ai-agent-deploy" "$tmp_dir/sudoers.keep" ||
  fail 'a refused installation replaced the working sudoers fragment'

# The bundle the earlier cases installed must still verify, or one of the
# refusals above changed the host on its way out.
"$preflight" integrity >/dev/null

# The host preflight's own contracts, asserted directly so they do not depend on
# whatever free space the runner happens to have.
"$preflight" disk 1 >/dev/null
if "$preflight" disk 999999999 >/dev/null 2>&1; then
  fail 'the host preflight accepted a host with no room for the release'
fi
"$preflight" require-version "$bundle_version" >/dev/null
if "$preflight" require-version "$((bundle_version + 1))" >/dev/null 2>&1; then
  fail 'the host preflight accepted a release newer than the installed bundle'
fi
if "$preflight" require-version 0 >/dev/null 2>&1; then
  fail 'the host preflight accepted a malformed required version'
fi

# Rollback runs the same gated path and must still redeploy without migrating.
before_rollback=$(grep -c 'run --rm migrate' "$TEST_LOG")
"$deploy" deploy staging 3333333333333333333333333333333333333333 \
  "$backend_digest" "$migration_digest" "$web_digest" "$platform_digest" \
  >/dev/null 2>&1 || true
printf '%s\n' "$release_sha" >"$control/label.release-sha"
"$deploy" rollback staging >/dev/null
[ "$(grep -c 'run --rm migrate' "$TEST_LOG")" -eq "$before_rollback" ] ||
  fail 'rollback applied migrations'
grep -Fq "\"sha\":\"$release_sha\"" "$tmp_dir/state/CURRENT_RELEASE.json" ||
  fail 'rollback did not restore the previous release'

echo 'host bundle versioning and deployment preflight invariants: ok'
