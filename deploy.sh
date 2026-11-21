#!/bin/sh
# Brings the running stack in line with the checked-out commit, then checks
# that the stream actually came back.
#
#   ./deploy.sh [previous-commit]
#
# Run on the server after updating the checkout. The deploy workflow passes
# the commit the server was on before the update, so only what changed is
# rebuilt and restarted. Without it, everything is treated as changed.
set -eu
cd "$(dirname "$0")"

OLD="${1:-}"
HEALTH_TRIES="${HEALTH_TRIES:-40}"
HEALTH_SLEEP="${HEALTH_SLEEP:-3}"

# True if anything under the given paths differs between $OLD and HEAD.
changed() {
    [ -z "$OLD" ] || ! git diff --quiet "$OLD" HEAD -- "$@"
}

container_id() {
    docker inspect -f '{{.Id}}' "$1" 2>/dev/null || true
}

# Rebuild only the images whose sources changed. "up -d --build" on every
# deploy gave each image a new ID even when every layer was cached, so
# compose recreated every container and a README edit restarted the stream.
to_build=""
for svc in icecast station picker; do
    if changed "$svc/"; then
        to_build="$to_build $svc"
    fi
done
if [ -n "$to_build" ]; then
    echo "building:$to_build"
    # shellcheck disable=SC2086
    docker compose build $to_build
fi

icecast_before=$(container_id gs-icecast)
station_before=$(container_id gs-station)
caddy_before=$(container_id gs-caddy)
docker compose up -d
icecast_after=$(container_id gs-icecast)
station_after=$(container_id gs-station)
caddy_after=$(container_id gs-caddy)

# Compose only replaces a container when its image or configuration changed.
# Files that are bind-mounted into a running container need a restart of
# their own: the .scd files are read once when sclang starts, and a new
# Icecast container drops the station's encoder connection.
station_restarted=""
if [ "$station_before" != "$station_after" ]; then
    station_restarted=1
elif changed station/ || [ "$icecast_before" != "$icecast_after" ]; then
    echo "restarting station"
    docker compose restart station
    station_restarted=1
fi
if [ "$caddy_before" = "$caddy_after" ] && changed caddy/; then
    echo "restarting caddy"
    docker compose restart caddy
fi

# A finished deploy should mean a working stream. sclang keeps running after
# an error in the piece, so a broken .scd file would otherwise deploy cleanly
# and stream silence.
failed=""

if [ -n "$station_restarted" ]; then
    echo "waiting for the station to start streaming..."
    station_ok=""
    i=0
    while [ "$i" -lt "$HEALTH_TRIES" ]; do
        started=$(docker inspect -f '{{.State.StartedAt}}' gs-station 2>/dev/null || true)
        logs=$(docker logs --since "$started" gs-station 2>&1 || true)
        case "$logs" in
            *"[piece] all elements running"*)
                case "$logs" in
                    *"[station] streaming"*) station_ok=1 ;;
                esac
                ;;
        esac
        if [ -n "$station_ok" ]; then
            break
        fi
        i=$((i + 1))
        sleep "$HEALTH_SLEEP"
    done
    if [ -n "$station_ok" ]; then
        echo "station is streaming"
    else
        echo "FAILED: the station did not start streaming. Last log lines:"
        docker logs --tail 60 gs-station 2>&1 || true
        failed=1
    fi
fi

picker_ok=""
i=0
while [ "$i" -lt "$HEALTH_TRIES" ]; do
    if docker compose exec -T picker python -c \
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/health', timeout=3)" \
        >/dev/null 2>&1; then
        picker_ok=1
        break
    fi
    i=$((i + 1))
    sleep "$HEALTH_SLEEP"
done
if [ -z "$picker_ok" ]; then
    echo "FAILED: the picker is not answering /health. Last log lines:"
    docker logs --tail 30 gs-picker 2>&1 || true
    failed=1
fi

for c in gs-icecast gs-station gs-picker gs-caddy; do
    running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
    if [ "$running" != "true" ]; then
        echo "FAILED: $c is not running"
        failed=1
    fi
done

docker compose ps

if [ -n "$failed" ]; then
    exit 1
fi
echo "deploy ok: $(git rev-parse --short HEAD)"
