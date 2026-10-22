#!/usr/bin/env bash
# Update an existing Pi installation; never recreate its database/proxy services.
set -Eeuo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
if (( $# > 1 )) || [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/deploy-pi-image.sh [ghcr.io/OWNER/REPO:TAG | --rollback]'
  exit 0
fi
mkdir -p .pi-image
exec 9>.pi-image/lock
flock -n 9 || { echo 'Another image deployment is running.' >&2; exit 1; }

case $(docker info --format '{{.Architecture}}') in
  aarch64|arm64) ;;
  *) echo 'This image requires a linux/arm64 Docker host.' >&2; exit 1 ;;
esac
if ! docker compose up --help | grep -- --wait-timeout >/dev/null; then
  echo 'Docker Compose with --wait-timeout support is required (v2.20+).' >&2
  exit 1
fi

compose_files=()
if [[ -n ${COMPOSE_FILE:-} ]]; then
  IFS="${COMPOSE_PATH_SEPARATOR:-:}" read -r -a configured_files <<< "$COMPOSE_FILE"
  for file in "${configured_files[@]}"; do
    [[ -f $file ]] || { echo "Missing Compose file: $file" >&2; exit 1; }
    compose_files+=(-f "$file")
  done
else
  compose_files=(-f docker-compose.yml)
  for file in docker-compose.override.yml docker-compose.override.yaml; do
    if [[ -f $file ]]; then compose_files+=(-f "$file"); break; fi
  done
fi
compose_files+=(-f docker-compose.image.yml)
compose() { docker compose "${compose_files[@]}" "$@"; }

# Retain only the two actual app image IDs (new/current and old/rollback).
# Removing a tag never removes layers that either retained image still uses.
# Keep this narrowly scoped: other projects, volumes and containers are untouched.
prune_obsolete_streaming_image_tags() {
  local ref image_id repository removed=0
  local -a obsolete_refs=()
  while read -r ref image_id; do
    [[ -n $ref && -n $image_id ]] || continue
    repository=${ref%:*}
    case "$repository" in
      ghcr.io/pingpingjinping/streaming-project|streaming-project-anime|streaming-project-rollback) ;;
      *) continue ;;
    esac
    [[ $image_id == "$new_image" || $image_id == "$old_image" ]] && continue
    obsolete_refs+=("$ref")
  done < <(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}')

  for ref in "${obsolete_refs[@]}"; do
    if docker image rm "$ref"; then
      ((removed+=1))
    else
      echo "Warning: could not remove unused streaming image tag: $ref" >&2
    fi
  done
  echo "Streaming images: current + previous retained; obsolete tags removed: $removed"
}

rollback=false
requested=${1:-ghcr.io/pingpingjinping/streaming-project:main-arm64}
if [[ $requested == --rollback ]]; then
  rollback=true
  [[ -s .pi-image/previous ]] || { echo 'No previous image has been saved.' >&2; exit 1; }
  IFS= read -r requested < .pi-image/previous
fi
[[ $requested =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$ ]] || { echo 'Invalid image reference.' >&2; exit 1; }
export ANIME_IMAGE=$requested
compose config --quiet
container=$(compose ps -q anime)
[[ -n $container ]] || { echo 'Start the existing anime installation before using this updater.' >&2; exit 1; }
old_image=$(docker inspect --format '{{.Image}}' "$container")

# Download and inspect before stopping the working container. Authentication or
# network failures leave it running, with no change to the rollback state.
if [[ $rollback == false ]]; then docker pull --platform linux/arm64 "$requested"; fi
architecture=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$requested")
[[ $architecture == linux/arm64 ]] || { echo "Unexpected image architecture: $architecture" >&2; exit 1; }
new_image=$(docker image inspect --format '{{.Id}}' "$requested")
if [[ $new_image == "$old_image" ]]; then
  echo "Already running: $requested ($new_image)"
  exit 0
fi

# A tag protects the old image from ordinary dangling-image cleanup. Save before
# replacement so --rollback is still available if SSH disconnects midway.
previous="streaming-project-rollback:${old_image#sha256:}"
docker tag "$old_image" "$previous"
printf '%s\n' "$previous" > .pi-image/previous.tmp
mv .pi-image/previous.tmp .pi-image/previous
export ANIME_IMAGE=$new_image
if compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 anime; then
  printf '%s\n' "$new_image" > .pi-image/current.tmp
  mv .pi-image/current.tmp .pi-image/current
  echo "Healthy: $requested ($new_image)"
  prune_obsolete_streaming_image_tags
else
  echo 'New image did not become healthy; restoring the previous image.' >&2
  export ANIME_IMAGE=$old_image
  if compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 anime; then
    echo 'Previous image restored. Deployment failed.' >&2
  else
    echo 'Rollback also failed. Check: docker logs --tail 100 anime' >&2
  fi
  exit 1
fi
