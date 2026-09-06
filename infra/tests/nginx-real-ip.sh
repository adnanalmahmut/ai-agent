#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

headers=ops/nginx/snippets/proxy-common.conf
routes=ops/nginx/templates/proxy-routes.conf.template

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

echo 'nginx real-IP invariants: ok'
