import hashlib
import hmac
import json
import logging
import os
import time
import urllib.request
from datetime import datetime
from threading import Lock, Thread

from flask import Flask, jsonify, request
from pythonosc.udp_client import SimpleUDPClient

WEBHOOK_SECRET = os.environ["STATION_WEBHOOK_SECRET"]
SC_HOST = os.environ.get("SC_HOST", "station")
SC_PORT = int(os.environ.get("SC_PORT", "57120"))
# The station changes compound at most once per DEBOUNCE_SECONDS. A compound
# that arrives sooner is held, and the newest one held is applied when the
# window ends, so the station always ends up on the latest compound.
DEBOUNCE_SECONDS = float(os.environ.get("DEBOUNCE_SECONDS", "30"))
# The station forgets the compound when its container restarts. Re-sending
# the current one keeps the stream and GET /current in agreement.
RESEND_SECONDS = float(os.environ.get("RESEND_SECONDS", "60"))

# Listener count and stream start come from Icecast's status page, which is
# only reachable inside the compose network.
ICECAST_STATUS_URL = os.environ.get(
    "ICECAST_STATUS_URL", "http://icecast:8000/status-json.xsl"
)
ICECAST_MOUNT = os.environ.get("ICECAST_MOUNT", "/stream")
ICECAST_POLL_SECONDS = float(os.environ.get("ICECAST_POLL_SECONDS", "5"))
# The visit counter is the only state that outlives the container.
VISITS_FILE = os.path.join(os.environ.get("PICKER_DATA_DIR", "/data"), "visits.json")
# One address counts as one visit per this many seconds.
VISIT_COOLDOWN_SECONDS = float(os.environ.get("VISIT_COOLDOWN_SECONDS", str(12 * 3600)))

MAX_COMPOUND_LEN = 349
ALLOWED_ALGORITHMS = {"linear", "inverse", "modulo"}
MAX_PEAKS = 100
MIN_FREQ = 20.0
MAX_FREQ = 20000.0

app = Flask(__name__)
osc_client = SimpleUDPClient(SC_HOST, SC_PORT)

_last_change_time = 0.0  # when the station last changed compound
_last_send_time = 0.0
_current_compound = None  # the compound now playing, exposed via GET /current
_current_osc_args = None  # the same compound as sent to SuperCollider
_pending = None  # (compound, osc_args) waiting for the debounce window to end
_lock = Lock()

_listeners = None  # listeners on the stream right now; None while unknown
_stream_started = None  # epoch seconds the encoder connected; None while down
_last_icecast_poll = 0.0
_recent_visitors = {}  # salted hash of an address -> when it was last counted
_visitor_salt = os.urandom(16)  # addresses are never stored or written out


def _load_visits():
    try:
        with open(VISITS_FILE, encoding="utf-8") as f:
            return max(0, int(json.load(f)["visits"]))
    except (OSError, ValueError, KeyError, TypeError):
        return 0


def _save_visits(count):
    try:
        os.makedirs(os.path.dirname(VISITS_FILE), exist_ok=True)
        tmp = VISITS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"visits": count}, f)
        os.replace(tmp, VISITS_FILE)
    except OSError as exc:  # no volume mounted: the count lives in memory only
        app.logger.warning("could not save the visit count: %s", exc)


_visits = _load_visits()


def read_icecast():
    """Returns (listeners, stream start as epoch seconds) for the stream's
    mount, or (None, None) when Icecast has no source or cannot be reached."""
    try:
        with urllib.request.urlopen(ICECAST_STATUS_URL, timeout=2) as response:
            stats = json.loads(response.read().decode("utf-8", "replace"))
        sources = stats["icestats"].get("source")
    except (OSError, ValueError, KeyError, AttributeError):
        return None, None
    if isinstance(sources, dict):  # one mount is an object, several are a list
        sources = [sources]
    for source in sources or []:
        if str(source.get("listenurl", "")).endswith(ICECAST_MOUNT):
            started = None
            try:
                started = datetime.strptime(
                    source["stream_start_iso8601"], "%Y-%m-%dT%H:%M:%S%z"
                ).timestamp()
            except (KeyError, ValueError, TypeError):
                pass
            listeners = source.get("listeners")
            return (listeners if _is_number(listeners) else None), started
    return None, None


def _is_number(value):
    # bool is a subclass of int, and a JSON true would reach SuperCollider as
    # a non-number and kill the voice that tries to multiply by it.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def send_compound(osc_args):
    try:
        osc_client.send_message("/compound", osc_args)
        return True
    except OSError as exc:  # station container down or not resolvable yet
        app.logger.warning("osc send failed: %s", exc)
        return False


def _make_current(compound, osc_args, now):
    # Caller holds _lock.
    global _last_change_time, _last_send_time, _current_compound, _current_osc_args
    _last_change_time = now
    _last_send_time = now
    _current_compound = compound
    _current_osc_args = osc_args


def tick(now=None):
    """Periodic work: apply a held compound once the debounce window has
    ended, otherwise re-send the current one every RESEND_SECONDS; and keep
    the listener count and stream start fresh."""
    global _pending, _last_send_time, _listeners, _stream_started, _last_icecast_poll
    now = time.time() if now is None else now
    if now - _last_icecast_poll >= ICECAST_POLL_SECONDS:
        _last_icecast_poll = now
        listeners, started = read_icecast()  # outside the lock: it does I/O
        with _lock:
            _listeners, _stream_started = listeners, started
    osc_args = None
    with _lock:
        if _pending is not None and now - _last_change_time >= DEBOUNCE_SECONDS:
            compound, osc_args = _pending
            _pending = None
            _make_current(compound, osc_args, now)
            app.logger.info("applied held compound: %s", compound["name"])
        elif (
            _current_osc_args is not None
            and RESEND_SECONDS > 0
            and now - _last_send_time >= RESEND_SECONDS
        ):
            osc_args = _current_osc_args
            _last_send_time = now
    if osc_args is not None:
        send_compound(osc_args)


