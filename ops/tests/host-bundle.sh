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
# paths are rewritten the way ops/tests/release-manifest.sh already does; the
# host scripts take no path from the environment on purpose.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

version_file=ops/host-bundle/VERSION
minimum_file=ops/host-bundle/MIN_VERSION
inventory=ops/host-bundle/files

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

# ---------------------------------------------------------------------------
# The inventory is the contract; nothing release-coupled may fall out of it
# ---------------------------------------------------------------------------

entries=$(grep -v '^[[:space:]]*#' "$inventory" | grep -v '^[[:space:]]*$')
[ -n "$entries" ] || fail 'host bundle inventory is empty'

for required in \
  /opt/ai-agent/docker-compose.yml \
  /usr/local/sbin/ai-agent-deploy \
  /usr/local/sbin/ai-agent-deploy-dispatch \
  /usr/local/sbin/ai-agent-runtime-preflight \
  /usr/local/sbin/ai-agent-host-preflight \
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

sh -n ops/lightsail/install-host-bundle.sh

# ---------------------------------------------------------------------------
# The release-side declaration
# ---------------------------------------------------------------------------

grep -Fq 'variable "HOST_BUNDLE_MIN_VERSION"' docker-bake.hcl ||
  fail 'docker-bake.hcl must declare the host bundle minimum as a variable'
grep -Fq '"io.ai-agent.release.sha" = "${IMAGE_TAG}"' docker-bake.hcl ||
  fail 'release images must be labelled with the release SHA'
grep -Fq '"io.ai-agent.host-bundle.min-version" = "${HOST_BUNDLE_MIN_VERSION}"' docker-bake.hcl ||
  fail 'release images must be labelled with the host bundle minimum'
grep -Fq "sed -n '1p' ops/host-bundle/MIN_VERSION" .github/workflows/publish-images.yml ||
  fail 'the publish workflow must read the host bundle minimum from its file'
grep -Fq 'hostBundleMinVersion' .github/workflows/publish-images.yml ||
  fail 'the release manifest must record the host bundle minimum'
grep -Fq 'hostBundleMinVersion' .github/workflows/deploy-staging.yml ||
  fail 'staging CD must require a declared host bundle minimum'

# The deploy script must read the requirement from the images rather than accept
# it as an argument: a new argument would have to pass the dispatcher's
# forced-command grammar, which is the trust boundary for the CI deploy key.
grep -Fq 'io.ai-agent.host-bundle.min-version' ops/lightsail/ai-agent-deploy ||
  fail 'the deploy script must read the host bundle minimum from the release images'
if grep -Eq 'min-version|host-bundle' ops/lightsail/ai-agent-deploy-dispatch; then
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
optional='AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN'

# The list is a single-quoted shell here-string, so the quotes and the
# assignment prefix are stripped to leave one variable name per line.
required_block=$(sed -n '/^required=/,/^$/p' ops/runtime-preflight.sh |
  tr -d "'" | sed 's/^required=//')

for variable in $(grep -oE '\$\{[A-Z][A-Z0-9_]*:-\}' docker-compose.yml |
  sed -e 's/^\${//' -e 's/:-}$//' | sort -u); do
  classified=no

  for name in $optional; do
    [ "$name" = "$variable" ] && classified=yes
  done
  [ "$classified" = yes ] && continue

  for name in $conditional; do
    if [ "$name" = "$variable" ]; then
      classified=yes
      grep -Fq "$variable" ops/runtime-preflight.sh ||
        fail "conditionally required compose variable is unknown to the runtime preflight: $variable"
    fi
  done
  [ "$classified" = yes ] && continue

  printf '%s\n' "$required_block" | grep -Fxq "$variable" ||
    fail "compose requires a non-empty $variable and the runtime preflight does not"
done

