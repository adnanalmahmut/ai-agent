#!/bin/sh
set -eu

# Drives ops/release-retention.sh against a Docker stub that models an image
# store: repositories, identities, RepoDigests, containers holding images, and
# removal that refuses while a container references an image.
#
# The identity model is the one proven empirically on 2026-08-26 against Docker
# 29.7.2 and the real published release images. The digest a release record
# holds is an OCI *index* digest; the platform manifest digest inside that index
# is a different value that does not resolve as a local image. The stub models
# both, so a script that ever compared a recorded digest against a platform
# manifest digest fails here rather than on a host.
#
# Every refusal is probed: the guard is removed, the suite must fail, and the
# guard is restored. A refusal no test can make fail is indistinguishable from
# no refusal.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

registry=ghcr.io/adnanalmahmut/ai-agent
source_script=ops/release-retention.sh

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

fail() { echo "release retention test: $*" >&2; exit 1; }

# ===========================================================================
# Static contracts
# ===========================================================================

sh -n "$source_script" || fail 'retention script is not valid POSIX sh'

# No blanket reclaim of any kind in the retention script itself. The repository
# wide sweep across every host script is owned by ops/tests/lightsail-boundary.sh
# so the two do not drift; this asserts the property for the subject of this
# test. Fragments are split so this file does not contain the literals it
# forbids.
for forbidden in \
  'system'' prune' \
  'image'' prune' \
  'volume'' prune' \
  'container'' prune' \
  'builder'' prune' \
  'buildx'' prune'; do
  if grep -En "docker[[:space:]]+$forbidden" "$source_script"; then
    fail "a blanket Docker reclaim is present in the retention script: $forbidden"
  fi
done

# The repository-wide sweep must exist and must cover this script, or the
# narrower assertion above is the only thing standing.
grep -Fq 'ops/release-retention.sh' ops/tests/lightsail-boundary.sh ||
  fail 'the boundary test must cover the retention script in its unsafe-reclaim sweep'

if grep -En 'image rm[^|]*(--force|[[:space:]]-f([[:space:]]|$))' "$source_script"; then
  fail 'retention must never force image removal'
fi
if grep -Fq -- '--volumes' "$source_script"; then
  fail 'retention must never touch volumes'
fi

# Exactly the four application repositories, and no infrastructure image.
grep -Fq "application_repositories='backend backend-migration web platform'" "$source_script" ||
  fail 'retention must restrict itself to the four application repositories'
for infrastructure in postgres redis geoipupdate; do
  if grep -Eq "application_repositories=.*$infrastructure" "$source_script"; then
    fail "infrastructure image must never be a retention candidate: $infrastructure"
  fi
done

# The identity contract. `.Id` must never be assumed equal to the registry
# digest, because that holds only on a containerd-image-store daemon.
grep -Fq "docker image inspect \"\$1\" --format '{{.Id}}'" "$source_script" ||
  fail 'retention must resolve references through docker image inspect'
grep -Fq 'RepoDigests' "$source_script" ||
  fail 'retention must build removal references from RepoDigests'

# Retention takes nothing from the environment. This is what makes the lock
# contract a lock rather than a claim: there is no variable a caller could set to
# assert "the deployment lock is already held", because the script reads none.
# Every path is a fixed absolute literal for the same reason.
if grep -nE '\$\{?[A-Z][A-Z0-9_]*' "$source_script"; then
  fail 'retention must not read anything from the environment'
fi

# ===========================================================================
# Host bundle state: the capability is shipped and now invoked
# ===========================================================================

bundle_version=$(sed -n '1p' ops/host-bundle/VERSION)
bundle_minimum=$(sed -n '1p' ops/host-bundle/MIN_VERSION)
# The wrapper now calls retention, so two listed bundle files changed and the
# repository contract requires VERSION to move with them. MIN_VERSION declares
# the floor at which the retention capability exists, which is 2 -- not 3: the
# release images require nothing from retention, and a host on bundle 2 deploys
# correctly with its own wrapper, which simply does not call it.
[ "$bundle_version" = 3 ] || fail \
  'host bundle VERSION must be 3: ai-agent-deploy and release-retention.sh both changed'
[ "$bundle_minimum" = 2 ] || fail \
  'host bundle MIN_VERSION must be 2: the retention capability first exists in bundle 2'

grep -Fq '/usr/local/sbin/ai-agent-release-retention' ops/host-bundle/files ||
  fail 'the retention script must be in the host bundle inventory'

# Activation. The wrapper must call retention, and must call the entry point that
# re-locks the descriptor it already holds -- `reclaim` would open the lock file
# again, be refused by the very deployment calling it, and never run.
grep -Fq '"$retention" reclaim-locked' ops/lightsail/ai-agent-deploy ||
  fail 'ai-agent-deploy must invoke retention through the inherited-lock entry point'
grep -Fq 'retention=/usr/local/sbin/ai-agent-release-retention' ops/lightsail/ai-agent-deploy ||
  fail 'ai-agent-deploy must resolve retention by its fixed installed path'

# The forced-command grammar is the trust boundary for the CI deploy key, and it
# is unchanged: neither retention verb appears in it.
if grep -Eq 'retention|reclaim' ops/lightsail/ai-agent-deploy-dispatch; then
  fail 'retention must not be reachable through the forced-command grammar'
