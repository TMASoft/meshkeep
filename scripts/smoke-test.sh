#!/usr/bin/env bash
# Boot-smoke a built MeshKeep image against the mock radio.
#
# Proves the image starts, serves the web UI plus the liveness/readiness probes,
# and actually connects to a radio over TCP (wired to the in-repo mock radio).
# Used by CI (.github/workflows/ci.yml) and runnable locally:
#
#   npm ci && npm run build --workspace @meshkeep/shared
#   docker build -f docker/Dockerfile -t meshkeep:smoke .
#   IMAGE=meshkeep:smoke scripts/smoke-test.sh
#
# Requires: docker, curl, and (for the mock radio) node + the workspace deps.
# Uses host networking, so it targets Linux Docker hosts (e.g. GitHub runners).
set -euo pipefail

IMAGE="${IMAGE:-meshkeep:smoke}"
HTTP_PORT="${HTTP_PORT:-18080}"
MOCK_PORT="${MOCK_PORT:-15100}"
# how to launch the mock radio; override if tsx/npm is unavailable on PATH
MOCK_CMD="${MOCK_CMD:-npm run --silent mock-radio --workspace @meshkeep/server}"
CONTAINER="meshkeep-smoke-$$"
MOCK_LOG="$(mktemp)"
MOCK_PID=""

log() { printf '[smoke] %s\n' "$*"; }
dump() { log "--- container logs ---"; docker logs "$CONTAINER" 2>&1 | tail -40 || true; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; dump; exit 1; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" >/dev/null 2>&1 || true
  rm -f "$MOCK_LOG"
}
trap cleanup EXIT

base="http://127.0.0.1:$HTTP_PORT"

# 1. start the mock radio (TCP) on the host
log "starting mock radio on :$MOCK_PORT"
MOCK_RADIO_PORT="$MOCK_PORT" $MOCK_CMD >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 30); do
  grep -q "point the server at it" "$MOCK_LOG" 2>/dev/null && break
  kill -0 "$MOCK_PID" 2>/dev/null || fail "mock radio exited early:\n$(cat "$MOCK_LOG")"
  sleep 1
done

# 2. boot the image, wired to the mock radio over the host network
log "starting container from $IMAGE"
docker run -d --name "$CONTAINER" --network host \
  -e MESHKEEP_PORT="$HTTP_PORT" \
  -e MESHKEEP_CONNECTION=tcp \
  -e MESHKEEP_TCP_HOST=127.0.0.1 \
  -e MESHKEEP_TCP_PORT="$MOCK_PORT" \
  "$IMAGE" >/dev/null

# 3. readiness (process up AND schema migrated) within a bounded window
log "waiting for readiness at $base/api/readyz"
ready=""
for _ in $(seq 1 60); do
  if [ "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/readyz" 2>/dev/null || true)" = "200" ]; then
    ready=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ] || fail "container exited before readiness"
  sleep 1
done
[ -n "$ready" ] || fail "readyz never returned 200"
log "readyz 200"

# 4. liveness
[ "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/healthz" 2>/dev/null || true)" = "200" ] || fail "healthz did not return 200"
log "healthz 200"

# 5. web UI served (SPA shell)
curl -fsS "$base/" | grep -qi '<div id="app"' || fail "web UI index not served"
log "web UI served"

# 6. radio actually connected (auth is a no-op with no UI password set)
log "waiting for radio connection"
connected=""
for _ in $(seq 1 30); do
  if curl -fsS "$base/api/v1/status" 2>/dev/null | grep -q '"state":"connected"'; then
    connected=1
    break
  fi
  sleep 1
done
[ -n "$connected" ] || fail "radio never reached connected state"

log "OK — image boots, serves UI + probes, and connects to the mock radio"
