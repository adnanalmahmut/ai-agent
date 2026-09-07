#!/bin/sh
set -eu

# The administrative surface's ingress restriction, proven against real Nginx.
#
# The claim is narrow and worth being exact about: on staging, `/admin` and
# everything under it -- pages, assets, and the auth forwarder -- is reachable
# only from an allowlisted client address, and nothing an unallowlisted client
# can put in a header changes that. That is a statement about how Nginx
# evaluates `allow`/`deny` against the connection it is serving, so asserting
# it by reading the template would only restate the template.
#
# So this runs the real installer -- infra/gateway/nginx/install-nginx.sh,
# unmodified, as root inside the container -- against a real Nginx with a real
# certificate and stub upstreams, and asks it questions over HTTPS. `systemctl`
# is the one thing stubbed, because the image has no init; it performs the same
# reload the unit would.
#
# Nothing on this machine is touched: the container gets its own /etc/ai-agent,
# its own /etc/letsencrypt, and its own /etc/nginx. The certificate is
# generated into a temporary directory and deleted with it, and the domain
# resolves nowhere.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

command -v docker >/dev/null 2>&1 || {
  echo 'docker unavailable: administrative ingress checks skipped'
  exit 0
}
command -v openssl >/dev/null 2>&1 || {
  echo 'openssl is required for the administrative ingress checks' >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo 'curl is required for the administrative ingress checks' >&2
  exit 1
}

installer=infra/gateway/nginx/install-nginx.sh
for required in "$installer" \
  infra/gateway/nginx/templates/admin-route.conf.template \
  infra/gateway/nginx/templates/proxy-routes.conf.template \
  infra/gateway/nginx/templates/site-http.conf.template \
  infra/gateway/nginx/templates/site-https.conf.template \
  infra/gateway/nginx/snippets/proxy-common.conf; do
  [ -f "$required" ] || {
    echo "missing gateway asset: $required" >&2
    exit 1
  }
done

DOMAIN=admin.ingress.test
PORT=${GATEWAY_ADMIN_PORT:-44543}
HTTP_PORT=${GATEWAY_ADMIN_HTTP_PORT:-44580}
CONTAINER=ai-agent-gateway-admin-$$

# The ports the installer is told the applications are on, matching the
# repository's own assignments: backend 3002, platform 3001, web 3000,
# admin 3003. The stubs listen on the same numbers inside the container.
BACKEND_PORT=3002
PLATFORM_PORT=3001
WEB_PORT=3000
ADMIN_PORT=3003

tmp_dir=$(mktemp -d)
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "administrative ingress check failed: $1" >&2
  [ ! -s "$tmp_dir/install.log" ] || {
    echo '--- last installer run:' >&2
    tail -20 "$tmp_dir/install.log" >&2
  }
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2 || true
  exit 1
}

# --- an ephemeral certificate, never a committed one ------------------------
cat >"$tmp_dir/openssl.cnf" <<CONF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $DOMAIN
[ext]
subjectAltName = DNS:$DOMAIN
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
CONF

mkdir -p "$tmp_dir/letsencrypt/live/$DOMAIN" "$tmp_dir/ai-agent" "$tmp_dir/bin" \
  "$tmp_dir/conf.d"

openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$tmp_dir/letsencrypt/live/$DOMAIN/privkey.pem" \
  -out "$tmp_dir/letsencrypt/live/$DOMAIN/fullchain.pem" \
  -config "$tmp_dir/openssl.cnf" >/dev/null 2>&1 ||
  fail 'could not generate the ephemeral test certificate'

# The two assets site-https.conf.template includes. On a host these come from
# the certbot package; here they only have to exist and parse.
cat >"$tmp_dir/letsencrypt/options-ssl-nginx.conf" <<'CONF'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
CONF
# 2048 because OpenSSL 3 refuses anything smaller at handshake time, which
# would present as a working configuration that serves nothing.
openssl dhparam -out "$tmp_dir/letsencrypt/ssl-dhparams.pem" 2048 >/dev/null 2>&1 ||
  fail 'could not generate ephemeral DH parameters'

