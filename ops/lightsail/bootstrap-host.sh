#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }
[ "$#" -eq 4 ] || {
  echo 'usage: bootstrap-host.sh <staging|production> <domain> <trusted-ssh-cidr> <deploy-public-key-file>' >&2
  exit 64
}

environment=$1
domain=$2
trusted_cidr=$3
key_file=$4
[ "$environment" = staging ] || [ "$environment" = production ] || exit 64
printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9.-]+$' || exit 64
[ -s "$key_file" ] || exit 64

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl docker.io docker-compose-v2 nginx certbot python3-certbot-nginx postgresql-client ufw

# The smallest Lightsail plans have little RAM and Docker image extraction can
# briefly require more memory than the running application set. Provision a
# bounded swap file so deploys fail on real errors rather than transient OOM.
if ! swapon --show=NAME --noheadings | grep -Fxq '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  fi
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -Fqx '/swapfile none swap sw 0 0' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >>/etc/fstab
printf '%s\n' 'vm.swappiness=10' >/etc/sysctl.d/99-ai-agent-swap.conf
sysctl -p /etc/sysctl.d/99-ai-agent-swap.conf >/dev/null

# The smallest Lightsail plans have little RAM and Docker image extraction can
# briefly require more memory than the running application set. Provision a
# bounded swap file so deploys fail on real errors rather than transient OOM.
if ! swapon --show=NAME --noheadings | grep -Fxq '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  fi
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -Fqx '/swapfile none swap sw 0 0' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >>/etc/fstab
printf '%s\n' 'vm.swappiness=10' >/etc/sysctl.d/99-ai-agent-swap.conf
sysctl -p /etc/sysctl.d/99-ai-agent-swap.conf >/dev/null

id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh deploy
gpasswd -d deploy docker >/dev/null 2>&1 || true
install -d -o root -g root -m 0755 /etc/ai-agent /opt/ai-agent /var/lib/ai-agent
printf '%s\n' "$environment" >/etc/ai-agent/environment
chmod 0644 /etc/ai-agent/environment
install -o root -g root -m 0755 ops/lightsail/ai-agent-deploy /usr/local/sbin/ai-agent-deploy
install -o root -g root -m 0755 ops/lightsail/ai-agent-deploy-dispatch /usr/local/sbin/ai-agent-deploy-dispatch
install -o root -g root -m 0755 ops/runtime-preflight.sh /usr/local/sbin/ai-agent-runtime-preflight
install -o root -g root -m 0440 ops/lightsail/ai-agent-deploy.sudoers /etc/sudoers.d/ai-agent-deploy
visudo -cf /etc/sudoers.d/ai-agent-deploy

install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
{
  printf 'restrict,no-user-rc,command="/usr/local/sbin/ai-agent-deploy-dispatch" '
  sed -n '1p' "$key_file"
} >/home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

ufw default deny incoming
ufw default allow outgoing
ufw allow from "$trusted_cidr" to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "host boundary installed for $environment / $domain"
echo 'operator must now install root-owned runtime.env, compose bundle, Nginx site, and certificate'