def _background_loop():
    while True:
        time.sleep(1)
        try:
            tick()
        except Exception:  # keep the loop alive whatever happens
            app.logger.exception("background tick failed")


# Tests drive tick() themselves.
if os.environ.get("PICKER_BACKGROUND", "1") == "1":
    Thread(target=_background_loop, daemon=True).start()


def validate_payload(data):
    if not isinstance(data, dict):
        return "payload must be an object"

    required = ("compound", "accession", "algorithm", "frequencies", "amplitudes")
    missing = [f for f in required if f not in data]
    if missing:
        return f"missing fields: {missing}"

    compound = data["compound"]
    if not isinstance(compound, str) or not 1 <= len(compound) <= MAX_COMPOUND_LEN:
        return f"compound name invalid (must be 1-{MAX_COMPOUND_LEN} chars)"

    if not isinstance(data["accession"], str) or len(data["accession"]) > 100:
        return "accession invalid"

    if data["algorithm"] not in ALLOWED_ALGORITHMS:
        return f"algorithm must be one of {sorted(ALLOWED_ALGORITHMS)}"

    freqs = data["frequencies"]
    amps = data["amplitudes"]
    if not isinstance(freqs, list) or not isinstance(amps, list):
        return "frequencies and amplitudes must be lists"
    if len(freqs) != len(amps):
        return "frequencies and amplitudes must be same length"
    if not 1 <= len(freqs) <= MAX_PEAKS:
        return f"frequencies length must be 1-{MAX_PEAKS}"

    for f in freqs:
        if not _is_number(f) or not MIN_FREQ <= f <= MAX_FREQ:
            return f"frequency {f} out of audible range [{MIN_FREQ}, {MAX_FREQ}]"
    for a in amps:
        if not _is_number(a) or not 0.0 <= a <= 1.0:
            return f"amplitude {a} out of range [0, 1]"

    return None


@app.post("/webhook")
def webhook():
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    # An unset secret must never authorize anything.
    if not WEBHOOK_SECRET or not hmac.compare_digest(
        token.encode(), WEBHOOK_SECRET.encode()
    ):
        return jsonify({"error": "unauthorized"}), 401

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "json body required"}), 400

    err = validate_payload(data)
    if err:
        app.logger.warning("rejected: %s", err)
        return jsonify({"error": err}), 400

    global _pending
    now = time.time()
    freqs = data["frequencies"]
    amps = data["amplitudes"]
    osc_args = [
        data["compound"],
        data["accession"],
        data["algorithm"],
        len(freqs),
        *freqs,
        *amps,
    ]
    compound = {
        "name": data["compound"],
        "accession": data["accession"],
        "algorithm": data["algorithm"],
        "parameters": data.get("parameters", {}),
        "n_peaks": len(freqs),
    }
    with _lock:
        wait = DEBOUNCE_SECONDS - (now - _last_change_time)
        if wait > 0:
            # Held, not dropped: tick() applies the newest held compound.
            _pending = (compound, osc_args)
            app.logger.info("debounced: %s (applies in %.0f s)", data["compound"], wait)
            return jsonify({"status": "debounced", "applies_in": round(wait, 1)}), 200
        _pending = None
        _make_current(compound, osc_args, now)

    # A failed send is retried by the background loop.
    send_compound(osc_args)
    app.logger.info("accepted: %s (%d peaks)", data["compound"], len(freqs))
    return jsonify({"status": "ok"}), 200


@app.get("/current")
def current():
    with _lock:
        snapshot = _current_compound
    if snapshot is None:
        return ("", 204)
    return jsonify(snapshot), 200


@app.get("/stats")
def stats():
    """Everything the page shows, in one request."""
    with _lock:
        compound = _current_compound
        osc_args = _current_osc_args
        body = {
            "now": time.time(),  # lets the page ignore a wrong clock of its own
            "listeners": _listeners,
            "stream_started": _stream_started,
            "visits": _visits,
            "compound": None,
        }
    if compound is not None:
        n = osc_args[3]
        body["compound"] = {
            **compound,
            "frequencies": osc_args[4 : 4 + n],
            "amplitudes": osc_args[4 + n : 4 + 2 * n],
        }
    response = jsonify(body)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/visit")
def visit():
    """Counts a visit. The page calls this once per browser per half day; an
    address is also only counted once per VISIT_COOLDOWN_SECONDS."""
    global _visits
    now = time.time()
    address = request.headers.get("X-Forwarded-For", request.remote_addr or "")
    address = address.split(",")[0].strip()
    who = hashlib.sha256(_visitor_salt + address.encode()).digest()[:12]
    with _lock:
        if len(_recent_visitors) > 20000:
            for key in [k for k, t in _recent_visitors.items() if now - t >= VISIT_COOLDOWN_SECONDS]:
                del _recent_visitors[key]
        last = _recent_visitors.get(who)
        counted = last is None or now - last >= VISIT_COOLDOWN_SECONDS
        if counted:
            _recent_visitors[who] = now
            _visits += 1
        count = _visits
    if counted:
        _save_visits(count)
    return jsonify({"visits": count}), 200


@app.get("/health")
def health():
    return jsonify({"status": "ok"}), 200


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host="0.0.0.0", port=9000)