fi
# Nor through sudo: the deploy user is permitted exactly one program.
if grep -Eq 'retention|reclaim' ops/lightsail/ai-agent-deploy.sudoers; then
  fail 'the deploy user must not be permitted to run retention under sudo'
fi
dispatch_allowlist=$(sed -n "/grep -Eq/s/.*grep -Eq '\([^']*\)'.*/\1/p" ops/lightsail/ai-agent-deploy-dispatch)
[ -n "$dispatch_allowlist" ] || fail 'could not extract the forced-command allowlist'
for rejected in 'reclaim staging' 'reclaim production' 'reclaim-locked staging' \
                'release-retention staging' 'deploy staging reclaim-locked'; do
  if printf '%s\n' "$rejected" | grep -Eq "$dispatch_allowlist"; then
    fail "the CI deploy identity must not be able to invoke retention: $rejected"
  fi
done
# Proves the extraction matched something real rather than nothing.
printf '%s\n' 'status staging' | grep -Eq "$dispatch_allowlist" ||
  fail 'extracted allowlist does not admit a known-good command'

# ===========================================================================
# Sandbox
# ===========================================================================

bin_dir=$tmp_dir/bin
control=$tmp_dir/control
state=$tmp_dir/state
data_root=$tmp_dir/dockerroot
mkdir -p "$bin_dir" "$control" "$state" "$data_root" "$tmp_dir/sbin"

retention=$tmp_dir/release-retention
log=$tmp_dir/docker.log

prepare_script() {
  sed \
    -e "s#^state_dir=.*#state_dir=$state#" \
    -e "s#^host_preflight=.*#host_preflight=$tmp_dir/sbin/ai-agent-host-preflight#" \
    "$1" >"$2"
  chmod 0755 "$2"
}

cat >"$tmp_dir/sbin/ai-agent-host-preflight" <<'SH'
#!/bin/sh
set -eu
printf 'host-preflight %s\n' "$*" >>"$DOCKER_LOG"
[ ! -f "$CONTROL/preflight_fails" ] || { echo 'host preflight failed: disk' >&2; exit 64; }
echo "free space satisfies the required $2MiB"
SH
chmod 0755 "$tmp_dir/sbin/ai-agent-host-preflight"

# Delegates to the real flock rather than modelling it. The whole lock design
# rests on flock locks belonging to an open file description rather than to a
# process, so the tests below must exercise the kernel primitive, not a stand-in
# that would agree with whatever the script did. $CONTROL/lock_held simulates a
# competing holder for the cases that only need a refusal.
real_flock=$(command -v flock) || fail 'flock is required to test the lock contract'
cat >"$bin_dir/flock" <<SH
#!/bin/sh
[ ! -f "\$CONTROL/lock_held" ] || exit 1
exec "$real_flock" "\$@"
SH
chmod 0755 "$bin_dir/flock"

# df is stubbed so the reclaimed-space arithmetic is asserted on known values
# rather than on whatever the CI runner happens to have free. Each call consumes
# the next line; the last value repeats.
cat >"$bin_dir/df" <<'SH'
#!/bin/sh
set -eu
values=$CONTROL/df_values
if [ -s "$values" ]; then
  kib=$(sed -n '1p' "$values")
  remaining=$(sed '1d' "$values")
  if [ -n "$remaining" ]; then printf '%s\n' "$remaining" >"$values"; fi
else
  kib=1048576
fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n'
printf 'stub 1000000 1000000 %s 50%% /\n' "$kib"
SH
chmod 0755 "$bin_dir/df"

# Models an image store. $CONTROL/images holds `<repository> <index-digest>`;
# identity is derived from the digest so the stub never needs to invent one.
# $CONTROL/platform_digests holds digests that exist inside an index but are NOT
# local images, which is how the counterexample is modelled.
cat >"$bin_dir/docker" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$DOCKER_LOG"

images=$CONTROL/images
containers=$CONTROL/containers
[ -f "$images" ] || : >"$images"
[ -f "$containers" ] || : >"$containers"

# The local identity for an index digest. Deliberately NOT the digest itself:
# on a classic-store daemon .Id is the config digest, and any script that
# assumed equality would pass here by accident.
identity_for() { printf 'sha256:id%s' "${1#sha256:}"; }

find_by_reference() {
  wanted=$1
  while read -r repository digest; do
    [ -n "$repository" ] || continue
    [ "$wanted" = "$repository@$digest" ] || continue
    printf '%s %s' "$repository" "$digest"
    return 0
  done <"$images"
  return 1
}

find_by_identity() {
  wanted=$1
  while read -r repository digest; do
    [ -n "$repository" ] || continue
    id=$(identity_for "$digest")
    short=$(printf '%s' "${digest#sha256:}" | cut -c1-12)
    if [ "$wanted" = "$id" ] || [ "$wanted" = "$short" ]; then
      printf '%s %s' "$repository" "$digest"
      return 0
    fi
  done <"$images"
  return 1
}

