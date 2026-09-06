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
    fail "actions/$action is pinned to v$major but this repository expects v$expected; update infra/tests/artifact-contract.sh deliberately if that is intended"
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
grep -Fq 'schemaVersion:3' "$publish" ||
  fail 'the publish manifest no longer declares schemaVersion 3'
for workflow in "$staging" "$production"; do
  grep -Fq '(.schemaVersion == 2 or .schemaVersion == 3)' "$workflow" ||
    fail "$workflow no longer accepts exactly the two known manifest versions"
  grep -Fq '(.hostBundleMinVersion | type) == "number"' "$workflow" ||
    fail "$workflow no longer requires a numeric host bundle minimum"
  # The reader is the allowlist. Read from the repository, at the same trust
  # level as the workflow file itself, and never from a path the artifact names.
  grep -Fq 'infra/release/manifest.jq' "$workflow" ||
    fail "$workflow no longer reads the manifest through the shared reader"
  grep -Fq 'sparse-checkout: infra/release' "$workflow" ||
    fail "$workflow no longer checks the reader out of the repository"
done

# ---------------------------------------------------------------------------
# One catalog, and every copy of it
# ---------------------------------------------------------------------------

# `infra/release/components` says what a release is made of. Several places
# necessarily carry their own copy -- bake is HCL, the deploy workflows must not
# check out a moving branch to learn the allowlist, and the two host scripts run
# with no repository in sight. Each copy is compared against the catalog here,
# so adding a component is a change to the catalog plus whatever this test then
# reports, rather than a change that silently leaves five lists behind.
catalog=infra/release/components
[ -r "$catalog" ] || fail 'the release component catalog is missing'
catalog_names=$(grep -v '^[[:space:]]*#' "$catalog" | grep -v '^[[:space:]]*$' | awk '{ print $1 }' | sort)
[ -n "$catalog_names" ] || fail 'the release component catalog is empty'

grep -v '^[[:space:]]*#' "$catalog" | grep -v '^[[:space:]]*$' | while read -r name repository required; do
  printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9-]*$' ||
    fail "catalog component name is malformed: $name"
  printf '%s' "$repository" | grep -Eq '^[a-z][a-z0-9-]*$' ||
    fail "catalog repository is malformed: $repository"
  case $required in true | false) ;; *) fail "catalog component $name must say whether it is required" ;; esac
done

# The images bake actually builds.
bake_names=$(sed -n '/^group "release"/,/}/p' docker-bake.hcl |
  sed -n 's/.*targets = \[\(.*\)\].*/\1/p' | tr -d '" ' | tr ',' '\n' | sort)
[ "$bake_names" = "$catalog_names" ] ||
  fail "docker-bake.hcl release group does not match the component catalog:
  catalog: $(printf '%s' "$catalog_names" | tr '\n' ' ')
  bake:    $(printf '%s' "$bake_names" | tr '\n' ' ')"

# Every release target must stamp its own component name, or the host cannot
# tell one release image from another of the same release.
for name in $catalog_names; do
  grep -Fq "\"io.ai-agent.component.name\" = \"$name\"" docker-bake.hcl ||
    fail "docker-bake.hcl does not label the $name image with its component name"
done

# The reader's allowlist.
reader_names=$(sed -n '/^def catalog:/,/];/p' infra/release/manifest.jq |
  sed -n 's/.*name: "\([a-z0-9-]*\)".*/\1/p' | sort)
[ "$reader_names" = "$catalog_names" ] ||
  fail "infra/release/manifest.jq allowlist does not match the component catalog"

# Requiredness is refused against, so the reader's copy of it has to agree too.
reader_required=$(sed -n '/^def catalog:/,/];/p' infra/release/manifest.jq |
  sed -n 's/.*name: "\([a-z0-9-]*\)".*required: \(true\|false\).*/\1 \2/p' | sort)
catalog_required=$(grep -v '^[[:space:]]*#' "$catalog" | grep -v '^[[:space:]]*$' |
  awk '{ print $1, $3 }' | sort)
[ "$reader_required" = "$catalog_required" ] ||
  fail "infra/release/manifest.jq disagrees with the catalog about which components are required"

# The two host scripts, which run from /usr/local/sbin and cannot read the
# catalog at all.
deploy_names=$(sed -n '/^release_components() {/,/^}/p' infra/deploy/ai-agent-deploy |
  sed -n 's/^ *"\([a-z0-9-]*\) \$.*/\1/p' | sort)