# --- the host's own configuration ------------------------------------------
printf 'staging\n' >"$tmp_dir/ai-agent/environment"

# --- what the installer expects to find on a host --------------------------
cat >"$tmp_dir/bin/systemctl" <<'STUB'
#!/bin/sh
# The image has no init. The reload is real; only the way it is asked for is
# stubbed, so what the installer does to a running Nginx is what is tested.
[ "$1" = reload ] || exit 0
exec nginx -s reload
STUB
chmod +x "$tmp_dir/bin/systemctl"

# The site the installer writes goes to sites-enabled, which the official image
# does not include. Everything else here stands in for the four applications:
# each answers with its own name, so a routing mistake reads as the wrong
# surface rather than as a failure.
cat >"$tmp_dir/conf.d/harness.conf" <<CONF
include /etc/nginx/sites-enabled/*;

server {
    listen 127.0.0.1:$WEB_PORT;
    location / {
        default_type text/plain;
        return 200 "surface=web path=\$request_uri\n";
    }
}

server {
    listen 127.0.0.1:$PLATFORM_PORT;
    location / {
        default_type text/plain;
        return 200 "surface=platform path=\$request_uri\n";
    }
}

server {
    listen 127.0.0.1:$BACKEND_PORT;
    location / {
        default_type text/plain;
        return 200 "surface=backend path=\$request_uri\n";
    }
}

server {
    listen 127.0.0.1:$ADMIN_PORT;
    location / {
        default_type text/plain;
        return 200 "surface=admin path=\$request_uri forwarded_for=\$http_x_forwarded_for real_ip=\$http_x_real_ip\n";
    }
}
CONF

docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:$PORT:443" \
  -p "127.0.0.1:$HTTP_PORT:80" \
  -v "$root/infra/gateway:/repo/infra/gateway:ro" \
  -v "$tmp_dir/conf.d/harness.conf:/etc/nginx/conf.d/harness.conf:ro" \
  -v "$tmp_dir/letsencrypt:/etc/letsencrypt" \
  -v "$tmp_dir/ai-agent:/etc/ai-agent" \
  -v "$tmp_dir/bin/systemctl:/usr/local/bin/systemctl:ro" \
  nginx:1.29-alpine >/dev/null 2>&1 ||
  fail 'could not start the gateway container'

attempts=0
until docker exec "$CONTAINER" true >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 30 ] || fail 'the gateway container never became usable'
  sleep 1
done

# --- driving the real installer --------------------------------------------
# The worker processes serving requests right now.
#
# `nginx -s reload` returns immediately and the workers holding the previous
# configuration keep accepting connections until they have finished shutting
# down, so a request made in between is answered by the configuration that was
# just replaced. Waiting for every one of them to be gone is what makes an
# assertion below about the configuration that was just installed, rather than
# about whichever worker happened to accept.
worker_pids() {
  docker exec "$CONTAINER" sh -c \
    "ps -o pid,args | grep '[n]ginx: worker' | awk '{ print \$1 }' | sort | tr '\n' ' '"
}

# Output is captured rather than shown: several phases below expect a refusal,
# and a refusal printing its reason every time would bury the one that matters.
# `fail` prints the last run's log.
install_gateway() {
  before=$(worker_pids)

  docker exec "$CONTAINER" sh "/repo/$installer" "$DOMAIN" \
    "$BACKEND_PORT" "$PLATFORM_PORT" "$WEB_PORT" "$@" \
    >"$tmp_dir/install.log" 2>&1 || return 1

  waited=0
  while :; do
    current=$(worker_pids)
    superseded=0
    for pid in $before; do
      case " $current " in
        *" $pid "*) superseded=1 ;;
      esac
    done
    [ "$superseded" -eq 1 ] || break

    waited=$((waited + 1))
    [ "$waited" -lt 60 ] ||
      fail 'the gateway never finished reloading the installed configuration'
    sleep 0.25
  done

  return 0
}

write_allowlist() {
  : >"$tmp_dir/ai-agent/admin-staging-allowed-cidrs"
  for entry in "$@"; do
    printf '%s\n' "$entry" >>"$tmp_dir/ai-agent/admin-staging-allowed-cidrs"
  done
}

# The client address Nginx sees is the container's view of this machine: a
# docker bridge gateway or loopback, depending on how the published port is
# implemented. Allowing every private and loopback range covers both without
# the test having to discover which -- and none of them is "everyone", which
# the installer would refuse.
LOCAL_RANGES='10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
127.0.0.0/8
::1/128
fc00::/7'

status_of() {
  path=$1
  shift
  curl --silent --output /dev/null --cacert "$tmp_dir/letsencrypt/live/$DOMAIN/fullchain.pem" \
    --resolve "$DOMAIN:$PORT:127.0.0.1" --write-out '%{http_code}' \
    "$@" "https://$DOMAIN:$PORT$path"
}

body_of() {
  path=$1
  shift
  curl --silent --show-error --cacert "$tmp_dir/letsencrypt/live/$DOMAIN/fullchain.pem" \
    --resolve "$DOMAIN:$PORT:127.0.0.1" \
    "$@" "https://$DOMAIN:$PORT$path"
}

expect_status() {
  actual=$(status_of "$1" ${3:+--header} ${3:+"$3"} ${4:+--header} ${4:+"$4"})
  [ "$actual" = "$2" ] || fail "$1 answered $actual, expected $2"
}

expect_surface() {
  actual=$(body_of "$1")
  printf '%s' "$actual" | grep -Fq "surface=$2" ||
    fail "$1 did not reach the $2 surface: $actual"
}

# Asserted in every phase: whatever the administrative route is doing, the
# three surfaces that were already served must be unaffected.
expect_other_surfaces_unchanged() {
  expect_surface / web
  expect_surface /platform/ platform
  expect_surface /api/health/ready backend
}

# --- phase 1: no allowlist at all ------------------------------------------
# The route is installed and refuses everybody. This is the state a host is in
# the moment the surface is activated and before an operator has said who may
# reach it, and it is the one that must not be "reachable by default".
rm -f "$tmp_dir/ai-agent/admin-staging-allowed-cidrs"
install_gateway "$ADMIN_PORT" ||
  fail 'the installer refused a staging host with no allowlist configured'

for path in /admin /admin/ /admin/ar/login /admin/_next/static/chunk.js \
  /admin/api/auth/get-session /admin/health; do
  expect_status "$path" 403
done
expect_other_surfaces_unchanged

# --- phase 2: an allowlist this client is in -------------------------------
write_allowlist $LOCAL_RANGES
install_gateway "$ADMIN_PORT" ||
  fail 'the installer refused a valid allowlist'

for path in /admin /admin/ /admin/ar/login /admin/_next/static/chunk.js \
  /admin/api/auth/get-session /admin/health; do
  expect_status "$path" 200
done
expect_surface /admin/ar/login admin
# The whole point of a base path: the administrative surface is reached as
# itself and the public site is not asked to serve it.
body_of /admin/ar/login | grep -Fq 'path=/admin/ar/login' ||
  fail 'the administrative surface was not given the path the browser asked for'
expect_other_surfaces_unchanged

# --- phase 3: an allowlist this client is not in ---------------------------
write_allowlist '203.0.113.0/24' '198.51.100.8/32'
install_gateway "$ADMIN_PORT" ||
  fail 'the installer refused a valid allowlist of documentation ranges'

for path in /admin /admin/ /admin/ar/login /admin/_next/static/chunk.js \
  /admin/api/auth/get-session /admin/health; do
  expect_status "$path" 403
done

# ...and no header a client sends changes that. Nginx matches on the connection
# it is serving; the forwarded headers are set by the gateway for the upstream's
# benefit and are never read back as the client's identity. If this ever
# started passing, an allowlist would be a suggestion.
for header in 'X-Forwarded-For: 203.0.113.8' 'X-Real-IP: 203.0.113.8' \
  'X-Forwarded-For: 203.0.113.8, 198.51.100.8' 'X-Original-Forwarded-For: 203.0.113.8' \
  'X-Client-IP: 203.0.113.8' 'Forwarded: for=203.0.113.8'; do
  spoofed=$(status_of /admin/ar/login --header "$header")
  [ "$spoofed" = 403 ] ||
    fail "a client claiming an allowlisted address through '$header' was admitted ($spoofed)"
done
expect_other_surfaces_unchanged

# --- phase 4: an allowlist that cannot be honoured -------------------------
# A refusal has to leave the gateway as it was. The configuration in force is
# still phase 3's, so the surface stays closed rather than reverting to
# whatever a half-written file would have meant.
for rejected in '0.0.0.0/0' '0.0.0.0/8' '::/0' '203.0.113.0/0' 'not-an-address' \
  '203.0.113.8/33' '203.0.113.999/32' '*' '203.0.113.0/24 203.0.113.1/32' \
  'allow all;' '203.0.113.8; allow all' 'fc00::' '::1'; do
  write_allowlist "$rejected"
  if install_gateway "$ADMIN_PORT"; then
    fail "the installer accepted an allowlist entry it must refuse: $rejected"
  fi
  expect_status /admin/ar/login 403
  expect_other_surfaces_unchanged
done

# A comment and a blank line are not entries, and a file of nothing but those
# is the same as no file: installed, and closed.
printf '# my laptop\n\n   \n' >"$tmp_dir/ai-agent/admin-staging-allowed-cidrs"
install_gateway "$ADMIN_PORT" ||
  fail 'the installer refused a commented-out allowlist'
expect_status /admin/ar/login 403

# --- phase 5: a host that is not staging -----------------------------------
printf 'production\n' >"$tmp_dir/ai-agent/environment"
write_allowlist $LOCAL_RANGES
if install_gateway "$ADMIN_PORT"; then
  fail 'the installer added the administrative route to a production host'
fi

# And with no administrative port at all -- which is what a production host
# installs -- there is no such route. `/admin` is then just a path on the
# public site, which does not serve the administrative surface.
install_gateway ||
  fail 'the installer refused a host with no administrative surface'
expect_surface /admin/ar/login web
docker exec "$CONTAINER" grep -Fq 'proxy_pass http://127.0.0.1:3003' \
  /etc/nginx/ai-agent-proxy-routes.conf 2>/dev/null &&
  fail 'a host with no administrative surface still routes to one'
docker exec "$CONTAINER" test -f /etc/nginx/ai-agent-admin-ingress.conf &&
  fail 'the administrative allowlist fragment outlived the route that included it'
expect_other_surfaces_unchanged

# --- and the parts of the gateway that must not have moved -----------------
# Certificate renewal answers over plain HTTP and must not have been caught by
# any of the above.
acme=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --resolve "$DOMAIN:$HTTP_PORT:127.0.0.1" \
  "http://$DOMAIN:$HTTP_PORT/.well-known/acme-challenge/probe")
[ "$acme" = 404 ] ||
  fail "the ACME challenge path answered $acme rather than serving the webroot"

redirect=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --resolve "$DOMAIN:$HTTP_PORT:127.0.0.1" "http://$DOMAIN:$HTTP_PORT/platform/")
[ "$redirect" = 301 ] || fail "plain HTTP answered $redirect rather than redirecting"

echo 'administrative ingress restriction over HTTPS: ok'
