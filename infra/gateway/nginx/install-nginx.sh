#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
[ "$#" -eq 4 ] || { echo 'usage: install-nginx.sh <domain> <backend-port> <platform-port> <web-port>' >&2; exit 64; }
domain=$1
# The assets are this script's own neighbours, resolved from its location
# rather than from the caller's. Before the move they were named relative to
# the repository root, so the script worked only when an operator happened to
# be standing in it.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9.-]+$' || exit 64
for port in "$2" "$3" "$4"; do
  printf '%s' "$port" | grep -Eq '^[0-9]{2,5}$' || exit 64
  [ "$port" -le 65535 ] || exit 64
done

install -d -o root -g root -m 0755 /var/www/letsencrypt /etc/nginx/snippets
install -o root -g root -m 0644 "$here/snippets/proxy-common.conf" /etc/nginx/snippets/ai-agent-proxy-common.conf
sed -e "s/__BACKEND_PORT__/$2/g" -e "s/__PLATFORM_PORT__/$3/g" -e "s/__WEB_PORT__/$4/g" \
  "$here/templates/proxy-routes.conf.template" >/etc/nginx/ai-agent-proxy-routes.conf
sed "s/__DOMAIN__/$domain/g" "$here/templates/site-http.conf.template" >/etc/nginx/sites-available/ai-agent
ln -sfn /etc/nginx/sites-available/ai-agent /etc/nginx/sites-enabled/ai-agent
nginx -t
systemctl reload nginx
