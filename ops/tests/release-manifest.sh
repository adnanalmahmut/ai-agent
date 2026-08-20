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
  ops/lightsail/ai-agent-deploy >"$tmp_dir/deploy"
chmod +x "$tmp_dir/deploy"

cat >"$tmp_dir/bin/preflight" <<'SH'
#!/bin/sh
exit 0
SH
cat >"$tmp_dir/bin/docker" <<'SH'
#!/bin/sh
set -eu
printf '%s|%s|%s|%s|%s\n' \
  "${BACKEND_IMAGE:-}" "${BACKEND_MIGRATION_IMAGE:-}" \
  "${WEB_IMAGE:-}" "${PLATFORM_IMAGE:-}" "$*" >>"$TEST_LOG"
case " $* " in
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

export PATH="$tmp_dir/bin:$PATH"
export TEST_LOG=$tmp_dir/commands.log

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

"$tmp_dir/deploy" deploy production "$sha_one" "$backend_one" "$migration_one" "$web_one" "$platform_one"
"$tmp_dir/deploy" deploy production "$sha_two" "$backend_two" "$migration_two" "$web_two" "$platform_two"

grep -Fq "\"sha\":\"$sha_two\"" "$tmp_dir/state/CURRENT_RELEASE.json"
grep -Fq "\"backend\":\"sha256:$backend_one\"" "$tmp_dir/state/PREVIOUS_RELEASE.json"
test "$(grep -c ' run --rm migrate' "$TEST_LOG")" -eq 2

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
