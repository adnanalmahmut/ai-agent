#!/bin/sh
set -eu

# Installed as /usr/local/sbin/ai-agent-host-preflight and called by
# ai-agent-deploy before anything irreversible happens.
#
# The runtime preflight answers "is this host configured?". This one answers a
# different question that the Staging bring-up proved is not the same: "is this
# host the one this release was built for, and is it still what it claims to
# be?". A compose file from an earlier release exists, is readable, and passes
# every check the deploy script used to make.
#
# Every path is a fixed absolute literal. This runs as root under `sudo -n`
# with `!setenv`, so a path that could be steered from the environment would be
# a privilege boundary, not a convenience. Tests rewrite these literals the way
# ops/tests/release-manifest.sh already does.

manifest=/etc/ai-agent/host-bundle.manifest
compose_destination=/opt/ai-agent/docker-compose.yml
deploy_destination=/usr/local/sbin/ai-agent-deploy

die() {
  echo "host preflight failed: $*" >&2
  exit 64
}

read_installed_version() {
  [ -r "$manifest" ] ||
    die 'no host bundle is recorded; install it with ops/lightsail/install-host-bundle.sh'
  count=$(grep -c '^version ' "$manifest" || true)
  [ "$count" -eq 1 ] || die 'host bundle manifest must declare exactly one version'
  version=$(sed -n 's/^version //p' "$manifest")
  printf '%s' "$version" | grep -Eq '^[1-9][0-9]*$' ||
    die 'host bundle manifest declares a malformed version'
  printf '%s' "$version"
}

# A version alone is a claim. Recording a digest per file is what makes it
# checkable: the Staging failure was an installed compose file that no longer
# matched the bundle the host believed it had, and a version number would have
# gone on asserting the old value forever.
verify_integrity() {
  installed_version=$(read_installed_version)

  entries=$(grep -c '^file ' "$manifest" || true)
  [ "$entries" -gt 0 ] || die 'host bundle manifest records no files'

  # A manifest that simply omits the release-coupled files would otherwise
  # verify cleanly. Both of these are the reason this check exists at all.
  # Matched as a whole final field, not as a substring: an entry for
  # `<path>.bak` would otherwise satisfy a check for `<path>`.
  recorded_paths=$(sed -n 's/^file [0-7]* [0-9a-f]* //p' "$manifest")
  printf '%s\n' "$recorded_paths" | grep -Fxq "$compose_destination" ||
    die 'host bundle manifest does not cover the installed compose file'
  printf '%s\n' "$recorded_paths" | grep -Fxq "$deploy_destination" ||
    die 'host bundle manifest does not cover the installed deploy script'

  sed -n 's/^file //p' "$manifest" | while read -r expected_mode expected_digest path; do
    [ -n "$expected_mode" ] && [ -n "$expected_digest" ] && [ -n "$path" ] ||
      die 'host bundle manifest has a malformed file entry'
    [ -f "$path" ] || die "recorded host bundle file is missing: $path"

    # stat drops leading zeros; the manifest records four octal digits. Padded
    # rather than prefixed with one zero, so a mode like 0040 compares as
    # itself instead of as 040.
    actual_mode=$(stat -c '%a' "$path")
    while [ "${#actual_mode}" -lt 4 ]; do actual_mode=0$actual_mode; done
    [ "$actual_mode" = "$expected_mode" ] ||
      die "recorded host bundle file has the wrong mode: $path"

    actual_digest=$(sha256sum "$path" | cut -d' ' -f1)
    [ "$actual_digest" = "$expected_digest" ] ||
      die "installed host bundle file does not match the recorded bundle: $path"
  done

  echo "host bundle $installed_version verified"
}

require_version() {
  required=$1
  printf '%s' "$required" | grep -Eq '^[1-9][0-9]*$' ||
    die 'required host bundle version must be a positive integer'
  installed_version=$(read_installed_version)
  [ "$installed_version" -ge "$required" ] || die \
    "this release requires host bundle $required and the host has $installed_version; reinstall the bundle from the release checkout"
  echo "host bundle $installed_version satisfies the required $required"
}

# Image extraction is the deploy step most likely to run the smallest Lightsail
# plans out of space, and it fails there as an opaque Docker error some way into
# a release that has already started. Checked against Docker's own data root,
# because /var and /var/lib/docker are not always the same filesystem.
require_disk() {
  required_mib=$1
  printf '%s' "$required_mib" | grep -Eq '^[1-9][0-9]*$' ||
    die 'required free space must be a positive number of MiB'

  data_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$data_root" ] && [ -d "$data_root" ] || data_root=/var/lib/docker
  [ -d "$data_root" ] || data_root=/var

  available_kib=$(df -Pk "$data_root" | awk 'NR == 2 { print $4 }')
  printf '%s' "$available_kib" | grep -Eq '^[0-9]+$' ||
    die 'could not determine free space for the Docker data root'
  available_mib=$((available_kib / 1024))

  [ "$available_mib" -ge "$required_mib" ] || die \
    "free space for image extraction is ${available_mib}MiB and this release needs ${required_mib}MiB"
  echo "free space ${available_mib}MiB satisfies the required ${required_mib}MiB"
}

case "${1:-}" in
  integrity)
    [ "$#" -eq 1 ] || die 'integrity takes no arguments'
    verify_integrity
    ;;
  require-version)
    [ "$#" -eq 2 ] || die 'require-version requires the minimum version'
    require_version "$2"
    ;;
  disk)
    [ "$#" -eq 2 ] || die 'disk requires the required free space in MiB'
    require_disk "$2"
    ;;
  *) die 'usage: host-preflight.sh integrity | require-version <n> | disk <mib>' ;;
esac
