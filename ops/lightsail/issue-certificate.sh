#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
[ "$#" -eq 2 ] || { echo 'usage: issue-certificate.sh <domain> <operator-email>' >&2; exit 64; }
domain=$1
email=$2

install_certbot_tls_asset() {
  name=$1
  destination=$2

  [ -f "$destination" ] && return 0

  source=$(dpkg-query -L python3-certbot-nginx python3-certbot 2>/dev/null | grep "/$name$" | head -n 1 || true)
  [ -n "$source" ] && [ -f "$source" ] || {
    echo "Certbot TLS asset not found: $name" >&2
    exit 1
  }

  install -o root -g root -m 0644 "$source" "$destination"
}

certbot certonly --webroot --webroot-path /var/www/letsencrypt --domain "$domain" --email "$email" --agree-tos --no-eff-email
install_certbot_tls_asset options-ssl-nginx.conf /etc/letsencrypt/options-ssl-nginx.conf
install_certbot_tls_asset ssl-dhparams.pem /etc/letsencrypt/ssl-dhparams.pem
site=$(mktemp)
trap 'rm -f "$site"' EXIT
sed "s/__DOMAIN__/$domain/g" ops/nginx/templates/site-http.conf.template >"$site"
sed "s/__DOMAIN__/$domain/g" ops/nginx/templates/site-https.conf.template >>"$site"
install -o root -g root -m 0644 "$site" /etc/nginx/sites-available/ai-agent
install -o root -g root -m 0755 ops/lightsail/reload-nginx-after-renewal /etc/letsencrypt/renewal-hooks/deploy/ai-agent-nginx
nginx -t
systemctl reload nginx
certbot renew --dry-run
