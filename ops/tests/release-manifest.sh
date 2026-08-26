#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
mkdir -p "$tmp_dir/bin" "$tmp_dir/opt/ai-agent" "$tmp_dir/etc/ai-agent" "$tmp_dir/state"
touch "$tmp_dir/opt/ai-agent/docker-compose.yml" "$tmp_dir/etc/ai-agent/runtime.env"
printf 'production\n' >"$tmp_dir/etc/ai-agent/environment"

sed \
  -e "s#/opt/ai-agent#$tmp_dir/opt/ai-agent#g" \
  -e "s#/etc/ai-agent#$tmp_dir/etc/ai-agent#g" \
  -e "s#/var/lib/ai-agent#$tmp_dir/state#g" \
  -e "s#/usr/local/sbin/ai-agent-runtime-preflight#$tmp_dir/bin/preflight#g" \
  -e "s#/usr/local/sbin/ai-agent-host-preflight#$tmp_dir/bin/host-preflight#g" \
  ops/lightsail/ai-agent-deploy >"$tmp_dir/deploy"
chmod +x "$tmp_dir/deploy"

cat >"$tmp_dir/bin/preflight" <<'SH'
#!/bin/sh
exit 0
SH
# The host-bundle and release-declaration gates have their own reproductions in
# ops/tests/host-bundle.sh. Here they are satisfied cheaply, so that what this
# test proves stays what it is about: manifest rotation and digest immutability.
cat >"$tmp_dir/bin/host-preflight" <<'SH'
#!/bin/sh
exit 0
SH
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

grep -Fq "\"sha\":\"$sha_two\"" "$tmp_dir/state/CURRENT_RELEASE.json"
grep -Fq "\"backend\":\"sha256:$backend_one\"" "$tmp_dir/state/PREVIOUS_RELEASE.json"
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq 2

printf '%s\n' "$sha_one" >"$TEST_SHA_FILE"
"$tmp_dir/deploy" rollback production

grep -Fq "\"sha\":\"$sha_one\"" "$tmp_dir/state/CURRENT_RELEASE.json"
grep -Fq "\"backend\":\"sha256:$backend_two\"" "$tmp_dir/state/PREVIOUS_RELEASE.json"
grep -Fq "ghcr.io/adnanalmahmut/ai-agent/backend@sha256:$backend_one|ghcr.io/adnanalmahmut/ai-agent/backend-migration@sha256:$migration_one|ghcr.io/adnanalmahmut/ai-agent/web@sha256:$web_one|ghcr.io/adnanalmahmut/ai-agent/platform@sha256:$platform_one" "$TEST_LOG"
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq 2

if grep -Eq 'ai-agent/(backend|backend-migration|web|platform):[0-9a-f]{40}' "$TEST_LOG"; then
  echo 'rollback resolved a mutable SHA tag' >&2
  exit 1
fi

echo 'immutable release manifest and rollback invariants: ok'
