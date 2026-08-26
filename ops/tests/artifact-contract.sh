#!/bin/sh
set -eu

# The artifact handoff is the trust boundary between building a release and
# deploying it. publish-images.yml resolves four image digests and uploads them;
# deploy-staging.yml downloads that artifact from another workflow run and
# derives everything it deploys from it; deploy-production.yml promotes only
# what a staging artifact attests.
#
# None of that can be exercised from a pull request, because the download only
# ever runs inside a real workflow_run chain. These are therefore static
# contract assertions on the properties that would fail silently rather than
# loudly: a renamed artifact, a lost run-id scope, or a packaging default that
# changes where the file lands.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

publish=.github/workflows/publish-images.yml
staging=.github/workflows/deploy-staging.yml
production=.github/workflows/deploy-production.yml
workflows=.github/workflows

fail() {
  echo "artifact contract: $*" >&2
  exit 1
}

# --- Runtime majors -------------------------------------------------------
#
# The floor is the first major whose action.yml declares `runs.using: node24`,
# read from the tag rather than from release prose. The prose is actively
# misleading here: both actions describe their v5 as adding Node 24 "support"
# while still defaulting to node20, so upgrading to v5 would have left the
# deprecation in place.
upload_node24_floor=6
download_node24_floor=7

# What this repository is pinned to. Kept separate from the floor so that a
# future bump is a deliberate edit to a named expectation, not a silent drift.
upload_expected=7
download_expected=8

for workflow in "$publish" "$staging" "$production"; do
  [ -r "$workflow" ] || fail "a workflow this contract depends on is missing: $workflow"
done

work=$(mktemp)
trap 'rm -f "$work"' EXIT HUP INT TERM

grep -rn 'uses:[[:space:]]*actions/\(upload\|download\)-artifact' "$workflows" >"$work" || true
[ -s "$work" ] || fail 'no artifact action references found; this test has lost its subject'

# Redirected rather than piped, so a refusal exits this script rather than a
# subshell. The floor is encoded once, here, instead of being restated as a
# version regex that could drift away from the variables above.
while IFS= read -r reference; do
  spec=${reference##*actions/}
  action=${spec%%@*}
  version=${spec#*@}
  version=${version%%[![:alnum:].]*}

  case $version in
    v[0-9]*) major=${version#v}; major=${major%%.*} ;;
    *) fail "artifact action is not pinned to a version tag: $reference" ;;
  esac

  case $action in
    upload-artifact) floor=$upload_node24_floor; expected=$upload_expected ;;
    download-artifact) floor=$download_node24_floor; expected=$download_expected ;;
    *) fail "unrecognized artifact action: $reference" ;;
  esac

  [ "$major" -ge "$floor" ] ||
    fail "actions/$action@$version still runs on the Node 20 runtime; $action needs v$floor or later"
  [ "$major" -eq "$expected" ] ||
    fail "actions/$action is pinned to v$major but this repository expects v$expected; update ops/tests/artifact-contract.sh deliberately if that is intended"
done <"$work"

# --- The steps exist, and there is exactly one of each --------------------
#
# Without this, every assertion below is satisfiable by a workflow that no
# longer transfers anything: the naming checks match the leftover `with:` keys,
# and the version checks only constrain references that are still present. A
# pipeline that stopped uploading the digest manifest entirely would pass. The
# counts also make a duplicated upload — two steps disagreeing about what the
# release is — a failure rather than an ambiguity.
count_uses() {
  grep -c "uses:[[:space:]]*actions/$2@" "$1" 2>/dev/null || true
}

[ "$(count_uses "$publish" upload-artifact)" -eq 1 ] ||
  fail 'publish-images.yml must upload the digest manifest exactly once'
[ "$(count_uses "$publish" download-artifact)" -eq 0 ] ||
  fail 'publish-images.yml must not download artifacts'
[ "$(count_uses "$staging" download-artifact)" -eq 1 ] ||
  fail 'deploy-staging.yml must download the digest manifest exactly once'
[ "$(count_uses "$staging" upload-artifact)" -eq 1 ] ||
  fail 'deploy-staging.yml must upload staging evidence exactly once'
[ "$(count_uses "$production" upload-artifact)" -eq 0 ] ||
  fail 'deploy-production.yml must not upload artifacts'

# --- Artifact naming across the chain -------------------------------------
#
# Both names are cross-workflow contracts. The production gate looks its
# artifact up by exact name, so a rename here is a promotion that can never
# find its evidence.
grep -Fq 'name: image-digests-${{ env.SOURCE_SHA }}' "$publish" ||
  fail 'the publish digest artifact is no longer named image-digests-<source sha>'