# `CREATE EXTENSION` runs inside the migration container, which can only report
# that the image cannot provide it. The deploy script asks the running database
# first; this keeps the two lists from parting company.
for extension in $(grep -rhoiE 'create extension (if not exists )?[a-z_]+' \
  apps/backend/prisma/migrations |
  awk '{ print tolower($NF) }' | sort -u); do
  grep -Eq "^required_extensions=.*\\b${extension}\\b" ops/lightsail/ai-agent-deploy ||
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
rewrite ops/host-preflight.sh "$tmp_dir/src/host-preflight.sh"
rewrite ops/runtime-preflight.sh "$tmp_dir/src/runtime-preflight.sh"
rewrite ops/lightsail/ai-agent-deploy-dispatch "$tmp_dir/src/ai-agent-deploy-dispatch"
cp ops/lightsail/ai-agent-deploy.sudoers "$tmp_dir/src/ai-agent-deploy.sudoers"
cp docker-compose.yml "$tmp_dir/src/docker-compose.yml"
rewrite ops/lightsail/ai-agent-deploy "$tmp_dir/src/ai-agent-deploy"
# The deploy script's free-space floor is a property of the release, not of
# whatever the CI runner happens to have left. Its refusal is asserted directly
# against the host preflight further down.
sed -i 's/^required_free_mib=.*/required_free_mib=1/' "$tmp_dir/src/ai-agent-deploy"

{
  printf '%s %s %s\n' "$tmp_dir/src/docker-compose.yml" "$tmp_dir/opt/ai-agent/docker-compose.yml" 0644
  printf '%s %s %s\n' "$tmp_dir/src/ai-agent-deploy" "$tmp_dir/sbin/ai-agent-deploy" 0755
  printf '%s %s %s\n' "$tmp_dir/src/ai-agent-deploy-dispatch" "$tmp_dir/sbin/ai-agent-deploy-dispatch" 0755
  printf '%s %s %s\n' "$tmp_dir/src/runtime-preflight.sh" "$tmp_dir/sbin/ai-agent-runtime-preflight" 0755
  printf '%s %s %s\n' "$tmp_dir/src/host-preflight.sh" "$tmp_dir/sbin/ai-agent-host-preflight" 0755
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
  ops/lightsail/install-host-bundle.sh >"$tmp_dir/install"
chmod +x "$tmp_dir/install"

cat >"$tmp_dir/bin/visudo" <<'SH'
#!/bin/sh
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
      *) printf '<no value>\n'; exit 0 ;;
    esac
    case $image in
      *"/backend-migration@"*) image_key=backend-migration ;;
      *"/backend@"*) image_key=backend ;;
      *"/web@"*) image_key=web ;;
      *"/platform@"*) image_key=platform ;;
      *) image_key=unknown ;;
    esac
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
[ "$(grep -c '^file ' "$manifest")" -eq 6 ] ||
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

refuses() {
  description=$1
  shift
  before=$(grep -c 'run --rm migrate' "$TEST_LOG" || true)
  if "$@" >"$tmp_dir/out" 2>&1; then
    fail "deployment was accepted despite $description"
  fi
  after=$(grep -c 'run --rm migrate' "$TEST_LOG" || true)
  [ "$after" = "$before" ] || fail "migrations ran despite $description"
  grep -Eq 'rejected|failed' "$tmp_dir/out" ||
    fail "refusal for $description did not explain itself"
}

# The happy path first, so every refusal below is known to be caused by the one
# thing the case changes.
attempt_deploy >/dev/null
[ "$(grep -c 'run --rm migrate' "$TEST_LOG")" -eq 1 ] ||
  fail 'a satisfied host did not reach migrations'
grep -Fq "\"sha\":\"$release_sha\"" "$tmp_dir/state/CURRENT_RELEASE.json" ||
  fail 'a successful deployment recorded no release manifest'

