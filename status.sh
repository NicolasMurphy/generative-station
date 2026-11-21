#!/bin/sh
# Read-only health report for the server, run by the Status workflow.
#
# The repository is public and so are its CI logs, so this prints no
# environment, addresses or access logs: only what is running, how loaded
# the machine is, and what the station has reported about itself.
set -eu
cd "$(dirname "$0")"

echo "== commit: $(git rev-parse --short HEAD)"
echo "== host: $(nproc) cpu(s), load $(cut -d' ' -f1-3 /proc/loadavg), up $(awk '{printf "%.1f days", $1 / 86400}' /proc/uptime)"
free -m | awk 'NR == 2 {printf "   memory: %d MB used of %d MB\n", $3, $2}'
df -h / | awk 'NR == 2 {printf "   disk: %s used of %s (%s)\n", $3, $2, $5}'

echo "== containers"
docker compose ps

echo "== container cpu / memory right now"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' \
    gs-icecast gs-station gs-picker gs-caddy

echo "== processes in the station container (average cpu, minutes running)"
docker compose exec -T station ps -eo pcpu,etimes,comm --sort=-pcpu \
    | awk 'NR > 1 && NR < 8 {printf "   %5s%%  %7.0f min  %s\n", $1, $2 / 60, $3}'

echo "== station since its last start"
started=$(docker inspect -f '{{.State.StartedAt}}' gs-station)
restarts=$(docker inspect -f '{{.RestartCount}}' gs-station)
echo "   started $started, restarted $restarts time(s) by docker"
logs=$(docker logs --since "$started" gs-station 2>&1 || true)
count() {
    printf '%s\n' "$logs" | grep -ci -- "$1" || true
}
echo "   xruns: $(count xrun)   late bundles: $(count '^late ')   server failures: $(count 'FAILURE IN SERVER')   errors: $(count '^ERROR')"
printf '%s\n' "$logs" | grep -E '^\[(piece|station|percussion|supervisor)\]' | tail -12 | sed 's/^/   /'

echo "== stream speed against real time (takes a minute)"
# Decode the stream for 10 s and then for 50 s of wall-clock time. The extra
# audio decoded over the extra 40 s is the rate the station produces audio
# at; Icecast's burst on connect is in both and cancels out. A station that
# runs slow starves listeners' buffers (cutouts); one that runs fast gets
# them dropped for falling behind.
decoded() {
    docker compose exec -T station timeout "$1" ffmpeg -hide_banner -nostdin \
        -i http://icecast:8000/stream -f null - 2>&1 \
        | tr '\r' '\n' | sed -n 's/.*time=\([0-9:.]*\).*/\1/p' | tail -1 \
        | awk -F: '{print $1 * 3600 + $2 * 60 + $3}'
}
short=$(decoded 10)
long=$(decoded 50)
if [ -n "$short" ] && [ -n "$long" ]; then
    awk "BEGIN { printf \"   %.3f x real time (1.000 is exact; this measurement is good to about 0.01)\n\", ($long - $short) / 40 }"
else
    echo "   could not measure"
fi

echo "== ssh host key fingerprints"
for f in /etc/ssh/ssh_host_*_key.pub; do
    ssh-keygen -l -f "$f" | awk '{print "   " $2 " " $4}'
done
