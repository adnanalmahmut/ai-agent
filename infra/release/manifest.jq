# Reads a publish manifest and emits the digest assignments a deployment needs.
#
# Two formats are accepted. schemaVersion 2 is the flat one every release
# published so far used: four fixed fields, one image reference each. Version 3
# describes a release as a list of components. Both are normalised to the same
# component representation before anything is validated, so nothing downstream
# has to know which one it was handed -- the version is read once, here.
#
# Everything this emits has already been checked against the catalog below. A
# component the catalog does not name, a repository that is not the one that
# component publishes to, a duplicate, a malformed digest or source SHA, a
# component built from a different commit than the release, a component that
# disagrees with the catalog about whether it is required, or a missing
# required component is a refusal. A manifest is an input, and the fact that it
# arrived through a trusted artifact channel is not a reason to let it name the
# image a host will pull.
#
# Arguments:
#   $registry  the repository-owned namespace every component must live under
#
# Output: one `<COMPONENT>_DIGEST=<64 hex>` line per component the release
# carries, with the name upper-cased and hyphens replaced, ready for
# $GITHUB_ENV.

def catalog: [
  { name: "backend", repository: "backend", required: true },
  { name: "backend-migration", repository: "backend-migration", required: true },
  { name: "web", repository: "web", required: true },
  { name: "platform", repository: "platform", required: true }
];

# The components a version 2 release described, and the field each one's image
# reference lived in. `migration` is the one name that never matched its
# repository, and this mapping is where that alias ends: nothing past
# normalisation refers to a component by it.
#
# This list is frozen. It describes a format that is no longer published, so it
# must not follow the catalog: a component added to the catalog today was not
# in any version 2 release, and reading one must not go looking for it.
def legacy_v2_catalog: [
  { name: "backend", field: "backend" },
  { name: "backend-migration", field: "migration" },
  { name: "web", field: "web" },
  { name: "platform", field: "platform" }
];

def reject($why): error("release manifest rejected: " + $why);

def require_string($value; $what):
  if ($value | type) == "string" then $value else reject($what + " is missing or not a string") end;

def require_number($value; $what):
  if ($value | type) == "number" then $value else reject($what + " is missing or not a number") end;

# `<repository>@sha256:<digest>`, split rather than pattern-matched as a whole,
# so a reference carrying more than one `@` is rejected instead of quietly
# matching a suffix.
def parse_reference($name; $reference):
  (require_string($reference; "component " + $name + " image reference")) as $r
  | ($r | split("@")) as $parts
  | if ($parts | length) != 2 then reject("component " + $name + " image reference is malformed") else . end
  | { repository: $parts[0], digest: $parts[1] };

def normalised:
  . as $manifest
  | if $manifest.schemaVersion == 3 then
      (if ($manifest.components | type) == "array" then $manifest.components
       else reject("a version 3 manifest must carry a components array") end)
      | map(
          . as $component
          | (require_string($component.name; "a component name")) as $name
          | {
              name: $name,
              repository: require_string($component.repository; "component " + $name + " repository"),
              digest: require_string($component.digest; "component " + $name + " digest"),
              sourceSha: require_string($component.sourceSha; "component " + $name + " source SHA"),
              required: (if ($component.required | type) == "boolean" then $component.required
                         else reject("component " + $name + " does not declare whether it is required") end),
              hostBundleMinVersion: require_number($component.compatibility.hostBundleMinVersion;
                "component " + $name + " host bundle minimum")
            }
        )
    elif $manifest.schemaVersion == 2 then
      # Every version 2 release carried exactly the components below, all built
      # from the release commit. The format has no way to say whether one is
      # required, so the record does not claim it did: `required` is left unset
      # and the catalog is the only thing that decides.
      legacy_v2_catalog
      | map(
          . as $entry
          | (parse_reference($entry.name; $manifest[$entry.field])) as $parsed
          | {
              name: $entry.name,
              repository: $parsed.repository,
              digest: $parsed.digest,
              sourceSha: require_string($manifest.sha; "release SHA"),
              hostBundleMinVersion: require_number($manifest.hostBundleMinVersion; "release host bundle minimum")
            }
        )
    else
      reject("unsupported schemaVersion " + ($manifest.schemaVersion | tostring))
    end;

def validated($registry; $releaseSha; $releaseMinimum):
  . as $components
  | ($components | map(.name)) as $names
  | (if ($names | length) == ($names | unique | length) then . else reject("a component is listed more than once") end)
  | (reduce catalog[] as $entry (.;
      if ($entry.required and (($names | index($entry.name)) == null))
      then reject("required component " + $entry.name + " is missing")
      else . end))
  | map(
      . as $component
      | (catalog | map(select(.name == $component.name)) | first) as $known
      | if $known == null then reject("unknown component " + $component.name) else . end
      | if $component.repository != ($registry + "/" + $known.repository)
        then reject("component " + $component.name + " names an unexpected repository " + $component.repository)
        else . end
      # Requiredness is the catalog's to decide, so a manifest that disagrees
      # with it is refused rather than believed. A format that cannot express
      # requiredness at all declares nothing here and has nothing to disagree
      # with; the missing-component check above still holds it to the catalog.
      | if ($component | has("required")) and $component.required != $known.required
        then reject("component " + $component.name + " declares required "
                    + ($component.required | tostring) + ", but the catalog declares "
                    + ($known.required | tostring))
        else . end
      | if ($component.digest | test("^sha256:[0-9a-f]{64}$")) then . else
          reject("component " + $component.name + " has a malformed digest") end
      | if ($component.sourceSha | test("^[0-9a-f]{40}$")) then . else
          reject("component " + $component.name + " has a malformed source SHA") end
      # A release is one commit built four ways. The schema can already describe
      # a component from a different commit; nothing is allowed to deploy one
      # yet, and this is the check that has to be relaxed deliberately on the
      # day that changes.
      | if $component.sourceSha == $releaseSha then . else
          reject("component " + $component.name + " was built from " + $component.sourceSha
                 + ", not from the release commit") end
      | if $component.hostBundleMinVersion <= $releaseMinimum then . else
          reject("component " + $component.name + " needs host bundle "
                 + ($component.hostBundleMinVersion | tostring)
                 + " but the release only requires " + ($releaseMinimum | tostring)) end
    );

(require_string(.sha; "release SHA")) as $releaseSha
| (if ($releaseSha | test("^[0-9a-f]{40}$")) then . else reject("release SHA is malformed") end)
| (require_number(.hostBundleMinVersion; "release host bundle minimum")) as $releaseMinimum
| (normalised | validated($registry; $releaseSha; $releaseMinimum))
| .[]
| (.name | ascii_upcase | gsub("-"; "_")) as $variable
| $variable + "_DIGEST=" + (.digest | ltrimstr("sha256:"))