[ "$deploy_names" = "$catalog_names" ] ||
  fail "ai-agent-deploy does not build a release record for exactly the catalog components"

retention_names=$(sed -n "s/^release_components='\(.*\)'\$/\1/p" infra/deploy/release-retention.sh |
  tr ' ' '\n' | cut -d: -f1 | sort)
[ "$retention_names" = "$catalog_names" ] ||
  fail "release retention does not protect exactly the catalog components"

retention_repositories=$(sed -n "s/^application_repositories='\(.*\)'\$/\1/p" infra/deploy/release-retention.sh |
  tr ' ' '\n' | sort)
catalog_repositories=$(grep -v '^[[:space:]]*#' "$catalog" | grep -v '^[[:space:]]*$' | awk '{ print $2 }' | sort)
[ "$retention_repositories" = "$catalog_repositories" ] ||
  fail 'release retention does not consider exactly the catalog repositories'

# ---------------------------------------------------------------------------
# The reader, against real manifests
# ---------------------------------------------------------------------------

# Static greps above protect the wiring. They cannot tell whether the reader
# accepts what it should and refuses what it must, so that is asserted against
# actual documents.
command -v jq >/dev/null 2>&1 || {
  echo 'jq is required for release manifest schema checks' >&2
  exit 1
}

fixtures=$(mktemp -d)
trap 'rm -rf "$fixtures"' EXIT HUP INT TERM

registry=ghcr.io/adnanalmahmut/ai-agent
release_sha=$(printf 'a%.0s' $(seq 40))
digest_for() { printf 'sha256:%064d' "$1"; }

jq -n \
  --arg sha "$release_sha" --arg registry "$registry" \
  --arg b "$(digest_for 1)" --arg m "$(digest_for 2)" \
  --arg w "$(digest_for 3)" --arg p "$(digest_for 4)" \
  '{schemaVersion:2,repository:"adnanalmahmut/ai-agent",sourceWorkflow:"CI",ciRunId:1,publishWorkflow:"Publish immutable images",publishRunId:2,sha:$sha,hostBundleMinVersion:11,backend:($registry+"/backend@"+$b),migration:($registry+"/backend-migration@"+$m),web:($registry+"/web@"+$w),platform:($registry+"/platform@"+$p)}' \
  >"$fixtures/v2.json"

jq -n \
  --arg sha "$release_sha" --arg registry "$registry" \
  --arg b "$(digest_for 1)" --arg m "$(digest_for 2)" \
  --arg w "$(digest_for 3)" --arg p "$(digest_for 4)" \
  '{schemaVersion:3,repository:"adnanalmahmut/ai-agent",sourceWorkflow:"CI",ciRunId:1,publishWorkflow:"Publish immutable images",publishRunId:2,sha:$sha,hostBundleMinVersion:11,
    components:[{name:"backend",repository:($registry+"/backend"),digest:$b,sourceSha:$sha,required:true,compatibility:{hostBundleMinVersion:11}},
                {name:"backend-migration",repository:($registry+"/backend-migration"),digest:$m,sourceSha:$sha,required:true,compatibility:{hostBundleMinVersion:11}},
                {name:"web",repository:($registry+"/web"),digest:$w,sourceSha:$sha,required:true,compatibility:{hostBundleMinVersion:11}},
                {name:"platform",repository:($registry+"/platform"),digest:$p,sourceSha:$sha,required:true,compatibility:{hostBundleMinVersion:11}}]}' \
  >"$fixtures/v3.json"

read_with() { jq -r --arg registry "$registry" -f "$1" "$2"; }
read_manifest() { read_with infra/release/manifest.jq "$1"; }

expected_output="BACKEND_DIGEST=$(digest_for 1 | cut -d: -f2)
BACKEND_MIGRATION_DIGEST=$(digest_for 2 | cut -d: -f2)
WEB_DIGEST=$(digest_for 3 | cut -d: -f2)
PLATFORM_DIGEST=$(digest_for 4 | cut -d: -f2)"

# Both formats have to reduce to the same thing, or "normalised" is a word and
# not a property: the legacy `migration` field becomes the `backend-migration`
# component and nothing downstream sees the difference.
for version in v2 v3; do
  actual=$(read_manifest "$fixtures/$version.json") ||
    fail "the reader refused a valid $version manifest"
  [ "$actual" = "$expected_output" ] ||
    fail "the reader produced unexpected output for $version:
