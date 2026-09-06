#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
mkdir -p "$tmp_dir/bin" "$tmp_dir/opt/ai-agent" "$tmp_dir/etc/ai-agent" "$tmp_dir/state"
touch "$tmp_dir/opt/ai-agent/docker-compose.yml" \
  "$tmp_dir/opt/ai-agent/docker-compose.deploy.yml" \
  "$tmp_dir/etc/ai-agent/runtime.env"
printf 'production\n' >"$tmp_dir/etc/ai-agent/environment"

sed \
  -e "s#/opt/ai-agent#$tmp_dir/opt/ai-agent#g" \
  -e "s#/etc/ai-agent#$tmp_dir/etc/ai-agent#g" \
  -e "s#/var/lib/ai-agent#$tmp_dir/state#g" \
  -e "s#/usr/local/sbin/ai-agent-runtime-preflight#$tmp_dir/bin/preflight#g" \
  -e "s#/usr/local/sbin/ai-agent-host-preflight#$tmp_dir/bin/host-preflight#g" \
  -e "s#/usr/local/sbin/ai-agent-release-retention#$tmp_dir/bin/retention#g" \
  infra/deploy/ai-agent-deploy >"$tmp_dir/deploy"
chmod +x "$tmp_dir/deploy"

cat >"$tmp_dir/bin/preflight" <<'SH'
#!/bin/sh
exit 0
SH
# The host-bundle and release-declaration gates have their own reproductions in
# infra/tests/host-bundle.sh. Here they are satisfied cheaply, so that what this
# test proves stays what it is about: manifest rotation and digest immutability.
cat >"$tmp_dir/bin/host-preflight" <<'SH'
#!/bin/sh
exit 0
SH
# Retention runs after a successful rotation and has its own reproduction in
# infra/tests/release-retention.sh, plus its deployment wiring in
# infra/tests/host-bundle.sh. Satisfied cheaply here for the same reason as above.
cat >"$tmp_dir/bin/retention" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$tmp_dir/bin/retention"
cat >"$tmp_dir/bin/docker" <<'SH'
#!/bin/sh
set -eu
printf '%s|%s|%s|%s|%s\n' \
  "${BACKEND_IMAGE:-}" "${BACKEND_MIGRATION_IMAGE:-}" \
  "${WEB_IMAGE:-}" "${PLATFORM_IMAGE:-}" "$*" >>"$TEST_LOG"

# The release SHA the deploy script is asking about, written by the test before
# each invocation: a digest does not encode the release it came from, which is
# the whole reason the deploy script reads it off a label instead.
if [ "${1:-}" = image ]; then
  for argument in "$@"; do
    case $argument in *host-bundle.min-version*) printf '1\n'; exit 0 ;; esac
  done
  # The component each image claims to be. Derived from the reference so the
  # stub answers correctly without a table; a test that needs a mismatch
  # overrides it explicitly.
  for argument in "$@"; do
    case $argument in *io.ai-agent.component.name*) format_component=yes ;; esac
    image=$argument
  done
  if [ "${format_component:-no}" = yes ]; then
    if [ -n "${COMPONENT_LABEL_OVERRIDE:-}" ]; then
      printf '%s\n' "$COMPONENT_LABEL_OVERRIDE"
      exit 0
    fi
    case $image in
      *"/backend-migration@"*) printf 'backend-migration\n' ;;
      *"/backend@"*) printf 'backend\n' ;;
      *"/web@"*) printf 'web\n' ;;
      *"/platform@"*) printf 'platform\n' ;;
      *) printf '<no value>\n' ;;
    esac
    exit 0
  fi
  sed -n '1p' "$TEST_SHA_FILE"
  exit 0
fi

case " $* " in
  *' config --images '*)
    printf '%s\n' "$BACKEND_IMAGE" "$BACKEND_MIGRATION_IMAGE" "$WEB_IMAGE" "$PLATFORM_IMAGE"
    ;;
  *' exec -T postgres '*)
    printf '1\n'
    ;;
  *' ps --status running --services '*)
    service=
    for argument in "$@"; do service=$argument; done
    printf '%s\n' "$service"
    ;;