# Staging failure 1: the installed compose file predated the release.
cp "$tmp_dir/opt/ai-agent/docker-compose.yml" "$tmp_dir/compose.saved"
printf '\n# hand-edited on the host\n' >>"$tmp_dir/opt/ai-agent/docker-compose.yml"
refuses 'a compose file that no longer matches the recorded bundle' attempt_deploy
cp "$tmp_dir/compose.saved" "$tmp_dir/opt/ai-agent/docker-compose.yml"
attempt_deploy >/dev/null

# Staging failure 2: the deploy script itself was older than the release.
cp "$deploy" "$tmp_dir/deploy.saved"
printf '\n# hand-edited on the host\n' >>"$deploy"
refuses 'a deploy script that no longer matches the recorded bundle' attempt_deploy
cp "$tmp_dir/deploy.saved" "$deploy"

# A recorded file that has been made writable by others is as much a bundle
# mismatch as an edited one.
chmod 0777 "$tmp_dir/opt/ai-agent/docker-compose.yml"
refuses 'an installed bundle file with the wrong mode' attempt_deploy
chmod 0644 "$tmp_dir/opt/ai-agent/docker-compose.yml"

# Staging failure 3: the image had no pgvector, and the migration container was
# the first thing to find out.
printf '0\n' >"$control/pg_extension_count"
refuses 'a PostgreSQL image without the required extension' attempt_deploy
printf '1\n' >"$control/pg_extension_count"

# Staging failure 4: APP_ENCRYPTION_KEY was absent, and the backend refused to
# boot after migrations had already been applied.
cp "$tmp_dir/etc/ai-agent/runtime.env" "$tmp_dir/runtime.saved"
grep -v '^APP_ENCRYPTION_KEY=' "$tmp_dir/runtime.saved" >"$tmp_dir/etc/ai-agent/runtime.env"
refuses 'a runtime environment with no encryption key' attempt_deploy
cp "$tmp_dir/runtime.saved" "$tmp_dir/etc/ai-agent/runtime.env"

# The release requires a newer bundle than the host has recorded.
printf '%s\n' "$((bundle_minimum + 1))" >"$control/label.min-version"
refuses 'a release that requires a newer host bundle' attempt_deploy
printf '%s\n' "$bundle_minimum" >"$control/label.min-version"

# Four immutable digests that do not belong to one release.
printf '2222222222222222222222222222222222222222\n' >"$control/label.release-sha.platform"
refuses 'an image that belongs to a different release' attempt_deploy
rm -f "$control/label.release-sha.platform"

# One image built from a tree that declared a different host requirement.
printf '%s\n' "$((bundle_minimum + 1))" >"$control/label.min-version.web"
refuses 'release images that disagree on the host requirement' attempt_deploy
rm -f "$control/label.min-version.web"

# An unlabelled image cannot state what it needs, so it cannot be accepted.
printf '<no value>\n' >"$control/label.min-version"
refuses 'a release that declares no host requirement' attempt_deploy
printf '%s\n' "$bundle_minimum" >"$control/label.min-version"

# The compose file resolving a mutable tag instead of the pinned digest is how a
# release silently becomes whatever the registry currently points at.
cp "$control/compose_images" "$tmp_dir/images.saved"
sed "s#$registry/web@sha256:$web_digest#$registry/web:$release_sha#" \
  "$tmp_dir/images.saved" >"$control/compose_images"
refuses 'a compose file that resolves a mutable application tag' attempt_deploy
cp "$tmp_dir/images.saved" "$control/compose_images"

# A manifest that simply omits the release-coupled files must not verify.
cp "$manifest" "$tmp_dir/manifest.saved"
grep -v 'docker-compose.yml' "$tmp_dir/manifest.saved" >"$manifest"
refuses 'a manifest that does not cover the installed compose file' attempt_deploy
cp "$tmp_dir/manifest.saved" "$manifest"

# No recorded bundle at all: the host cannot claim to satisfy anything.
mv "$manifest" "$tmp_dir/manifest.absent"
refuses 'a host with no recorded bundle' attempt_deploy
mv "$tmp_dir/manifest.absent" "$manifest"

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
