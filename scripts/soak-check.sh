#!/bin/sh
# Soak monitor for the 24h validation item: logs health, connection state, and
# container memory every INTERVAL seconds so drift/reconnect problems are
# reviewable afterwards instead of anecdotal.
#
#   ./scripts/soak-check.sh [url] [container] [logfile] [interval-seconds]
#
# Defaults: http://localhost:8080, container "meshkeep", ./soak.log, 300s.
# Stop with Ctrl-C; review with e.g.:
#   grep -v 'state=connected' soak.log     # any moment it wasn't connected
#   awk '{print $NF}' soak.log | sort -u   # memory trend

URL="${1:-http://localhost:8080}"
CONTAINER="${2:-meshkeep}"
LOG="${3:-soak.log}"
INTERVAL="${4:-300}"

echo "soak-check: $URL container=$CONTAINER every ${INTERVAL}s -> $LOG"
while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  health=$(curl -sf --max-time 10 "$URL/api/healthz" | tr -d ' \n' || echo 'UNREACHABLE')
  state=$(curl -sf --max-time 10 "$URL/api/v1/status" 2>/dev/null \
    | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')
  mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null | cut -d/ -f1 | tr -d ' ')
  echo "$ts health=$health state=${state:-n/a} mem=${mem:-n/a}" >> "$LOG"
  sleep "$INTERVAL"
done