esac
SH
cat >"$tmp_dir/bin/curl" <<'SH'
#!/bin/sh
exit 0
SH
cat >"$tmp_dir/bin/flock" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$tmp_dir/bin/preflight" "$tmp_dir/bin/docker" "$tmp_dir/bin/curl" "$tmp_dir/bin/flock"

chmod +x "$tmp_dir/bin/host-preflight"

export PATH="$tmp_dir/bin:$PATH"
export TEST_LOG=$tmp_dir/commands.log
export TEST_SHA_FILE=$tmp_dir/release-sha

sha_one=1111111111111111111111111111111111111111
sha_two=2222222222222222222222222222222222222222
backend_one=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
migration_one=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
web_one=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
platform_one=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
backend_two=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
migration_two=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
web_two=abababababababababababababababababababababababababababababababab
platform_two=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd

printf '%s\n' "$sha_one" >"$TEST_SHA_FILE"
"$tmp_dir/deploy" deploy production "$sha_one" "$backend_one" "$migration_one" "$web_one" "$platform_one"
printf '%s\n' "$sha_two" >"$TEST_SHA_FILE"
"$tmp_dir/deploy" deploy production "$sha_two" "$backend_two" "$migration_two" "$web_two" "$platform_two"

current=$tmp_dir/state/CURRENT_RELEASE.json
previous=$tmp_dir/state/PREVIOUS_RELEASE.json

# The record the deploy script writes now is a component list, not one field per
# image. Read with jq rather than grepped, so the assertion is about the values
# and not about the byte order they were printed in.
component_digest() {
  jq -r --arg name "$2" '.components[] | select(.name == $name) | .digest' "$1"
}

test "$(jq -r .recordVersion "$current")" = 1
test "$(jq -r .sha "$current")" = "$sha_two"
test "$(component_digest "$current" backend)" = "sha256:$backend_two"
test "$(component_digest "$current" backend-migration)" = "sha256:$migration_two"
test "$(component_digest "$current" web)" = "sha256:$web_two"
test "$(component_digest "$current" platform)" = "sha256:$platform_two"
# Named by component, so the field that used to be called `migration` is gone
# from anything newly written.
test "$(jq -r '[.components[].name] | sort | join(",")' "$current")" \
  = 'backend,backend-migration,platform,web'
jq -e 'has("migration") | not' "$current" >/dev/null

test "$(jq -r .sha "$previous")" = "$sha_one"
test "$(component_digest "$previous" backend)" = "sha256:$backend_one"
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq 2

printf '%s\n' "$sha_one" >"$TEST_SHA_FILE"
"$tmp_dir/deploy" rollback production

test "$(jq -r .sha "$current")" = "$sha_one"
test "$(component_digest "$current" backend)" = "sha256:$backend_one"
test "$(component_digest "$previous" backend)" = "sha256:$backend_two"
grep -Fq "ghcr.io/adnanalmahmut/ai-agent/backend@sha256:$backend_one|ghcr.io/adnanalmahmut/ai-agent/backend-migration@sha256:$migration_one|ghcr.io/adnanalmahmut/ai-agent/web@sha256:$web_one|ghcr.io/adnanalmahmut/ai-agent/platform@sha256:$platform_one" "$TEST_LOG"
# Rollback is incident response and runs no migration. Still two, from the two
# deployments above.
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq 2

if grep -Eq 'ai-agent/(backend|backend-migration|web|platform):[0-9a-f]{40}' "$TEST_LOG"; then
  echo 'rollback resolved a mutable SHA tag' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The records already on hosts
# ---------------------------------------------------------------------------

# A host that has been deploying for months has flat records written by an older
# bundle, and the bundle carrying the component list lands on top of them. If
# rollback could not read what is already on disk, installing the new bundle
# would quietly cost the host its only way back — which is exactly the moment it
# is most likely to be needed.
cat >"$previous" <<LEGACY
{"sha":"$sha_two","backend":"sha256:$backend_two","migration":"sha256:$migration_two","web":"sha256:$web_two","platform":"sha256:$platform_two"}
LEGACY

before=$(grep -c ' run --rm migrate' "$TEST_LOG")
printf '%s\n' "$sha_two" >"$TEST_SHA_FILE"
"$tmp_dir/deploy" rollback production

