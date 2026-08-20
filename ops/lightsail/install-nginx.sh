#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
[ "$#" -eq 4 ] || { echo 'usage: install-nginx.sh <domain> <backend-port> <platform-port> <web-port>' >&2; exit 64; }
domain=$1
printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9.-]+$' || exit 64
for port in "$2" "$3" "$4"; do
  printf '%s' "$port" | grep -Eq '^[0-9]{2,5}$' || exit 64
  [ "$port" -le 65535 ] || exit 64
done

install -d -o root -g root -m 0755 /var/www/letsencrypt /etc/nginx/snippets
install -o root -g root -m 0644 ops/nginx/snippets/proxy-common.conf /etc/nginx/snippets/ai-agent-proxy-common.conf
sed -e "s/__BACKEND_PORT__/$2/g" -e "s/__PLATFORM_PORT__/$3/g" -e "s/__WEB_PORT__/$4/g" \
  ops/nginx/templates/proxy-routes.conf.template >/etc/nginx/ai-agent-proxy-routes.conf
sed "s/__DOMAIN__/$domain/g" ops/nginx/templates/site-http.conf.template >/etc/nginx/sites-available/ai-agent
ln -sfn /etc/nginx/sites-available/ai-agent /etc/nginx/sites-enabled/ai-agent
nginx -t
systemctl reload nginx