grep -Fq 'pattern: image-digests-*' "$staging" ||
  fail 'staging no longer downloads the digest manifest by the image-digests-* pattern'
grep -Fq 'name: staging-success-${{ env.RELEASE_SHA }}' "$staging" ||
  fail 'the staging evidence artifact is no longer named staging-success-<release sha>'
grep -Fq 'staging-success-$RELEASE_SHA' "$production" ||
  fail 'production no longer looks up staging evidence by staging-success-<release sha>'

# --- Cross-run download scope --------------------------------------------
#
# Downloading another run's artifact needs all three of these together. Losing
# any one of them makes the step resolve against the wrong run, or fail in a way
# that looks like a missing artifact rather than a missing permission.
grep -Fq 'merge-multiple: true' "$staging" ||
  fail 'the digest download lost merge-multiple'
grep -Fq 'run-id: ${{ github.event.workflow_run.id }}' "$staging" ||
  fail 'the digest download is no longer scoped to the publish run'
grep -Fq 'github-token: ${{ github.token }}' "$staging" ||
  fail 'the digest download lost the token it needs to read another run'
grep -Fq 'actions: read' "$staging" ||
  fail 'staging lost the actions: read permission required for a cross-run download'

# Exactly one extracted manifest. This is the strongest guard on the download's
# behavior: it is what would catch a future major changing extraction paths.
grep -Fq 'find release -type f -name image-digests.json | wc -l' "$staging" ||
  fail 'staging no longer asserts that exactly one digest manifest was extracted'

# --- Retention and empty-upload handling ---------------------------------
#
# Production promotion reads a staging artifact that may be days old, so the
# retention window is part of the contract rather than a detail.
for workflow in "$publish" "$staging"; do
  grep -Fq 'retention-days: 90' "$workflow" ||
    fail "$workflow no longer retains its artifact for 90 days"
  grep -Fq 'if-no-files-found: error' "$workflow" ||
    fail "$workflow would upload an empty artifact instead of failing"
done

# --- Load-bearing packaging defaults ------------------------------------
#
# These inputs exist in the pinned majors and are deliberately not set. Each
# would break the chain quietly rather than loudly, which is exactly the class
# of change a static test has to catch.
#
# `archive: false` uploads a single file unzipped and ignores `name`, deriving
# the artifact name from the filename instead. That silently renames both
# artifacts and breaks the production lookup.
if grep -Eq '^[[:space:]]*archive:' "$publish" "$staging"; then
  fail 'archive must stay at its default; an unzipped upload ignores the name input and breaks the production lookup'
fi

# `skip-decompress: true` leaves the download zipped, and the next step reads
# the extracted JSON.
if grep -Eq '^[[:space:]]*skip-decompress:' "$staging"; then
  fail 'skip-decompress must stay at its default; the validation step reads the extracted manifest'
fi

# The v8 default is `error`. Downgrading it would restore the older behavior of
# deploying from an artifact whose hash did not match the server.
if grep -Eq '^[[:space:]]*digest-mismatch:[[:space:]]*(warn|ignore)' "$staging"; then
  fail 'digest-mismatch must fail closed; a corrupted digest manifest has to stop the deployment'
fi

# --- Production consumes evidence, it does not re-derive it --------------
#
# Production deliberately uses `gh run download` rather than the action, because
# it searches historical staging runs for one that attests this release. It must
# never reach for a publish artifact directly.
if grep -Fq 'download-artifact' "$production"; then
  fail 'production must locate staging evidence through gh run download, not the artifact action'
fi
grep -Fq 'gh run download' "$production" ||
  fail 'production no longer downloads staging evidence'

# --- The manifest schema contract is untouched by this upgrade -----------
#
# Asserted here so an artifact-action change can never be the thing that
# loosens digest validation.
grep -Fq 'schemaVersion:2' "$publish" ||
  fail 'the publish manifest no longer declares schemaVersion 2'
for workflow in "$staging" "$production"; do
  grep -Fq '.schemaVersion == 2' "$workflow" ||
    fail "$workflow no longer requires manifest schemaVersion 2"
  grep -Fq '(.hostBundleMinVersion | type) == "number"' "$workflow" ||
    fail "$workflow no longer requires a numeric host bundle minimum"
done

echo 'artifact handoff contract: ok'
