#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
[ "$#" -eq 2 ] || { echo 'usage: issue-certificate.sh <domain> <operator-email>' >&2; exit 64; }
domain=$1
email=$2
certbot certonly --webroot --webroot-path /var/www/letsencrypt --domain "$domain" --email "$email" --agree-tos --no-eff-email
site=$(mktemp)
trap 'rm -f "$site"' EXIT
sed "s/__DOMAIN__/$domain/g" ops/nginx/templates/site-http.conf.template >"$site"
sed "s/__DOMAIN__/$domain/g" ops/nginx/templates/site-https.conf.template >>"$site"
install -o root -g root -m 0644 "$site" /etc/nginx/sites-available/ai-agent
install -o root -g root -m 0755 ops/lightsail/reload-nginx-after-renewal /etc/letsencrypt/renewal-hooks/deploy/ai-agent-nginx
nginx -t
systemctl reload nginx
certbot renew --dry-run
