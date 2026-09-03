#!/bin/sh
set -eu

# Removes only superseded application images outside the CURRENT and PREVIOUS
# release records. Each removal names one repository digest; infrastructure
# images, volumes, containers, and build cache are outside this script's scope.
# Paths are fixed literals because the installed command runs as root.

state_dir=/var/lib/ai-agent
current_release=$state_dir/CURRENT_RELEASE.json
previous_release=$state_dir/PREVIOUS_RELEASE.json
deploy_lock=$state_dir/deploy.lock
host_preflight=/usr/local/sbin/ai-agent-host-preflight
registry=ghcr.io/adnanalmahmut/ai-agent

# Infrastructure repositories are deliberately absent from this allowlist.
application_repositories='backend backend-migration web platform'

# Release-record field name to repository name. `migration` is recorded under a
# field that does not match its repository, so the mapping is explicit rather
# than derived.
release_fields='backend:backend migration:backend-migration web:web platform:platform'

die() {
  echo "release retention failed: $*" >&2
  exit 64
}

warn() { echo "release retention: $*" >&2; }

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

protected_ids=$work_dir/protected_ids
protected_refs=$work_dir/protected_refs
local_ids=$work_dir/local_ids
candidates=$work_dir/candidates
: >"$protected_ids"
: >"$protected_refs"
: >"$local_ids"
: >"$candidates"

# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

# The deployment lock prevents newly pulled, not-yet-recorded images from
# becoming retention candidates. Standalone mode opens it; internal mode adopts
# the descriptor already held by ai-agent-deploy. Both are non-blocking.

# Standalone. A fresh description, so an active deployment refuses it.
lock_retention() {
  [ -d "$state_dir" ] || die 'release state directory does not exist'
  exec 9>"$deploy_lock"
  flock -n 9 || die 'a deployment is active; retention will not run alongside one'
}

# Opening the file here would create a different open-file description, so the
# inherited descriptor must point to the deployment lock before any Docker call.
adopt_deployment_lock() {
  target=$(readlink "/proc/$$/fd/9" 2>/dev/null || true)
  [ "$target" = "$deploy_lock" ] || die \
    "internal retention requires the deployment lock on descriptor 9; found ${target:-nothing}"
  flock -n 9 || die 'a deployment is active; retention will not run alongside one'
}

# ---------------------------------------------------------------------------
# Reading and strictly validating the release records
# ---------------------------------------------------------------------------

manifest_field() {
  sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1"
}

