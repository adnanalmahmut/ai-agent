#!/bin/sh
set -eu

# Cookie isolation between browser surfaces, proven over real HTTPS.
#
# The claim RF-19 rests on is that the customer application's session and the
# administrative one cannot reach each other, because the cookie is
# `__Host-`-prefixed and therefore host-only. That claim is about what a
# browser does with a `Set-Cookie` header, so asserting it in a unit test would
# only restate the header we wrote. This runs the actual gateway templates
# under nginx with a real certificate and lets curl's cookie engine — which
# implements the same host matching a browser does — decide where each cookie
# goes.
#
# The counterexample is the part that makes the rest mean anything: one surface
# also sets a cookie with `Domain=` covering the whole test domain, and that one
# is expected to leak. If it did not, "no cookie was sent" would be a statement
# about a broken fixture rather than about isolation.
#
# Everything is ephemeral: a certificate generated into a temporary directory
# that is deleted on exit, a container with no volumes, and a domain that
# resolves nowhere.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

command -v docker >/dev/null 2>&1 || {
  echo 'docker unavailable: gateway origin checks skipped'
  exit 0
}
command -v openssl >/dev/null 2>&1 || {
  echo 'openssl is required for the gateway origin checks' >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo 'curl is required for the gateway origin checks' >&2
  exit 1
}

templates=infra/gateway/nginx/templates/origins
snippet=infra/gateway/nginx/snippets/proxy-common.conf

for required in "$templates/surface.conf.template" \
  "$templates/redirect.conf.template" "$snippet"; do
  [ -f "$required" ] || {
    echo "missing gateway asset: $required" >&2
    exit 1
  }
done

DOMAIN=origins.test
PORT=${GATEWAY_ORIGINS_PORT:-44443}
CONTAINER=ai-agent-gateway-origins-$$

tmp_dir=$(mktemp -d)
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "gateway origin check failed: $1" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2 || true
  exit 1
}

# --- an ephemeral certificate, never a committed one ------------------------
# One certificate with a SAN per surface. Generated here and thrown away with
# the directory: nothing production-shaped is written to the repository, and
# the key never leaves this run.
cat >"$tmp_dir/openssl.cnf" <<CONF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $DOMAIN
[ext]
subjectAltName = DNS:public.$DOMAIN, DNS:app.$DOMAIN, DNS:admin.$DOMAIN, DNS:api.$DOMAIN
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
CONF

openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$tmp_dir/key.pem" -out "$tmp_dir/cert.pem" \
  -config "$tmp_dir/openssl.cnf" >/dev/null 2>&1 ||
  fail 'could not generate the ephemeral test certificate'

# --- render the gateway from the same templates a host would install -------
render_surface() {
  sed \
    -e "s/__DOMAIN__/$1.$DOMAIN/g" \
    -e "s/__UPSTREAM_PORT__/$2/g" \
    -e 's#__CERTIFICATE__#/etc/ai-agent-tls/cert.pem#g' \
    -e 's#__CERTIFICATE_KEY__#/etc/ai-agent-tls/key.pem#g' \
    "$templates/surface.conf.template"
}

conf=$tmp_dir/conf
mkdir -p "$conf" "$tmp_dir/tls"
cp "$tmp_dir/cert.pem" "$tmp_dir/key.pem" "$tmp_dir/tls/"

{
  render_surface public 9180
  render_surface app 9181
  render_surface admin 9183
  render_surface api 9182
  sed -e "s/__DOMAIN__/app.$DOMAIN/g" "$templates/redirect.conf.template"
} >"$conf/surfaces.conf"

# --- stubs standing in for the four processes ------------------------------
# Each one reports which surface it is and echoes the cookies it received, so
# the assertions read what actually arrived rather than what we hoped would.
# The app surface issues a host-only cookie the way the Control Plane does, and
# a deliberately domain-wide one beside it as the counterexample.
cat >"$conf/upstreams.conf" <<'CONF'
server {
    listen 127.0.0.1:9180;
    location / {
        default_type text/plain;
        return 200 "surface=public cookies=[$http_cookie]\n";
    }
}

server {
    listen 127.0.0.1:9181;
    location / {
        default_type text/plain;
        add_header Set-Cookie "__Host-session=app-session-value; Path=/; HttpOnly; Secure; SameSite=Lax" always;
        add_header Set-Cookie "leaky_shared=app-leaky-value; Path=/; Domain=.origins.test" always;
        return 200 "surface=app cookies=[$http_cookie]\n";
    }
}

server {
    listen 127.0.0.1:9182;
    location / {
        default_type text/plain;
        return 200 "surface=api cookies=[$http_cookie]\n";
    }
}

server {
    listen 127.0.0.1:9183;
    location / {
        default_type text/plain;
        add_header Set-Cookie "__Host-session=admin-session-value; Path=/; HttpOnly; Secure; SameSite=Lax" always;
        return 200 "surface=admin cookies=[$http_cookie]\n";
    }
}
CONF

cp "$snippet" "$conf/proxy-common.conf"

docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:$PORT:443" \
  -v "$conf/surfaces.conf:/etc/nginx/conf.d/surfaces.conf:ro" \
  -v "$conf/upstreams.conf:/etc/nginx/conf.d/upstreams.conf:ro" \
  -v "$conf/proxy-common.conf:/etc/nginx/snippets/ai-agent-proxy-common.conf:ro" \
  -v "$tmp_dir/tls:/etc/ai-agent-tls:ro" \
  nginx:1.29-alpine >/dev/null 2>&1 ||
  fail 'could not start the gateway container'

attempts=0
until curl --silent --output /dev/null --cacert "$tmp_dir/cert.pem" \
  --resolve "app.$DOMAIN:$PORT:127.0.0.1" "https://app.$DOMAIN:$PORT/"; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 30 ] || fail 'the gateway never became ready'
  sleep 1
done

jar=$tmp_dir/cookies.txt

visit() {
  curl --silent --show-error --cacert "$tmp_dir/cert.pem" \
    --cookie-jar "$jar" --cookie "$jar" \
    --resolve "$1.$DOMAIN:$PORT:127.0.0.1" \
    "https://$1.$DOMAIN:$PORT/$2"
}

headers_of() {
  curl --silent --show-error --head --cacert "$tmp_dir/cert.pem" \
    --resolve "$1.$DOMAIN:$PORT:127.0.0.1" \
    "https://$1.$DOMAIN:$PORT/"
}

# Case-insensitive on purpose: HTTP/2 lowercases header names on the wire, so
# a check written for `Strict-Transport-Security` would pass over http/1.1 and
# fail over the protocol this actually serves.
contains() {
  printf '%s' "$1" | grep -Fiq "$2" || fail "$3"
}

lacks() {
  printf '%s' "$1" | grep -Fiq "$2" && fail "$3"
  return 0
}

# --- every surface answers as itself, over TLS -----------------------------
for surface in public app admin api; do
  body=$(visit "$surface" '')
  contains "$body" "surface=$surface" \
    "$surface.$DOMAIN did not reach the $surface upstream"
done
rm -f "$jar"

# --- HTTPS and the security headers the template promises ------------------
head=$(headers_of "app")
contains "$head" 'Strict-Transport-Security' 'the app surface sent no HSTS header'
contains "$head" 'X-Content-Type-Options: nosniff' 'the app surface sent no nosniff header'
head=$(headers_of "admin")
contains "$head" 'Strict-Transport-Security' 'the admin surface sent no HSTS header'

# --- the session cookie is host-only ---------------------------------------
rm -f "$jar"
visit app '' >/dev/null

grep -Fq '__Host-session' "$jar" || fail 'the app surface issued no session cookie'

# The jar is curl's Netscape format: host, then a tailmatch column that says
# whether the cookie applies to subdomains. `FALSE` there is host-only, which
# is the property under test. An `HttpOnly` cookie is written with a
# `#HttpOnly_` prefix on the host, hence the leading alternation.
grep '__Host-session' "$jar" |
  grep -Eq "(^|_)app\.$DOMAIN[[:space:]]+FALSE" ||
  fail 'the app session cookie was not stored host-only'

# The counterexample: the same response set a `Domain=` cookie, and that one is
# stored for the whole domain — tailmatch `TRUE`. It is here so the isolation
# checks below cannot pass by accident.
grep 'leaky_shared' "$jar" |
  grep -Eq "^\.$DOMAIN[[:space:]]+TRUE" ||
  fail 'the domain-wide counterexample cookie was not stored domain-wide'

# --- the app session never reaches another surface -------------------------
admin_saw=$(visit admin '')
lacks "$admin_saw" 'app-session-value' \
  'the app session cookie was sent to the admin surface'
contains "$admin_saw" 'app-leaky-value' \
  'the counterexample did not leak, so this fixture cannot detect leakage'

api_saw=$(visit api '')
lacks "$api_saw" 'app-session-value' \
  'the app session cookie was sent to the API surface'

public_saw=$(visit public '')
lacks "$public_saw" 'app-session-value' \
  'the app session cookie was sent to the public surface'

# --- and the admin session never reaches the app ---------------------------
# The admin surface issued its own cookie under the same name during the visit
# above. Both are host-only, so each host sees only its own value.
app_saw=$(visit app '')
contains "$app_saw" 'app-session-value' \
  'the app surface stopped receiving its own session cookie'
lacks "$app_saw" 'admin-session-value' \
  'the admin session cookie was sent to the app surface'

admin_again=$(visit admin '')
contains "$admin_again" 'admin-session-value' \
  'the admin surface stopped receiving its own session cookie'
lacks "$admin_again" 'app-session-value' \
  'the app session cookie reached the admin surface on a later request'

# --- plain http carries nothing ---------------------------------------------
# Asserted on the rendered configuration rather than over the wire: port 80 is
# not published, because a surface whose cookie is `Secure` has nothing to
# serve there.
grep -Fq 'return 301 https://$host$request_uri;' "$conf/surfaces.conf" ||
  fail 'the redirect template does not send http traffic to https'

# --- no template may widen a cookie ----------------------------------------
if grep -rniE 'Domain=|SameSite=None' "$templates" \
  infra/gateway/nginx/snippets infra/gateway/nginx/templates/proxy-routes.conf.template; then
  echo 'a gateway template sets a cookie Domain or SameSite=None' >&2
  exit 1
fi

echo 'gateway origin isolation over HTTPS: ok'
