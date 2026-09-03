variable "REGISTRY" {
  default = "ghcr.io/adnanalmahmut/ai-agent"
}

variable "IMAGE_TAG" {
  default = "development"
}

# The minimum host-bundle version a release built from this tree can run on.
# `ops/host-bundle/MIN_VERSION` is the source of truth; the publish workflow
# exports it into this variable and ops/tests/host-bundle.sh fails when the two
# disagree. The default is deliberately not a real version: an image built
# outside that workflow must not be able to claim it satisfies a host.
variable "HOST_BUNDLE_MIN_VERSION" {
  default = "0"
}

group "release" {
  targets = ["backend", "backend-migration", "web", "platform"]
}

target "common" {
  context = "."
  platforms = ["linux/amd64"]
  attest = ["type=provenance,mode=max", "type=sbom"]

  # How a release tells a host what it needs. The deploy script reads both
  # labels after `compose pull` and before migrations: the SHA proves the four
  # digests are one release rather than four unrelated builds, and the minimum
  # is compared against the bundle version the host has recorded. Carried on the
  # image because the image is what the host actually receives — the forced
  # command over the CI deploy key stays exactly as wide as it is.
  labels = {
    "io.ai-agent.release.sha" = "${IMAGE_TAG}"
    "io.ai-agent.host-bundle.min-version" = "${HOST_BUNDLE_MIN_VERSION}"
  }
}

target "backend" {
  inherits = ["common"]
  dockerfile = "apps/backend/Dockerfile"
  target = "runtime"
  tags = ["${REGISTRY}/backend:${IMAGE_TAG}"]
}

target "backend-migration" {
  inherits = ["common"]
  dockerfile = "apps/backend/Dockerfile"
  target = "migration"
  tags = ["${REGISTRY}/backend-migration:${IMAGE_TAG}"]
}

target "web" {
  inherits = ["common"]
  dockerfile = "apps/web/Dockerfile"
  target = "runtime"
  tags = ["${REGISTRY}/web:${IMAGE_TAG}"]
}

target "platform" {
  inherits = ["common"]
  dockerfile = "apps/platform/Dockerfile"
  target = "runtime"
  args = {
    NEXT_PUBLIC_APP_NAME = "Feedogo"
  }
  tags = ["${REGISTRY}/platform:${IMAGE_TAG}"]
}
