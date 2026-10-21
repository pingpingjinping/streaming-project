#!/usr/bin/env bash
set -Eeuo pipefail
image=${1:?Image reference required}
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") == linux/arm64 ]]
docker run --rm "$image" node -e 'if(process.arch!=="arm64")process.exit(1); require("sharp"); require("fs").accessSync("scripts/subtitle-cache/cleanup.cjs");'
docker run --rm "$image" chromium --version

network="anime-smoke-$$"
db="anime-smoke-db-$$"
app="anime-smoke-app-$$"
cleanup() {
  status=$?
  if (( status != 0 )); then docker logs "$app" || true; fi
  docker rm -fv "$app" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
docker network create "$network" >/dev/null
docker run -d --name "$db" --network "$network" \
  -e POSTGRES_PASSWORD=smoke-test -e POSTGRES_DB=anime postgres:17-alpine >/dev/null
for attempt in {1..60}; do
  if docker exec "$db" pg_isready -U postgres -d anime; then break; fi
  sleep 1
done
docker exec "$db" pg_isready -U postgres -d anime
docker run -d --name "$app" --network "$network" \
  -e "DATABASE_URL=postgresql://postgres:smoke-test@$db:5432/anime" \
  -e AUTH_SECRET=ci-only-not-a-production-secret "$image" >/dev/null
docker exec "$app" node -e '
  (async()=>{
    for(let n=0;n<60;n++) {
      try {
        const r=await fetch("http://127.0.0.1:3000/api/auth/setup-status",{signal:AbortSignal.timeout(3000)});
        const body=await r.json();
        if(r.ok && body.needsSetup===true && body.userCount===0) return;
      } catch {}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw Error("ARM64 app/DB health check failed");
  })().catch(e=>{console.error(e);process.exit(1)});
'
