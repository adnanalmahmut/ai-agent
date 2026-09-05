#!/bin/sh
# The repository's single entry point for Docker Compose.
#
# Callers reach Compose through here rather than naming the file themselves.
# The file is still at the repository root and this change does not move it;
# centralising the invocation first is what makes that move one edit here
# instead of a search across workspaces.
set -eu

# Derived from this script's own location, not from the caller's directory, so
# the same invocation works from the repository root, from a workspace, or from
# anywhere else. The previous callers used `-f ../../docker-compose.yml` and
# were correct only when run from a workspace two levels down.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose_file="$repo_root/docker-compose.yml"

# The Compose project name owns the container, network, and volume names that
# already exist on developer machines and on the host. It is stated here as
# well as in the file so that relocating the file cannot silently rename the
# project — and with it, orphan the volumes holding local data.
project_name=ai-agent

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available on PATH" >&2
  exit 127
fi

if [ ! -f "$compose_file" ]; then
  echo "compose file not found: $compose_file" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $(basename -- "$0") <compose arguments>" >&2
  exit 2
fi

# Reaching Compose through a wrapper would otherwise route around the agent
# safety hook, which recognises the destructive form only when it is spelled as
# a docker command. Refusing it here keeps the existing guarantee: these
# commands never take local database volumes with them.
teardown=false
destructive=false
for argument in "$@"; do
  case "$argument" in
    down) teardown=true ;;
    -v | --volumes | --rmi) destructive=true ;;
  esac
done

if [ "$teardown" = true ] && [ "$destructive" = true ]; then
  echo "refusing to remove volumes or images: run docker compose directly if that is really intended" >&2
  exit 2
fi

# `exec` so Compose owns the terminal and its exit status is the script's.
exec docker compose \
  --file "$compose_file" \
  --project-name "$project_name" \
  "$@"