# Strict: a record missing a field, carrying a malformed SHA, or carrying
# anything other than a sha256 digest of the right length is a refusal, not a
# record to work around. A truncated record must never be read as "this release
# protects fewer images".
validate_release_record() {
  manifest=$1
  label=$2

  [ -r "$manifest" ] || die "$label release record is missing or unreadable"

  sha=$(manifest_field "$manifest" sha)
  printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' ||
    die "$label release record does not carry a valid release SHA"

  for entry in $release_fields; do
    field=${entry%%:*}
    repository=${entry#*:}

    value=$(manifest_field "$manifest" "$field")
    [ -n "$value" ] || die "$label release record is missing the $field image"

    # Recorded as `sha256:<64 hex>`. This is an OCI index digest: the release
    # manifest records what `buildx imagetools inspect` resolved, and bake
    # pushes an index carrying provenance and SBOM attestations alongside the
    # platform image. It is therefore NOT the platform manifest digest, and must
    # never be compared against one.
    printf '%s' "$value" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
      die "$label release record has a malformed $field digest"

    printf '%s\n' "$registry/$repository@$value" >>"$protected_refs"
  done
}

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

# The recorded digest is resolved *through Docker* and whatever identity Docker
# returns is what gets compared. Digest strings are never compared against each
# other, and `.Id` is never assumed to equal the registry digest: that happens to
# hold on a containerd-image-store daemon, where images are keyed by manifest
# digest, and not on a classic-store daemon, which reports the config digest.
# Resolving keeps this correct on either.
resolve_reference() {
  docker image inspect "$1" --format '{{.Id}}' 2>/dev/null
}

# ---------------------------------------------------------------------------
# Phase 1: establish the protected set, before any mutation
# ---------------------------------------------------------------------------

establish_protected_set() {
  validate_release_record "$current_release" current
  validate_release_record "$previous_release" previous

  missing=0
  while IFS= read -r reference; do
    [ -n "$reference" ] || continue
    if id=$(resolve_reference "$reference"); then
      [ -n "$id" ] || die "Docker resolved an empty identity for $reference"
      printf '%s\n' "$id" >>"$protected_ids"
    else
      warn "protected release image does not resolve locally: $reference"
      missing=$((missing + 1))
    fi
  done <"$protected_refs"

  # The single control that stops an identity mismatch from becoming a deleted
  # rollback target. If a recorded reference cannot be resolved, the protected
  # set is incomplete, and an incomplete protected set subtracted from the local
  # images classifies the missing release's images as removable — including, in
  # the worst case, the release that is currently running. Refusing here is the
  # difference between "change nothing" and "delete the live release".
  [ "$missing" -eq 0 ] || die \
    "$missing protected release image(s) could not be resolved; removing nothing"

  # A host that has lost rollback capability should not also be having images
  # deleted by an automated sweep.
  [ -s "$protected_ids" ] || die 'protected set is empty; removing nothing'
}

# ---------------------------------------------------------------------------
# Phase 2: enumerate candidates
# ---------------------------------------------------------------------------

# Repositories are matched as whole strings rather than passed to
# `--filter reference=`, because `backend` is a prefix of `backend-migration`
# and this must not depend on how the filter treats that.
enumerate_application_images() {
  listing=$work_dir/listing
  docker image ls --format '{{.Repository}} {{.ID}}' >"$listing" 2>/dev/null ||
    die 'could not enumerate local images'

  while read -r repository short_id; do
    [ -n "$repository" ] && [ -n "$short_id" ] || continue
    matched=no
    for repo in $application_repositories; do
      [ "$repository" = "$registry/$repo" ] || continue
      matched=yes
      break
    done
    [ "$matched" = yes ] || continue

    id=$(resolve_reference "$short_id") || continue
    [ -n "$id" ] || continue
    printf '%s\n' "$id" >>"$local_ids"
  done <"$listing"
}

compute_candidates() {
  [ -s "$local_ids" ] || return 0
  sort -u "$local_ids" >"$work_dir/local_unique"
  sort -u "$protected_ids" >"$work_dir/protected_unique"
  # Set semantics, so a digest recorded by both releases is protected once and
  # cannot appear as a candidate through either.
  comm -23 "$work_dir/local_unique" "$work_dir/protected_unique" >"$candidates"
}

# ---------------------------------------------------------------------------
# Phase 3: removal
# ---------------------------------------------------------------------------

# Reported so a candidate is always removed by a reference that names the
# repository and digest, never by a bare identity.
# Every loop in this script reads from a redirected file rather than a pipe, so
# no iteration runs in a subshell where a refusal or a counter would be lost.
removal_reference() {
  docker image inspect "$1" --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    >"$work_dir/repodigests" 2>/dev/null || return 0

  found=
  while IFS= read -r reference; do
    [ -n "$reference" ] || continue
    [ -z "$found" ] || continue
    for repo in $application_repositories; do
      case $reference in
        "$registry/$repo@sha256:"*) found=$reference; break ;;
      esac
    done
  done <"$work_dir/repodigests"

  [ -z "$found" ] || printf '%s\n' "$found"
}

# Checked before attempting removal rather than inferred from a failure message.
# Both states block removal and neither is ever forced, but they mean different
# things: a running container on an image outside CURRENT and PREVIOUS means the
# host is serving something the release state does not describe, while a stopped
# one is stale operational state. Neither is successful cleanup.
report_blocking_containers() {
  reference=$1
  docker ps --all --filter ancestor="$reference" \
    --format '{{.ID}} {{.State}}' >"$work_dir/blocking" 2>/dev/null || : >"$work_dir/blocking"
  [ -s "$work_dir/blocking" ] || return 1

  while read -r container state; do
    [ -n "$container" ] || continue
    case $state in
      running)
        warn "release state drift: $reference is still used by RUNNING container $container; the host is serving a release the recorded state does not describe"
        ;;
      *)
        warn "stale operational state: $reference is held by ${state:-unknown} container $container"
        ;;
    esac
  done <"$work_dir/blocking"
  return 0
}

remove_candidates() {
  removed=0
  blocked=0
  failed=0

  [ -s "$candidates" ] || { echo 'release retention: no superseded release images to remove'; return 0; }

  while IFS= read -r id; do
    [ -n "$id" ] || continue

    reference=$(removal_reference "$id")
    if [ -z "$reference" ]; then
      warn "candidate $id carries no application repository digest; skipping"
      failed=$((failed + 1))
      continue
    fi

    if report_blocking_containers "$reference"; then
      blocked=$((blocked + 1))
      continue
    fi

    # Status captured directly. Reading it through a pipe would report the
    # pipeline's status instead and silently mask an in-use conflict, which
    # exits 1.
    if output=$(docker image rm "$reference" 2>&1); then
      echo "reclaimed $reference"
      removed=$((removed + 1))
    else
      warn "could not remove $reference: $output"
      failed=$((failed + 1))
    fi
  done <"$candidates"

  printf '%s %s %s\n' "$removed" "$blocked" "$failed" >"$work_dir/outcome"
}