case ${1:-} in
  info)
    printf '%s\n' "$DOCKER_DATA_ROOT"
    exit 0
    ;;
  image)
    shift
    case ${1:-} in
      inspect)
        shift
        target=; format=
        while [ "$#" -gt 0 ]; do
          case $1 in
            --format) format=$2; shift 2 ;;
            *) target=$1; shift ;;
          esac
        done
        if found=$(find_by_reference "$target" 2>/dev/null); then :
        elif found=$(find_by_identity "$target" 2>/dev/null); then :
        else
          echo "Error response from daemon: No such image: $target" >&2
          exit 1
        fi
        set -- $found
        repository=$1; digest=$2
        case $format in
          *RepoDigests*) printf '%s@%s\n' "$repository" "$digest" ;;
          *) identity_for "$digest" ; printf '\n' ;;
        esac
        exit 0
        ;;
      ls)
        while read -r repository digest; do
          [ -n "$repository" ] || continue
          printf '%s %s\n' "$repository" "$(printf '%s' "${digest#sha256:}" | cut -c1-12)"
        done <"$images"
        exit 0
        ;;
      rm)
        shift
        reference=$1
        found=$(find_by_reference "$reference") || {
          echo "Error response from daemon: No such image: $reference" >&2
          exit 1
        }
        set -- $found
        repository=$1; digest=$2
        while read -r cref cid cstate; do
          [ -n "$cref" ] || continue
          [ "$cref" = "$repository@$digest" ] || continue
          echo "Error response from daemon: conflict: unable to delete $reference (must be forced) - container $cid is using its referenced image" >&2
          exit 1
        done <"$containers"
        # A removal that fails for a reason the pre-check cannot see: the image
        # vanished under a concurrent operation, or the daemon errored. Reaching
        # this is the only way to exercise whether the caller reads rm's status.
        if [ -f "$CONTROL/rm_fails" ] && grep -Fxq "$reference" "$CONTROL/rm_fails"; then
          echo "Error response from daemon: unexpected failure removing $reference" >&2
          exit 1
        fi
        grep -Fv "$repository $digest" "$images" >"$images.next" || true
        mv "$images.next" "$images"
        # Models collateral damage: a removal that takes something it was not
        # asked to take. Nothing in the real daemon is expected to do this, which
        # is exactly why the post-mutation check needs a way to be exercised at
        # all -- otherwise it is a guard no test can make fire.
        if [ -f "$CONTROL/collateral" ]; then
          collateral=$(cat "$CONTROL/collateral")
          grep -Fv "$collateral" "$images" >"$images.next" || true
          mv "$images.next" "$images"
        fi
        printf 'Untagged: %s\nDeleted: %s\n' "$reference" "$(identity_for "$digest")"
        exit 0
        ;;
    esac
    ;;
  ps)
    ancestor=
    for argument in "$@"; do
      case $argument in ancestor=*) ancestor=${argument#ancestor=} ;; esac
    done
    while read -r cref cid cstate; do
      [ -n "$cref" ] || continue
      [ "$cref" = "$ancestor" ] || continue
      printf '%s %s\n' "$cid" "$cstate"
    done <"$containers"
    exit 0
    ;;
esac
exit 0
SH
chmod 0755 "$bin_dir/docker"

prepare_script "$source_script" "$retention"

# ---------------------------------------------------------------------------
# Scenario helpers
# ---------------------------------------------------------------------------

# The discriminating digits go first, because Docker's short identity is the
# leading 12 characters. A fixture that padded on the left gave every image the
# same short id and made the whole store look like one image.
d() { printf 'sha256:%04d%060d' "$1" 0; }

write_record() {
  destination=$1; sha=$2; b=$3; m=$4; w=$5; p=$6
  printf '{"sha":"%s","backend":"%s","migration":"%s","web":"%s","platform":"%s"}\n' \
    "$sha" "$b" "$m" "$w" "$p" >"$destination"
}

CURRENT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PREVIOUS_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

add_image() { printf '%s/%s %s\n' "$registry" "$1" "$2" >>"$control/images"; }
add_container() { printf '%s/%s@%s %s %s\n' "$registry" "$1" "$2" "$3" "$4" >>"$control/containers"; }

# CURRENT digests 1-4, PREVIOUS 11-14, superseded 21-24.
reset_scenario() {
  rm -f "$control"/* 2>/dev/null || true
  : >"$control/images"
  : >"$control/containers"
  : >"$log"

  write_record "$state/CURRENT_RELEASE.json" "$CURRENT_SHA" "$(d 1)" "$(d 2)" "$(d 3)" "$(d 4)"
  write_record "$state/PREVIOUS_RELEASE.json" "$PREVIOUS_SHA" "$(d 11)" "$(d 12)" "$(d 13)" "$(d 14)"

  add_image backend "$(d 1)"; add_image backend-migration "$(d 2)"
  add_image web "$(d 3)"; add_image platform "$(d 4)"
  add_image backend "$(d 11)"; add_image backend-migration "$(d 12)"
  add_image web "$(d 13)"; add_image platform "$(d 14)"
}

add_superseded() {
  add_image backend "$(d 21)"; add_image backend-migration "$(d 22)"
  add_image web "$(d 23)"; add_image platform "$(d 24)"
}

run_retention() {
  script=${RETENTION_SCRIPT:-$retention}
  DOCKER_LOG=$log CONTROL=$control DOCKER_DATA_ROOT=$data_root \
  PATH=$bin_dir:$PATH \
    "$script" "$@" >"$tmp_dir/out" 2>&1
}

# Internal mode reads the deployment lock from descriptor 9, so the descriptor is
# the only thing these runners vary. $LOCK_FD decides what descriptor 9 is:
#   lock   -- the deployment lock, a fresh description, nothing holding it
#   decoy  -- some other file entirely
#   none   -- closed
lock_file=$state/deploy.lock
decoy_file=$tmp_dir/decoy.lock
LOCK_FD=lock

run_retention_fd() {
  script=${RETENTION_SCRIPT:-$retention}
  : >"$decoy_file"
  case ${LOCK_FD:-lock} in
    lock)
      DOCKER_LOG=$log CONTROL=$control DOCKER_DATA_ROOT=$data_root PATH=$bin_dir:$PATH \
        "$script" "$@" >"$tmp_dir/out" 2>&1 9>"$lock_file" ;;
    decoy)
      DOCKER_LOG=$log CONTROL=$control DOCKER_DATA_ROOT=$data_root PATH=$bin_dir:$PATH \
        "$script" "$@" >"$tmp_dir/out" 2>&1 9>"$decoy_file" ;;
    none)
      DOCKER_LOG=$log CONTROL=$control DOCKER_DATA_ROOT=$data_root PATH=$bin_dir:$PATH \
        "$script" "$@" >"$tmp_dir/out" 2>&1 9<&- ;;
    *) fail "unknown LOCK_FD: $LOCK_FD" ;;
  esac
}

# Holds the deployment lock with the real flock on its own open file description
# and then runs a command, so any lock that command takes for itself is competing
# with a genuinely held one. This is how ai-agent-deploy holds it.
cat >"$tmp_dir/with-held-lock" <<'SH'
#!/bin/sh
set -eu
lockfile=$1
real_flock=$2
shift 2
exec 9>"$lockfile"
"$real_flock" -n 9 || { echo 'harness could not take the lock' >&2; exit 70; }
"$@"
SH
chmod 0755 "$tmp_dir/with-held-lock"

# Replaces descriptor 9 with its own description on the same file. Same path,
# different description -- which is precisely what flock distinguishes.
cat >"$tmp_dir/with-fresh-fd" <<'SH'
#!/bin/sh
set -eu
lockfile=$1
shift
exec 9>"$lockfile"
"$@"
SH
chmod 0755 "$tmp_dir/with-fresh-fd"

run_under_held_lock() {
  script=${RETENTION_SCRIPT:-$retention}
  DOCKER_LOG=$log CONTROL=$control DOCKER_DATA_ROOT=$data_root PATH=$bin_dir:$PATH \
    "$tmp_dir/with-held-lock" "$lock_file" "$real_flock" "$script" "$@" \
    >"$tmp_dir/out" 2>&1
}

run_under_held_lock_with_fresh_fd() {
  script=${RETENTION_SCRIPT:-$retention}
  DOCKER_LOG=$log CONTROL=$control DOCKER_DATA_ROOT=$data_root PATH=$bin_dir:$PATH \
    "$tmp_dir/with-held-lock" "$lock_file" "$real_flock" \
    "$tmp_dir/with-fresh-fd" "$lock_file" "$script" "$@" \
    >"$tmp_dir/out" 2>&1
}

image_present() { grep -Fq "$registry/$1 $2" "$control/images"; }

retention_runner=run_retention

expect_refusal() {
  description=$1; shift
  before=$(sort "$control/images")
  if "$retention_runner" "$@"; then
    fail "retention was accepted despite $description"
  fi
  after=$(sort "$control/images")
  [ "$before" = "$after" ] ||
    fail "retention removed an image despite $description"
  # Anchored, because the stub logs the argument list without the `docker`
  # prefix: a pattern with a leading space could never match and this assertion
  # would silently prove nothing.
  if grep -Eq '^image rm ' "$log"; then
    fail "retention attempted a removal despite $description"
  fi
}

expect_message() {
  grep -Fq "$1" "$tmp_dir/out" ||
    { echo "--- expected message not found: $1" >&2; cat "$tmp_dir/out" >&2; exit 1; }
}

# ===========================================================================
# Behaviour
# ===========================================================================

# --- Only CURRENT and PREVIOUS present: nothing is removable ---------------
reset_scenario
run_retention reclaim || fail 'retention refused a clean host'
for pair in "backend $(d 1)" "backend-migration $(d 2)" "web $(d 3)" "platform $(d 4)" \
            "backend $(d 11)" "backend-migration $(d 12)" "web $(d 13)" "platform $(d 14)"; do
  set -- $pair
  image_present "$1" "$2" || fail "a protected image was removed: $1 $2"
done
expect_message 'no superseded release images to remove'

# --- A superseded generation is removed, and only it -----------------------
reset_scenario
add_superseded
run_retention reclaim || fail 'retention refused a host with a superseded release'
for pair in "backend $(d 21)" "backend-migration $(d 22)" "web $(d 23)" "platform $(d 24)"; do
  set -- $pair
  ! image_present "$1" "$2" || fail "a superseded image survived: $1 $2"
done
for pair in "backend $(d 1)" "platform $(d 4)" "backend $(d 11)" "platform $(d 14)"; do
  set -- $pair
  image_present "$1" "$2" || fail "CURRENT or PREVIOUS was removed: $1 $2"
done
expect_message 'all protected release images verified present'
expect_message 'removed 4, blocked 0, failed 0'

# --- Non-application images are never candidates --------------------------
reset_scenario
printf 'postgres %s\n' "$(d 31)" >>"$control/images"
printf 'redis %s\n' "$(d 32)" >>"$control/images"
printf 'geoipupdate %s\n' "$(d 33)" >>"$control/images"
printf 'ghcr.io/other/project/backend %s\n' "$(d 34)" >>"$control/images"
# A fifth repository inside our own registry namespace. This is the case the
# allowlist really guards: it looks like ours, and it is still not one of the
# four the release records describe, so nothing can vouch for it.
printf '%s/experimental %s\n' "$registry" "$(d 35)" >>"$control/images"
run_retention reclaim || fail 'retention refused because of unrelated images'
grep -Fq "$registry/experimental $(d 35)" "$control/images" ||
  fail 'a repository outside the four application repositories was removed'
for pair in "postgres $(d 31)" "redis $(d 32)" "geoipupdate $(d 33)"; do
  set -- $pair
  grep -Fq "$1 $2" "$control/images" || fail "an infrastructure image was removed: $1"
done
grep -Fq "ghcr.io/other/project/backend $(d 34)" "$control/images" ||
  fail 'an image from another registry path was removed'

# --- A digest shared by CURRENT and PREVIOUS stays protected --------------
reset_scenario
write_record "$state/PREVIOUS_RELEASE.json" "$PREVIOUS_SHA" "$(d 1)" "$(d 12)" "$(d 13)" "$(d 14)"
add_superseded
run_retention reclaim || fail 'retention refused with a shared digest'
image_present backend "$(d 1)" || fail 'a digest recorded by both releases was removed'

# --- Missing and malformed release records refuse before mutation ---------
reset_scenario; add_superseded
rm -f "$state/CURRENT_RELEASE.json"
expect_refusal 'a missing CURRENT record' reclaim
expect_message 'current release record is missing'

reset_scenario; add_superseded
rm -f "$state/PREVIOUS_RELEASE.json"
expect_refusal 'a missing PREVIOUS record' reclaim
expect_message 'previous release record is missing'

reset_scenario; add_superseded
printf 'not json at all\n' >"$state/CURRENT_RELEASE.json"
expect_refusal 'a malformed CURRENT record' reclaim

reset_scenario; add_superseded
printf 'not json at all\n' >"$state/PREVIOUS_RELEASE.json"
expect_refusal 'a malformed PREVIOUS record' reclaim

# A record that parses but omits an image must not be read as protecting fewer.
reset_scenario; add_superseded
printf '{"sha":"%s","backend":"%s","web":"%s","platform":"%s"}\n' \
  "$CURRENT_SHA" "$(d 1)" "$(d 3)" "$(d 4)" >"$state/CURRENT_RELEASE.json"
expect_refusal 'a truncated CURRENT record' reclaim
expect_message 'missing the migration image'

reset_scenario; add_superseded
printf '{"sha":"%s","backend":"%s","migration":"%s","web":"%s","platform":"%s"}\n' \
  "$CURRENT_SHA" 'sha256:short' "$(d 2)" "$(d 3)" "$(d 4)" >"$state/CURRENT_RELEASE.json"
expect_refusal 'a malformed digest in CURRENT' reclaim
expect_message 'malformed backend digest'

reset_scenario; add_superseded
printf '{"sha":"nothex","backend":"%s","migration":"%s","web":"%s","platform":"%s"}\n' \
  "$(d 1)" "$(d 2)" "$(d 3)" "$(d 4)" >"$state/CURRENT_RELEASE.json"
expect_refusal 'a malformed release SHA in CURRENT' reclaim

# --- A protected reference that does not resolve refuses before mutation --
reset_scenario; add_superseded
grep -Fv "$registry/web $(d 3)" "$control/images" >"$control/images.next"
mv "$control/images.next" "$control/images"
expect_refusal 'a protected image absent from the local store' reclaim
expect_message 'could not be resolved'

# --- The counterexample: a platform-manifest digest in the record ---------
# The recorded value is an index digest. Substituting the platform manifest
# digest from inside that index is the realistic mismatch, and it must refuse
# rather than treat CURRENT's images as removable.
reset_scenario; add_superseded
write_record "$state/CURRENT_RELEASE.json" "$CURRENT_SHA" \
  "$(d 91)" "$(d 2)" "$(d 3)" "$(d 4)"
expect_refusal 'a recorded digest that is not a local image identity' reclaim
expect_message 'does not resolve locally'

# --- Container drift: running and stopped are distinguished, never forced --
reset_scenario; add_superseded
add_container backend "$(d 21)" c0ffee11 running
if run_retention reclaim; then fail 'retention succeeded despite a running container on a superseded image'; fi
expect_message 'RUNNING container c0ffee11'
expect_message 'release state drift'
image_present backend "$(d 21)" || fail 'a blocked image was removed anyway'
if grep -Eq 'image rm .*(--force| -f)' "$log"; then fail 'retention forced a removal'; fi
# The other three are still reclaimed: one blocked candidate must not abandon
# the sweep, and the run still fails.
! image_present web "$(d 23)" || fail 'an unblocked candidate was skipped'
expect_message 'blocked 1'

reset_scenario; add_superseded
add_container platform "$(d 24)" dead0011 exited
if run_retention reclaim; then fail 'retention succeeded despite a stopped container on a superseded image'; fi
expect_message 'stale operational state'
expect_message 'exited container dead0011'
image_present platform "$(d 24)" || fail 'a stopped-container-held image was removed'

# --- A blocked candidate can never be a protected one ---------------------
# Interrupting mid-sweep must not put a protected image at risk: protected
# images are not in the candidate list at all.
reset_scenario; add_superseded
add_container backend "$(d 21)" c0ffee11 running
run_retention reclaim || true
for pair in "backend $(d 1)" "backend-migration $(d 2)" "web $(d 3)" "platform $(d 4)" \
            "backend $(d 11)" "backend-migration $(d 12)" "web $(d 13)" "platform $(d 14)"; do
  set -- $pair
  image_present "$1" "$2" || fail "a protected image was lost during a partial sweep: $1 $2"
done

# --- A removal that fails for a reason the pre-check cannot see -----------
reset_scenario; add_superseded
printf '%s/web@%s\n' "$registry" "$(d 23)" >"$control/rm_fails"
if run_retention reclaim; then
  fail 'retention reported success despite a removal that failed'
fi
expect_message 'could not remove'
expect_message 'failed 1'
image_present web "$(d 23)" || fail 'an image reported as failed was actually removed'
# The rest of the sweep still completed.
! image_present backend "$(d 21)" || fail 'one failed removal abandoned the sweep'

# --- Disk reporting -------------------------------------------------------
reset_scenario; add_superseded
printf '%s\n%s\n' 2048000 6144000 >"$control/df_values"
run_retention reclaim || fail 'retention refused while asserting disk reporting'
# 2048000KiB = 2000MiB before, 6144000KiB = 6000MiB after, 4000MiB reclaimed.
expect_message 'free space before 2000MiB, after 6000MiB, reclaimed 4000MiB'

# --- The disk preflight contract -----------------------------------------
reset_scenario; add_superseded
run_retention reclaim 4096 || fail 'retention refused with a free-space requirement'
grep -Fq 'host-preflight disk 4096' "$log" ||
  fail 'retention did not re-run the disk preflight when given a requirement'

reset_scenario; add_superseded
run_retention reclaim || fail 'retention refused without a requirement'
if grep -Fq 'host-preflight disk' "$log"; then
  fail 'retention ran the disk preflight without being given a requirement'
fi
expect_message 'disk preflight not re-run'

reset_scenario; add_superseded
: >"$control/preflight_fails"
if run_retention reclaim 4096; then fail 'retention ignored a failing disk preflight'; fi

reset_scenario; add_superseded
if run_retention reclaim 0; then fail 'retention accepted a zero free-space requirement'; fi
reset_scenario; add_superseded
if run_retention reclaim abc; then fail 'retention accepted a non-numeric requirement'; fi

# --- Serialization -------------------------------------------------------
reset_scenario; add_superseded
: >"$control/lock_held"
expect_refusal 'an active deployment holding the lock' reclaim
expect_message 'a deployment is active'

# --- The two lock modes --------------------------------------------------
#
# Driven against the real flock, so what is asserted is the kernel's
# open-file-description semantics rather than a model of them.

# Internal mode on the deployment's own descriptor: the case ai-agent-deploy
# creates. The lock is genuinely held by the caller, and retention re-locking the
# same description must return immediately rather than deadlock.
reset_scenario; add_superseded
run_under_held_lock reclaim-locked ||
  fail 'internal retention deadlocked or refused on the deployment lock it was handed'
! image_present web "$(d 23)" ||
  fail 'internal retention did not reclaim while running on the inherited lock'
expect_message 'all protected release images verified present'

# The same, with a free-space requirement, which is how the wrapper calls it.
reset_scenario; add_superseded
run_under_held_lock reclaim-locked 4096 ||
  fail 'internal retention refused with a free-space requirement'
grep -Fq 'host-preflight disk 4096' "$log" ||
  fail 'internal retention did not re-run the disk preflight'

# Internal mode given a *fresh* description on the same file while a deployment
# genuinely holds the lock. Same path, so the descriptor check passes; different
# description, so the real flock refuses. This is the case that proves internal
# mode cannot run unlocked.
reset_scenario; add_superseded
before_images=$(sort "$control/images")
if run_under_held_lock_with_fresh_fd reclaim-locked; then
  fail 'internal retention ran on a descriptor that did not hold the lock'
fi
[ "$(sort "$control/images")" = "$before_images" ] ||
  fail 'internal retention mutated while the lock was held elsewhere'
expect_message 'a deployment is active'

# Standalone mode must not piggyback on an inherited descriptor. It opens the
# lock file itself, which is a new description, so a held lock refuses it even
# when descriptor 9 arrives already locked.
reset_scenario; add_superseded
before_images=$(sort "$control/images")
if run_under_held_lock reclaim; then
  fail 'standalone retention accepted an inherited lock instead of taking its own'
fi
[ "$(sort "$control/images")" = "$before_images" ] ||
  fail 'standalone retention mutated during an active deployment'
expect_message 'a deployment is active'

# A descriptor pointing somewhere else is refused before any Docker call. A
# caller that forgot the redirection must not sweep under a serialization that
# does not exist.
# $LOCK_FD is assigned as its own statement rather than as a prefix on the
# function call: POSIX leaves it unspecified whether such a prefix is scoped to
# the call or left set in the shell afterwards, and a value leaking into a later
# case is exactly the kind of thing that makes one of these pass for the wrong
# reason.
reset_scenario; add_superseded
retention_runner=run_retention_fd
LOCK_FD=decoy
expect_refusal 'a descriptor 9 that is not the deployment lock' reclaim-locked
expect_message 'requires the deployment lock on descriptor 9'

# No descriptor 9 at all.
reset_scenario; add_superseded
LOCK_FD=none
expect_refusal 'no descriptor 9 at all' reclaim-locked
expect_message 'found nothing'

# And it still refuses a competing deployment on a correct descriptor.
reset_scenario; add_superseded
: >"$control/lock_held"
LOCK_FD=lock
expect_refusal 'an active deployment while running internally' reclaim-locked
expect_message 'a deployment is active'
retention_runner=run_retention

# --- Usage --------------------------------------------------------------
reset_scenario
if run_retention; then fail 'retention accepted no subcommand'; fi
if run_retention bogus; then fail 'retention accepted an unknown subcommand'; fi
if run_retention reclaim 4096 extra; then fail 'retention accepted a trailing argument'; fi
LOCK_FD=lock
if run_retention_fd reclaim-locked 4096 extra; then
  fail 'internal retention accepted a trailing argument'
fi
# The verb, not the descriptor, selects the mode: `reclaim` handed a descriptor
# must still open the lock file for itself, and `reclaim-locked` without one must
# still refuse rather than fall back.
LOCK_FD=none
run_retention_fd reclaim ||
  fail 'standalone retention needs a descriptor it is supposed to open itself'
LOCK_FD=lock

# ===========================================================================
# Mutation probes
# ===========================================================================
#
# Each removes one guard from a copy of the real script, asserts the suite would
# no longer catch what the guard exists for, and discards the copy.

probe() {
  description=$1; expression=$2
  mutated=$tmp_dir/mutated.sh
  python3 - "$source_script" "$mutated" "$expression" <<'PY'
import sys
source, destination, expression = sys.argv[1], sys.argv[2], sys.argv[3]
old, new = expression.split('=>', 1)
text = open(source).read()
if old not in text:
    sys.stderr.write('probe anchor missing: %r\n' % old)
    sys.exit(2)
open(destination, 'w').write(text.replace(old, new, 1))
PY
  prepare_script "$mutated" "$tmp_dir/mutated-run"
  RETENTION_SCRIPT=$tmp_dir/mutated-run
  export RETENTION_SCRIPT
}

probe_done() { unset RETENTION_SCRIPT; }

# The pre-mutation identity guard. Removing it must let the counterexample
# classify CURRENT's images as removable, which is the whole reason it exists.
probe 'pre-mutation identity guard' \
  '[ "$missing" -eq 0 ] || die \
    "$missing protected release image(s) could not be resolved; removing nothing"=>:'
reset_scenario; add_superseded
write_record "$state/CURRENT_RELEASE.json" "$CURRENT_SHA" \
  "$(d 91)" "$(d 2)" "$(d 3)" "$(d 4)"
run_retention reclaim >/dev/null 2>&1 || true
if image_present backend "$(d 1)"; then
  probe_done
  fail 'removing the pre-mutation identity guard did not expose CURRENT to deletion; the probe proves nothing'
fi
probe_done

# Post-mutation verification.
# Baseline first: with collateral damage happening, the post-mutation check is
# what turns a silently-lost rollback image into a loud failure.
reset_scenario; add_superseded
printf '%s/backend %s\n' "$registry" "$(d 1)" >"$control/collateral"
if run_retention reclaim; then
  fail 'retention reported success after a protected image disappeared during the sweep'
fi
expect_message 'PROTECTED RELEASE IMAGE IS GONE AFTER RETENTION'
expect_message 'rollback capability is compromised'

probe 'post-mutation protected verification' \
  '  [ "$missing" -eq 0 ] || die \
    "$missing protected release image(s) missing after retention; rollback capability is compromised and needs operator attention"=>  :'
reset_scenario; add_superseded
printf '%s/backend %s\n' "$registry" "$(d 1)" >"$control/collateral"
if ! run_retention reclaim >/dev/null 2>&1; then
  probe_done
  fail 'removing the post-mutation check still failed the run; the check is not what catches a lost protected image'
fi
probe_done

# The empty-protected-set guard. Unreachable through any input, so it looked
# like an untestable assertion until probed against the field map it actually
# defends: emptying that map is a plausible refactoring error, and the guard is
# what stops it becoming a sweep with nothing protected.
probe 'empty protected set guard' \
  "release_fields='backend:backend migration:backend-migration web:web platform:platform'=>release_fields=''"
reset_scenario; add_superseded
if run_retention reclaim >/dev/null 2>&1; then
  probe_done
  fail 'an empty release field map produced a sweep instead of a refusal'
fi
expect_message 'protected set is empty'
probe_done

# The repository allowlist. Widened with a fifth repository under our own
# registry namespace, which is the shape the allowlist actually excludes.
probe 'application repository allowlist' \
  "application_repositories='backend backend-migration web platform'=>application_repositories='backend backend-migration web platform experimental'"
reset_scenario
printf '%s/experimental %s\n' "$registry" "$(d 35)" >>"$control/images"
run_retention reclaim >/dev/null 2>&1 || true
if grep -Fq "$registry/experimental $(d 35)" "$control/images"; then
  probe_done
  fail 'widening the repository allowlist did not put an unrecorded repository at risk; the allowlist assertion proves nothing'
fi
probe_done

# The blocking-container check.
# Discriminated on the specific reference, because an unrelated `image rm` for
# the three unblocked candidates appears in the log either way. Asserting only
# that "image rm" occurred would have passed with the check intact and proved
# nothing.
probe 'blocking container check' \
  'if report_blocking_containers "$reference"; then=>if false; then'
reset_scenario; add_superseded
add_container backend "$(d 21)" c0ffee11 running
run_retention reclaim >/dev/null 2>&1 || true
grep -Fq "image rm $registry/backend@$(d 21)" "$log" ||
  { probe_done; fail 'removing the blocking-container check did not cause a removal attempt on the blocked image'; }
probe_done

# The standalone deployment lock. First occurrence, which is lock_retention's.
probe 'standalone deployment lock' 'flock -n 9 || die =>flock -n 9 || true && : '
reset_scenario; add_superseded
: >"$control/lock_held"
if ! run_retention reclaim >/dev/null 2>&1; then
  probe_done
  fail 'removing the lock refusal still refused; the lock is not what refuses'
fi
probe_done

# The internal descriptor check -- the guard that makes "the lock is held" a fact
# rather than a hope. With it gone, a descriptor on some unrelated file is
# accepted, the real flock happily locks that file, and retention sweeps under a
# serialization that protects nothing.
probe 'internal lock descriptor check' \
  '[ "$target" = "$deploy_lock" ] || die \
    "internal retention requires the deployment lock on descriptor 9; found ${target:-nothing}"=>:'
reset_scenario; add_superseded
retention_runner=run_retention_fd
LOCK_FD=decoy
run_retention_fd reclaim-locked >/dev/null 2>&1 || true
if image_present web "$(d 23)"; then
  probe_done; retention_runner=run_retention; LOCK_FD=lock
  fail 'removing the descriptor check did not let retention run on an unrelated descriptor; the check proves nothing'
fi
retention_runner=run_retention
LOCK_FD=lock
probe_done

# The internal flock itself. Anchored on its own comment, because the standalone
# path contains a byte-identical call and the probe replaces the first match.
probe 'internal deployment lock' \
  '  # Unconditional, exactly as in standalone mode. On the descriptor
  # ai-agent-deploy holds this returns immediately; on any other description of
  # the same file it refuses while a deployment is running.
  flock -n 9 || die =>  false || true && : '
reset_scenario; add_superseded
run_under_held_lock_with_fresh_fd reclaim-locked >/dev/null 2>&1 || true
if image_present web "$(d 23)"; then
  probe_done
  fail 'removing the internal flock did not let retention run while a deployment held the lock'
fi
probe_done

# The mode dispatch. Internal mode taking its own lock instead of adopting the
# inherited one is the deadlock this design exists to avoid: it would be refused
# by the very deployment calling it, so retention would never run in production
# and no other test would notice.
probe 'internal mode adopts rather than reopens' \
  'inherited) adopt_deployment_lock ;;=>inherited) lock_retention ;;'
reset_scenario; add_superseded
if run_under_held_lock reclaim-locked >/dev/null 2>&1; then
  probe_done
  fail 'internal mode opening its own lock was still accepted under a held lock; the adoption path proves nothing'
fi
probe_done

# Digest format validation is layered behind the identity gate rather than
# independently load-bearing, and this probe documents that honestly instead of
# claiming more. With the format check removed, a malformed digest still cannot
# reach a mutation: the reference simply fails to resolve and the pre-mutation
# gate refuses. The format check earns its place by refusing before any Docker
# call and by naming the offending field, not by being the only thing standing.
probe 'digest format validation' \
  "printf '%s' \"\$value\" | grep -Eq '^sha256:[0-9a-f]{64}\$' ||
      die \"\$label release record has a malformed \$field digest\"=>:"
reset_scenario; add_superseded
printf '{"sha":"%s","backend":"%s","migration":"%s","web":"%s","platform":"%s"}\n' \
  "$CURRENT_SHA" 'sha256:short' "$(d 2)" "$(d 3)" "$(d 4)" >"$state/CURRENT_RELEASE.json"
before_images=$(sort "$control/images")
if run_retention reclaim >/dev/null 2>&1; then
  probe_done
  fail 'a malformed record reached success once format validation was removed'
fi
[ "$(sort "$control/images")" = "$before_images" ] || {
  probe_done
  fail 'a malformed record caused a mutation once format validation was removed'
}
grep -Fq 'could not be resolved' "$tmp_dir/out" || {
  probe_done
  fail 'the identity gate is not what refuses a malformed digest when format validation is removed'
}
probe_done

# Restore the pristine script for the final confirmation.
prepare_script "$source_script" "$retention"
reset_scenario; add_superseded
run_retention reclaim || fail 'the unmutated script no longer passes after probing'

echo 'release retention invariants: ok'
