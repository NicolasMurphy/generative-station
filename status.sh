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
printf '%s\n' "$logs" | grep -E '^\[(piece|station|percussion|weather|plucks)\]' | tail -14 | sed 's/^/   /'

echo "== stream speed against real time (takes a minute and a half)"
# One listener, timed: decode the stream and count the audio that arrives
# between the 15 s and 75 s marks. By then Icecast's burst on connect has
# been consumed, so audio arrives exactly as fast as the station makes it.
# A station that runs slow starves listeners' buffers (cutouts); one that
# runs fast gets them dropped for falling behind.
docker compose exec -T station python3 -c '
import subprocess, sys, time
ffmpeg = subprocess.Popen(
    ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", sys.argv[1],
     "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], stdout=subprocess.PIPE)
start = first = last = None
count = 0
while True:
    chunk = ffmpeg.stdout.read(1600)          # 0.1 s of 8 kHz mono 16-bit audio
    if not chunk:
        break
    now = time.monotonic()
    start = start or now
    count += len(chunk)
    if first is None and now - start >= 15:
        first = (now, count)
    if now - start >= 75:
        last = (now, count)
        break
ffmpeg.kill()
if first and last:
    rate = (last[1] - first[1]) / 16000 / (last[0] - first[0])
    print("   %.4f x real time (1.0000 is exact; good to about 0.003)" % rate)
else:
    print("   could not measure")
' http://icecast:8000/stream || echo "   could not measure"

echo "== ssh host key fingerprints"
for f in /etc/ssh/ssh_host_*_key.pub; do
    ssh-keygen -l -f "$f" | awk '{print "   " $2 " " $4}'
done
