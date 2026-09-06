#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -r "$test_root"' EXIT

readonly_root=$test_root/opt/ai-agent
config_root=$test_root/etc/ai-agent
state_dir=$test_root/var/lib/ai-agent
bin_dir=$test_root/bin
preflight=$test_root/usr/local/sbin/ai-agent-runtime-preflight
host_preflight=$test_root/usr/local/sbin/ai-agent-host-preflight
retention=$test_root/usr/local/sbin/ai-agent-release-retention
wrapper=$test_root/ai-agent-deploy
log_file=$test_root/deploy.log

mkdir -p "$readonly_root" "$config_root" "$state_dir" "$bin_dir" "$(dirname "$preflight")"
printf '%s\n' staging >"$config_root/environment"
: >"$config_root/runtime.env"
: >"$readonly_root/docker-compose.yml"
: >"$readonly_root/docker-compose.deploy.yml"

sed \
  -e "s#readonly_root=/opt/ai-agent#readonly_root=$readonly_root#" \
  -e "s#runtime_env=/etc/ai-agent/runtime.env#runtime_env=$config_root/runtime.env#" \
  -e "s#environment_file=/etc/ai-agent/environment#environment_file=$config_root/environment#" \
  -e "s#state_dir=/var/lib/ai-agent#state_dir=$state_dir#" \
  -e "s#preflight=/usr/local/sbin/ai-agent-runtime-preflight#preflight=$preflight#" \
  -e "s#host_preflight=/usr/local/sbin/ai-agent-host-preflight#host_preflight=$host_preflight#" \
  -e "s#retention=/usr/local/sbin/ai-agent-release-retention#retention=$retention#" \
  "$repo_root/infra/deploy/ai-agent-deploy" >"$wrapper"
chmod 0755 "$wrapper"

cat >"$preflight" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' preflight >>"$DEPLOY_TEST_LOG"
EOF
chmod 0755 "$preflight"

# The bundle and release-declaration gates are reproduced in
# infra/tests/host-bundle.sh. Satisfied here so this test keeps proving only what
# it is for: that a service which never comes up does not rotate the manifests.
cat >"$host_preflight" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "host-preflight $1" >>"$DEPLOY_TEST_LOG"
EOF
chmod 0755 "$host_preflight"

# Retention only runs after a successful deployment, which is the case this suite
# is specifically not about. Logged so the assertions below can show it does not
# run when a service never comes up.
cat >"$retention" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "retention $*" >>"$DEPLOY_TEST_LOG"
EOF
chmod 0755 "$retention"

cat >"$bin_dir/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$bin_dir/flock"

cat >"$bin_dir/curl" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' api-ready >>"$DEPLOY_TEST_LOG"
[ "${API_READY:-false}" = true ]
EOF
chmod 0755 "$bin_dir/curl"

cat >"$bin_dir/docker" <<'EOF'
#!/bin/sh
set -eu
if [ "${1:-}" = image ]; then
  for argument in "$@"; do
    case $argument in *host-bundle.min-version*) printf '1\n'; exit 0 ;; esac
  done
  printf '%s\n' "$RELEASE_SHA"
  exit 0
fi
[ "${1:-}" = compose ] || exit 70
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file|--env-file|--profile) shift 2 ;;
    *) break ;;
  esac
done

printf 'compose' >>"$DEPLOY_TEST_LOG"
for argument in "$@"; do printf ' %s' "$argument" >>"$DEPLOY_TEST_LOG"; done
printf '\n' >>"$DEPLOY_TEST_LOG"

case " $* " in
  *' config --images '*)
    printf '%s\n' "$BACKEND_IMAGE" "$BACKEND_MIGRATION_IMAGE" "$WEB_IMAGE" "$PLATFORM_IMAGE"
    exit 0
    ;;
  *' exec -T postgres '*)
    printf '1\n'
    exit 0
    ;;
esac

if [ "${1:-}" = ps ]; then
  service=
  for argument in "$@"; do service=$argument; done
  case " ${RUNNING_SERVICES:-} " in
    *" $service "*) printf '%s\n' "$service" ;;
  esac
fi
EOF
chmod 0755 "$bin_dir/docker"

sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
backend_digest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
migration_digest=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
web_digest=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
platform_digest=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
old_current='{"sha":"1111111111111111111111111111111111111111","backend":"sha256:1111111111111111111111111111111111111111111111111111111111111111","migration":"sha256:2222222222222222222222222222222222222222222222222222222222222222","web":"sha256:3333333333333333333333333333333333333333333333333333333333333333","platform":"sha256:4444444444444444444444444444444444444444444444444444444444444444"}'
old_previous='{"sha":"2222222222222222222222222222222222222222","backend":"sha256:5555555555555555555555555555555555555555555555555555555555555555","migration":"sha256:6666666666666666666666666666666666666666666666666666666666666666","web":"sha256:7777777777777777777777777777777777777777777777777777777777777777","platform":"sha256:8888888888888888888888888888888888888888888888888888888888888888"}'
current_release=$state_dir/CURRENT_RELEASE.json
previous_release=$state_dir/PREVIOUS_RELEASE.json

reset_state() {
  printf '%s\n' "$old_current" >"$current_release"
  printf '%s\n' "$old_previous" >"$previous_release"
  : >"$log_file"
}

deploy_with() {
  running_services=$1
  api_ready=$2
  DEPLOY_TEST_LOG=$log_file \
  RUNNING_SERVICES=$running_services \
  API_READY=$api_ready \
  RELEASE_SHA=$sha \
  PATH=$bin_dir:$PATH \
    "$wrapper" deploy staging "$sha" "$backend_digest" "$migration_digest" \
      "$web_digest" "$platform_digest"
}

assert_failed_without_rotation() {
  missing_service=$1
  running_services=$2
  reset_state
  if deploy_with "$running_services" true >/dev/null 2>&1; then
    echo "deployment unexpectedly succeeded without running $missing_service" >&2
    exit 1
  fi
  [ "$(sed -n '1p' "$current_release")" = "$old_current" ] || {
    echo "failed deployment replaced CURRENT_RELEASE for $missing_service" >&2
    exit 1
  }
  [ "$(sed -n '1p' "$previous_release")" = "$old_previous" ] || {
    echo "failed deployment rotated PREVIOUS_RELEASE for $missing_service" >&2
    exit 1
  }
  # Retention removes application images that are neither CURRENT nor PREVIOUS.
  # A deployment that never became healthy has pulled its images and rotated
  # nothing, so those images are unrecorded -- running retention here would make
  # the half-finished release its own deletion candidate.
  if grep -Fq 'retention ' "$log_file"; then
    echo "retention ran after a deployment that failed on $missing_service" >&2
    exit 1
  fi
}

assert_failed_without_rotation worker 'backend web platform'
assert_failed_without_rotation web 'backend worker platform'
assert_failed_without_rotation platform 'backend worker web'

reset_state
if deploy_with 'backend worker web platform' false >/dev/null 2>&1; then
  echo 'deployment unexpectedly succeeded when API readiness failed' >&2
  exit 1
fi
[ "$(sed -n '1p' "$current_release")" = "$old_current" ]
[ "$(sed -n '1p' "$previous_release")" = "$old_previous" ]
if grep -Fq 'retention ' "$log_file"; then
  echo 'retention ran after a deployment whose API readiness failed' >&2
  exit 1
fi

reset_state
deploy_with 'backend worker web platform' true >/dev/null
grep -Fq "\"sha\":\"$sha\"" "$current_release"
[ "$(sed -n '1p' "$previous_release")" = "$old_current" ]
# ...and on the success path it does run, after the rotation above.
grep -Fq 'retention reclaim-locked' "$log_file" || {
  echo 'a successful deployment did not run retention' >&2
  exit 1
}

for service in backend worker web platform; do
  grep -Fq "compose ps --status running --services $service" "$log_file"
done

# The refusals have to be reached before the migration container, or they are a
# diagnosis of a release that has already been half applied.
for gate in 'host-preflight integrity' 'host-preflight disk' preflight; do
  grep -Fq "$gate" "$log_file" || {
    echo "deployment did not run the $gate gate" >&2
    exit 1
  }
done
gate_line=$(grep -n 'host-preflight integrity' "$log_file" | head -1 | cut -d: -f1)
migrate_line=$(grep -n 'run --rm migrate' "$log_file" | head -1 | cut -d: -f1)
[ "$gate_line" -lt "$migrate_line" ] || {
  echo 'the host bundle gate ran after migrations' >&2
  exit 1
}

echo 'deployment service health gate: ok'