$actual"
done

refuses() {
  description=$1
  filter=$2

  jq "$filter" "$fixtures/v3.json" >"$fixtures/case.json"
  if read_manifest "$fixtures/case.json" >/dev/null 2>&1; then
    fail "the reader accepted $description"
  fi
}

refuses 'a component the catalog does not name' \
  '.components += [{name:"attacker",repository:"ghcr.io/attacker/x",digest:.components[0].digest,sourceSha:.sha,required:false,compatibility:{hostBundleMinVersion:11}}]'
refuses 'a duplicated component' '.components += [.components[0]]'
refuses 'a manifest with no backend' '.components |= map(select(.name != "backend"))'
refuses 'a component published to somebody else'"'"'s repository' \
  '.components[0].repository = "ghcr.io/attacker/backend"'
refuses 'a malformed digest' '.components[0].digest = "sha256:short"'
refuses 'a malformed source SHA' '.components[0].sourceSha = "nothex"'
refuses 'a component built from another commit' \
  '.components[0].sourceSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"[0:40]'
refuses 'a component needing a newer host than the release declares' \
  '.components[0].compatibility.hostBundleMinVersion = 12'
refuses 'a component that does not say whether it is required' 'del(.components[0].required)'
refuses 'a version 3 manifest with no components' 'del(.components)'
refuses 'a manifest version nothing has ever published' '.schemaVersion = 4'
refuses 'a malformed release SHA' '.sha = "nothex"'
refuses 'a release with no host requirement' 'del(.hostBundleMinVersion)'

# The legacy format gets the same treatment; it is read, not trusted.
jq '.backend = "ghcr.io/attacker/backend@" + (.backend | split("@")[1])' \
  "$fixtures/v2.json" >"$fixtures/case.json"
if read_manifest "$fixtures/case.json" >/dev/null 2>&1; then
  fail 'the reader accepted a version 2 manifest naming a foreign repository'
fi

# ---------------------------------------------------------------------------
# Requiredness, and a catalog that grows
# ---------------------------------------------------------------------------

# Whether a component is required is the catalog's answer, not the manifest's.
refuses 'a manifest downgrading a required component to optional' \
  '(.components[] | select(.name == "backend")).required = false'

# The catalog will gain components; version 2 will not. Reading a legacy
# manifest has to stay a matter of the four fields it actually had, so the same
# reader is asked again with a component in the catalog that no version 2
# release could have carried.
sed 's/^def catalog: \[$/&\n  { name: "synthetic-optional", repository: "synthetic-optional", required: false },/' \
  infra/release/manifest.jq >"$fixtures/grown.jq"
grep -Fq 'synthetic-optional' "$fixtures/grown.jq" ||
  fail 'the catalog in infra/release/manifest.jq is no longer shaped as this test patches it'

for version in v2 v3; do
  actual=$(read_with "$fixtures/grown.jq" "$fixtures/$version.json") ||
    fail "adding an optional component to the catalog broke a valid $version manifest"
  [ "$actual" = "$expected_output" ] ||
    fail "adding an optional component to the catalog changed how $version reads:
$actual"
done

# Optional is a catalog fact too: a manifest cannot promote one.
jq --arg registry "$registry" \
  '.components += [{name:"synthetic-optional",repository:($registry+"/synthetic-optional"),
                    digest:.components[0].digest,sourceSha:.sha,required:true,
                    compatibility:{hostBundleMinVersion:11}}]' \
  "$fixtures/v3.json" >"$fixtures/case.json"
if read_with "$fixtures/grown.jq" "$fixtures/case.json" >/dev/null 2>&1; then
  fail 'the reader accepted a manifest promoting an optional component to required'
fi

# ...and an optional component that is declared honestly is carried through, so
# the refusal above is about the disagreement and not about the name.
jq --arg registry "$registry" \
  '.components += [{name:"synthetic-optional",repository:($registry+"/synthetic-optional"),
                    digest:.components[0].digest,sourceSha:.sha,required:false,
                    compatibility:{hostBundleMinVersion:11}}]' \
  "$fixtures/v3.json" >"$fixtures/case.json"
read_with "$fixtures/grown.jq" "$fixtures/case.json" >/dev/null ||
  fail 'the reader refused a correctly declared optional component'

echo 'artifact handoff contract: ok'
