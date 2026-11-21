import hmac
import logging
import os
import time
from threading import Lock, Thread

from flask import Flask, jsonify, request
from pythonosc.udp_client import SimpleUDPClient

WEBHOOK_SECRET = os.environ["STATION_WEBHOOK_SECRET"]
SC_HOST = os.environ.get("SC_HOST", "station")
SC_PORT = int(os.environ.get("SC_PORT", "57120"))
DEBOUNCE_SECONDS = float(os.environ.get("DEBOUNCE_SECONDS", "30"))
# The station forgets the compound when its container restarts. Re-sending
# the current one keeps the stream and GET /current in agreement.
RESEND_SECONDS = float(os.environ.get("RESEND_SECONDS", "60"))

MAX_COMPOUND_LEN = 349
ALLOWED_ALGORITHMS = {"linear", "inverse", "modulo"}
MAX_PEAKS = 100
MIN_FREQ = 20.0
MAX_FREQ = 20000.0

app = Flask(__name__)
osc_client = SimpleUDPClient(SC_HOST, SC_PORT)

_last_event_time = 0.0
_current_compound = None  # latest accepted event, exposed via GET /current
_current_osc_args = None  # the same event as sent to SuperCollider
_lock = Lock()


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


def _resend_loop():
    while True:
        time.sleep(RESEND_SECONDS)
        with _lock:
            osc_args = _current_osc_args
        if osc_args is not None:
            send_compound(osc_args)


if RESEND_SECONDS > 0:
    Thread(target=_resend_loop, daemon=True).start()


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

    global _last_event_time, _current_compound, _current_osc_args
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
    with _lock:
        if now - _last_event_time < DEBOUNCE_SECONDS:
            app.logger.info("debounced: %s", data["compound"])
            return jsonify({"status": "debounced"}), 200
        _last_event_time = now
        _current_compound = {
            "name": data["compound"],
            "accession": data["accession"],
            "algorithm": data["algorithm"],
            "parameters": data.get("parameters", {}),
            "n_peaks": len(freqs),
        }
        _current_osc_args = osc_args

    # A failed send is retried by the resend loop.
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


@app.get("/health")
def health():
    return jsonify({"status": "ok"}), 200


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host="0.0.0.0", port=9000)
