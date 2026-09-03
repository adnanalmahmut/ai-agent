variable "REGISTRY" {
  default = "ghcr.io/adnanalmahmut/ai-agent"
}

variable "IMAGE_TAG" {
  default = "development"
}

# The publish workflow supplies the value from ops/host-bundle/MIN_VERSION.
# Zero prevents an ad hoc build from claiming host compatibility.
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

  # The deploy gate uses these immutable-image labels to prove release identity
  # and host compatibility before migrations run.
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