# ---------------------------------------------------------------------------
# Phase 4: verify the protected set survived
# ---------------------------------------------------------------------------

# Phase 1 proves the protected images were there to begin with; this proves the
# sweep did not take one. Neither check substitutes for the other.
verify_protected_set() {
  missing=0
  while IFS= read -r reference; do
    [ -n "$reference" ] || continue
    resolve_reference "$reference" >/dev/null ||
      { warn "PROTECTED RELEASE IMAGE IS GONE AFTER RETENTION: $reference"; missing=$((missing + 1)); }
  done <"$protected_refs"

  [ "$missing" -eq 0 ] || die \
    "$missing protected release image(s) missing after retention; rollback capability is compromised and needs operator attention"

  echo 'release retention: all protected release images verified present'
}

# ---------------------------------------------------------------------------
# Disk accounting
# ---------------------------------------------------------------------------

# Measured against Docker's own data root, because /var and /var/lib/docker are
# not always the same filesystem. Same resolution as ai-agent-host-preflight.
docker_data_root() {
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$root" ] && [ -d "$root" ] || root=/var/lib/docker
  [ -d "$root" ] || root=/var
  printf '%s' "$root"
}

available_mib() {
  kib=$(df -Pk "$1" | awk 'NR == 2 { print $4 }')
  printf '%s' "$kib" | grep -Eq '^[0-9]+$' ||
    die 'could not determine free space for the Docker data root'
  printf '%s' "$((kib / 1024))"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Serialization is a parameter rather than the caller's business, so both entry
# points run the identical sequence in the identical order and there is one place
# where that order is stated.
run_retention() {
  lock_mode=$1
  required_mib=${2:-}
  if [ -n "$required_mib" ]; then
    printf '%s' "$required_mib" | grep -Eq '^[1-9][0-9]*$' ||
      die 'required free space must be a positive number of MiB'
  fi

  case $lock_mode in
    standalone) lock_retention ;;
    inherited) adopt_deployment_lock ;;
    *) die 'internal error: unknown lock mode' ;;
  esac

  establish_protected_set

  data_root=$(docker_data_root)
  before_mib=$(available_mib "$data_root")

  enumerate_application_images
  compute_candidates
  remove_candidates
  verify_protected_set

  after_mib=$(available_mib "$data_root")
  reclaimed_mib=$((after_mib - before_mib))
  echo "release retention: free space before ${before_mib}MiB, after ${after_mib}MiB, reclaimed ${reclaimed_mib}MiB"

  read -r removed blocked failed <"$work_dir/outcome" 2>/dev/null ||
    { removed=0; blocked=0; failed=0; }
  echo "release retention: removed $removed, blocked $blocked, failed $failed"

  # Re-asserted rather than assumed. When a threshold is supplied this is the
  # existing host preflight contract, so a sweep that did not free enough space
  # says so in the same words a deployment refusal would use.
  if [ -n "$required_mib" ]; then
    [ -x "$host_preflight" ] || die 'host preflight is not installed; reinstall the host bundle'
    "$host_preflight" disk "$required_mib"
  else
    echo 'release retention: no free-space requirement supplied; disk preflight not re-run'
  fi

  # Loud, and non-zero, so an operator running this directly sees a partial or
  # zero reclaim as a failure. The caller decides what that means for a
  # deployment that has already succeeded.
  if [ "$blocked" -gt 0 ] || [ "$failed" -gt 0 ]; then
    die "$blocked candidate(s) blocked by containers and $failed failed; retention did not complete cleanly"
  fi
}

case "${1:-}" in
  reclaim)
    [ "$#" -le 2 ] || die 'reclaim takes an optional required free space in MiB'
    run_retention standalone "${2:-}"
    ;;
  reclaim-locked)
    # Internal. Called by ai-agent-deploy after a deployment has succeeded and
    # its release state has been rotated, on the deployment's own lock.
    #
    # Deliberately absent from ai-agent-deploy-dispatch's forced-command
    # grammar, and absent from the sudoers fragment, so the CI deploy key cannot
    # execute retention in either mode. Being handed the descriptor is not what
    # makes this safe, and is not treated as though it were: the flock above is.
    # An operator running this by hand with the redirection would simply get
    # standalone behaviour.
    [ "$#" -le 2 ] || die 'reclaim-locked takes an optional required free space in MiB'
    run_retention inherited "${2:-}"
    ;;
  *) die 'usage: release-retention.sh reclaim|reclaim-locked [required-free-mib]' ;;
esac
