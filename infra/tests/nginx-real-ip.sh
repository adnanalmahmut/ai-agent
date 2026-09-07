#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

headers=infra/gateway/nginx/snippets/proxy-common.conf
routes=infra/gateway/nginx/templates/proxy-routes.conf.template
admin_route=infra/gateway/nginx/templates/admin-route.conf.template

grep -Fqx 'proxy_set_header Host $host;' "$headers"
grep -Fqx 'proxy_set_header X-Forwarded-Host $host;' "$headers"
grep -Fqx 'proxy_set_header X-Forwarded-Proto $scheme;' "$headers"
grep -Fqx 'proxy_set_header X-Real-IP $remote_addr;' "$headers"
grep -Fqx 'proxy_set_header X-Forwarded-For $remote_addr;' "$headers"

if grep -Fq '$proxy_add_x_forwarded_for' "$headers"; then
  echo 'forwarded chain append is forbidden at the trust boundary' >&2
  exit 1
fi

for port in BACKEND_PORT PLATFORM_PORT WEB_PORT; do
  grep -Fq "proxy_pass http://127.0.0.1:__${port}__;" "$routes"
done
grep -Fq 'proxy_pass http://127.0.0.1:__ADMIN_PORT__;' "$admin_route"

# The administrative allowlist is matched against the connection Nginx is
# serving, which is only true while nothing rewrites it. `real_ip_header` with
# `set_real_ip_from` would replace `$remote_addr` with a value taken from a
# request header -- and with no load balancer in front of this host, that
# header is written by the client. An allowlist matched against it would be an
# allowlist anyone could satisfy.
for asset in "$headers" "$routes" "$admin_route" \
  infra/gateway/nginx/templates/site-http.conf.template \
  infra/gateway/nginx/templates/site-https.conf.template \
  infra/gateway/nginx/templates/origins/surface.conf.template \
  infra/gateway/nginx/templates/origins/redirect.conf.template; do
  if grep -Eq 'real_ip_header|set_real_ip_from' "$asset"; then
    echo "the gateway must not take the client address from a request header: $asset" >&2
    exit 1
  fi
done

# And the restriction has to be on the request path, not only on the page: the
# assets and the auth forwarder live under the same prefix, and a location that
# covered one of them alone would leave the others open.
grep -Fq 'include /etc/nginx/ai-agent-admin-ingress.conf;' "$admin_route"
[ "$(grep -c 'include /etc/nginx/ai-agent-admin-ingress.conf;' "$admin_route")" \
  -eq "$(grep -c '^location ' "$admin_route")" ] || {
  echo 'every administrative location must include the ingress restriction' >&2
  exit 1
}

echo 'nginx real-IP invariants: ok'
