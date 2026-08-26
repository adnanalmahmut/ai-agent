#!/bin/sh
set -eu

# Installs the release-coupled host bundle and records what it installed.
#
# Run from a checkout of the release you are about to deploy, as root:
#
#   sudo ops/lightsail/install-host-bundle.sh
#
# Before this existed, ops/lightsail/bootstrap-host.sh installed the host
# scripts once at host creation and there was no supported way to update them.
# The host then had no idea which release its compose file and deploy script
# came from, which is how Staging came to be deploying a release against a
# compose file that predated it.
#
# This writes /etc/ai-agent/host-bundle.manifest: the bundle version and a
# SHA-256 per installed file. ai-agent-host-preflight reads it on every deploy,
# so a hand-edited host file stops the next release rather than the one after.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

inventory=ops/host-bundle/files
version_file=ops/host-bundle/VERSION
manifest=/etc/ai-agent/host-bundle.manifest

die() { echo "host bundle installation failed: $*" >&2; exit 64; }

[ "$(id -u)" -eq 0 ] || die 'run as root'
[ -r "$inventory" ] || die 'host bundle inventory is missing from this checkout'
[ -r "$version_file" ] || die 'host bundle version is missing from this checkout'

version=$(sed -n '1p' "$version_file")
printf '%s' "$version" | grep -Eq '^[1-9][0-9]*$' || die 'host bundle version must be a positive integer'

entries=$(grep -v '^[[:space:]]*#' "$inventory" | grep -v '^[[:space:]]*$')
[ -n "$entries" ] || die 'host bundle inventory is empty'

# Validate the whole inventory before installing any of it. A bundle that is
# half-installed is worse than one that refused: the manifest would then
# describe a host that does not exist.
printf '%s\n' "$entries" | while read -r source destination mode; do
  [ -n "$source" ] && [ -n "$destination" ] && [ -n "$mode" ] ||
    die 'host bundle inventory has a malformed entry'
  [ -f "$source" ] || die "host bundle source is missing: $source"
  case $destination in
    /*) ;;
    *) die "host bundle destination must be absolute: $destination" ;;
  esac
  printf '%s' "$mode" | grep -Eq '^0[0-7]{3}$' || die "host bundle mode is malformed: $mode"
done

install -d -o root -g root -m 0755 /etc/ai-agent /opt/ai-agent /var/lib/ai-agent

umask 077
staged=$manifest.tmp.$$
trap 'rm -f "$staged"' EXIT HUP INT TERM
printf 'version %s\n' "$version" >"$staged"

printf '%s\n' "$entries" | while read -r source destination mode; do
  install -d -o root -g root -m 0755 "$(dirname -- "$destination")"
  install -o root -g root -m "$mode" "$source" "$destination"

  # sudoers is the one destination where a syntactically invalid file locks the
  # deploy user out of the only command it is allowed to run, so it is checked
  # in place before anything else is recorded.
  case $destination in
    /etc/sudoers.d/*) visudo -cf "$destination" >/dev/null || die "sudoers fragment is invalid: $destination" ;;
  esac

  digest=$(sha256sum "$destination" | cut -d' ' -f1)
  printf 'file %s %s %s\n' "$mode" "$digest" "$destination" >>"$staged"
  echo "installed $destination"
done

chown root:root "$staged"
chmod 0644 "$staged"
mv "$staged" "$manifest"
trap - EXIT HUP INT TERM

echo "host bundle $version recorded in $manifest"
/usr/local/sbin/ai-agent-host-preflight integrity
