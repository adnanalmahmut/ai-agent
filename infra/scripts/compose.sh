#!/bin/sh
# The repository's single entry point for Docker Compose.
#
# Callers reach Compose through here rather than naming the files themselves.
# Centralising the invocation is what made moving the file out of the
# repository root a single edit here instead of a search across workspaces, and
# it is what lets the model be split into a shared file plus one overlay per
# composition without any caller learning that it happened.
set -eu

# Derived from this script's own location, not from the caller's directory, so
# the same invocation works from the repository root, from a workspace, or from
# anywhere else. The previous callers used `-f ../../docker-compose.yml` and
# were correct only when run from a workspace two levels down.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose_dir="$repo_root/infra/compose"
compose_file="$compose_dir/compose.yaml"

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

# The files and the project name are what this interface owns, and Compose lets
# a later flag win over an earlier one. Without this, a caller could point the
# same command at another project — creating a second set of networks and
# volumes — or merge another file into the real ones.
#
# Reaching Compose through a wrapper would also route around the agent safety
# hook, which recognises the destructive teardown only when it is spelled as a
# docker command. Both long forms accept `--flag=value` as well as a separate
# argument, so both spellings are matched.
#
# Position decides which check applies, because the same letter means different
# things on either side of the subcommand: `-f` before it selects the compose
# file, and after it is `logs --follow`. Refusing it everywhere would break
# `db:logs`. Scanning also stops at a bare `--`, so a command run inside a
# container keeps its own flags.
#
# The same pass reads the requested profiles, because they decide which overlay
# the command gets. A global option that takes a separate value has to be
# recognised by name for that: its value is neither the subcommand nor a
# profile, and reading it as either would pick the wrong composition.
subcommand=''
pending_option=''
teardown=false
destructive=false
profiles=''

for argument in "$@"; do
  if [ "$argument" = '--' ]; then break; fi

  if [ -n "$pending_option" ]; then
    if [ "$pending_option" = '--profile' ]; then profiles="$profiles $argument"; fi
    pending_option=''
    continue
  fi

  if [ -z "$subcommand" ]; then
    case "$argument" in
      -f | -f?* | --file | --file=*)
        echo "refusing --file: this interface owns the compose files" >&2
        exit 2
        ;;
      -p | -p?* | --project-name | --project-name=*)
        echo "refusing --project-name: this interface derives the project from the composition" >&2
        exit 2
        ;;
      --project-directory | --project-directory=*)
        echo "refusing --project-directory: it moves how the project resolves" >&2
        exit 2
        ;;
      --profile=*) profiles="$profiles ${argument#--profile=}" ;;
      # Global options that take a separate value. Their value is not the
      # subcommand, so it must not be read as one.
      --profile | --env-file | --ansi | --progress | --parallel) pending_option=$argument ;;
      -*) ;;
      *) subcommand=$argument ;;
    esac
    continue
  fi

  # `-v/--volumes` is a boolean pflag, so `-v=true` is as valid as the bare
  # flag, and Compose still normalises the deprecated `--volume` onto it.
  # Matching only the spellings that appear in `--help` would leave the others
  # working.
  case "$argument" in
    -v | -v=* | --volume | --volume=* | --volumes | --volumes=*) destructive=true ;;
    --rmi | --rmi=*) destructive=true ;;
  esac
done

if [ "$subcommand" = down ]; then teardown=true; fi

if [ "$teardown" = true ] && [ "$destructive" = true ]; then
  echo "refusing to remove volumes or images: run docker compose directly if that is really intended" >&2
  exit 2
fi

# Which overlay a command gets is decided from the profiles it already asks
# for, so every existing call site keeps working unchanged and no caller has to
# learn a second way to say what it is doing.
#
# One composition per command. A request that spans two of them is refused
# rather than merged: `--profile development --profile test` would otherwise
# put the throwaway databases and the developer's own into a single project,
# which is the sharing this split exists to make impossible. An unknown profile
# is refused for the same reason — it would silently select the development
# composition and start development containers.
mode=''
for profile in $profiles; do
  case "$profile" in
    development) requested=dev ;;
    test) requested=test ;;
    staging | production | migration) requested=deploy ;;
    *)
      echo "refusing unknown profile: $profile" >&2
      exit 2
      ;;
  esac

  if [ -n "$mode" ] && [ "$mode" != "$requested" ]; then
    echo "refusing to combine the $mode and $requested compositions in one command" >&2
    exit 2
  fi
  mode=$requested
done

# A command that names no profile is a local one — `ps`, `logs`, `version` —
# and on a developer machine the local composition is development. This is what
# it resolved to before the split, when there was a single file and `ps` showed
# the development containers.
[ -n "$mode" ] || mode=dev

# The project name owns the container, network, and volume names. It is stated
# here as well as in the files so that editing one cannot silently rename the
# project — and with it, orphan the volumes holding local data. `test` has its
# own, which is what keeps a CI run from touching `ai-agent_postgres_data` or a
# container a developer is using.
case "$mode" in
  dev)
    overlay_file="$compose_dir/compose.dev.yaml"
    project_name=ai-agent
    ;;
  test)
    overlay_file="$compose_dir/compose.test.yaml"
    project_name=ai-agent-test
    ;;
  deploy)
    overlay_file="$compose_dir/compose.deploy.yaml"
    project_name=ai-agent
    ;;
esac

if [ ! -f "$overlay_file" ]; then
  echo "compose overlay not found: $overlay_file" >&2
  exit 1
fi

# `exec` so Compose owns the terminal and its exit status is the script's.
exec docker compose \
  --file "$compose_file" \
  --file "$overlay_file" \
  --project-name "$project_name" \
  "$@"