test "$(jq -r .sha "$current")" = "$sha_two"
test "$(component_digest "$current" backend)" = "sha256:$backend_two"
grep -Fq "ghcr.io/adnanalmahmut/ai-agent/backend@sha256:$backend_two|ghcr.io/adnanalmahmut/ai-agent/backend-migration@sha256:$migration_two|ghcr.io/adnanalmahmut/ai-agent/web@sha256:$web_two|ghcr.io/adnanalmahmut/ai-agent/platform@sha256:$platform_two" "$TEST_LOG"
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq "$before"

# ...and a record that old points at images published before the component label
# existed. A bundle that demanded the label from every image it verifies would
# refuse to roll back to any of them, which turns installing the bundle into
# losing the way back. A release carrying no component label is read as the
# legacy release it is; one carrying the label is still held to it, and one
# carrying it on only part of itself is refused
# (infra/tests/host-bundle.sh covers both of those).
cat >"$previous" <<LEGACY
{"sha":"$sha_one","backend":"sha256:$backend_one","migration":"sha256:$migration_one","web":"sha256:$web_one","platform":"sha256:$platform_one"}
LEGACY

before=$(grep -c ' run --rm migrate' "$TEST_LOG")
printf '%s\n' "$sha_one" >"$TEST_SHA_FILE"
COMPONENT_LABEL_OVERRIDE='<no value>' "$tmp_dir/deploy" rollback production

test "$(jq -r .sha "$current")" = "$sha_one"
test "$(component_digest "$current" backend)" = "sha256:$backend_one"
grep -Fq "ghcr.io/adnanalmahmut/ai-agent/backend@sha256:$backend_one|ghcr.io/adnanalmahmut/ai-agent/backend-migration@sha256:$migration_one|ghcr.io/adnanalmahmut/ai-agent/web@sha256:$web_one|ghcr.io/adnanalmahmut/ai-agent/platform@sha256:$platform_one" "$TEST_LOG"
# Still no migration: a legacy rollback is a rollback.
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq "$before"

# A record missing a component is a refusal in either shape. Rollback that
# guesses at a missing image turns one incident into two.
# The release SHA the images claim is set to the one the record asks for, so the
# only thing left that can refuse is the defect in the record. Without that the
# label check refuses first and these cases pass for the wrong reason -- which
# is what they did until a mutation showed the missing-component refusal could
# be deleted with the suite still green.
refuses_rollback() {
  description=$1
  record_sha=$2

  printf '%s\n' "$record_sha" >"$TEST_SHA_FILE"
  if "$tmp_dir/deploy" rollback production >/dev/null 2>&1; then
    echo "rollback accepted $description" >&2
    exit 1
  fi
}

cat >"$previous" <<TRUNCATED
{"sha":"$sha_one","backend":"sha256:$backend_one","migration":"sha256:$migration_one","web":"sha256:$web_one"}
TRUNCATED
refuses_rollback 'a legacy record with no platform image' "$sha_one"

cat >"$previous" <<TRUNCATED
{"recordVersion":1,"sha":"$sha_one","components":[{"name":"backend","digest":"sha256:$backend_one"},{"name":"web","digest":"sha256:$web_one"}]}
TRUNCATED
refuses_rollback 'a component record missing required components' "$sha_one"

cat >"$previous" <<MALFORMED
{"recordVersion":1,"sha":"$sha_one","components":[{"name":"backend","digest":"sha256:short"},{"name":"backend-migration","digest":"sha256:$migration_one"},{"name":"web","digest":"sha256:$web_one"},{"name":"platform","digest":"sha256:$platform_one"}]}
MALFORMED
refuses_rollback 'a component record with a malformed digest' "$sha_one"

cat >"$previous" <<MALFORMED
{"recordVersion":1,"sha":"nope","components":[{"name":"backend","digest":"sha256:$backend_one"},{"name":"backend-migration","digest":"sha256:$migration_one"},{"name":"web","digest":"sha256:$web_one"},{"name":"platform","digest":"sha256:$platform_one"}]}
MALFORMED
refuses_rollback 'a component record with a malformed release SHA' "$sha_one"

echo 'immutable release manifest and rollback invariants: ok'
