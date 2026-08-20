# Nginx and TLS

Host Nginx is the only public HTTP server. `/api/` proxies to backend,
`/platform/` to platform, and `/` to web over loopback. Shared proxy settings
set host/proto, canonical IP headers, request ID, one-megabyte request limit,
and bounded connect/read/write timeouts.

Port 80 serves `/.well-known/acme-challenge/` and redirects everything else to
HTTPS. Certbot uses HTTP-01 webroot mode; certificates remain under
`/etc/letsencrypt`. A deploy renewal hook validates Nginx before reload. The TLS
site adds HSTS, MIME-sniffing, referrer, and permissions headers.

DNS and inbound port 80 must work before issuance. Run `nginx -t` after every
template render and `certbot renew --dry-run` during bootstrap and periodically.
Private keys and certificates never enter Git.

The current applications do not expose a WebSocket endpoint, so the proxy does
not forward `Upgrade`/`Connection` headers. Add an explicit WebSocket location
only when a reviewed endpoint requires it; do not enable protocol upgrades for
every request.
