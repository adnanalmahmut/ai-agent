variable "REGISTRY" {
  default = "ghcr.io/adnanalmahmut/ai-agent"
}

variable "IMAGE_TAG" {
  default = "development"
}

group "release" {
  targets = ["backend", "backend-migration", "web", "platform"]
}

target "common" {
  context = "."
  platforms = ["linux/amd64"]
  attest = ["type=provenance,mode=max", "type=sbom"]
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
  tags = ["${REGISTRY}/platform:${IMAGE_TAG}"]
}
