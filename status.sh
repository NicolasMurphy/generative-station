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

echo "== ssh host key fingerprints"
for f in /etc/ssh/ssh_host_*_key.pub; do
    ssh-keygen -l -f "$f" | awk '{print "   " $2 " " $4}'
done
