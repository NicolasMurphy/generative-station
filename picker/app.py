import logging
import os
import time
from threading import Lock

from flask import Flask, jsonify, request
from pythonosc.udp_client import SimpleUDPClient

WEBHOOK_SECRET = os.environ["STATION_WEBHOOK_SECRET"]
SC_HOST = os.environ.get("SC_HOST", "station")
SC_PORT = int(os.environ.get("SC_PORT", "57120"))
DEBOUNCE_SECONDS = float(os.environ.get("DEBOUNCE_SECONDS", "30"))

MAX_COMPOUND_LEN = 349
ALLOWED_ALGORITHMS = {"linear", "inverse", "modulo"}
MAX_PEAKS = 100
MIN_FREQ = 20.0
MAX_FREQ = 20000.0

app = Flask(__name__)
osc_client = SimpleUDPClient(SC_HOST, SC_PORT)

_last_event_time = 0.0
_current_compound = None  # latest accepted event, exposed via GET /current
_lock = Lock()


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
        if not isinstance(f, (int, float)) or not MIN_FREQ <= f <= MAX_FREQ:
            return f"frequency {f} out of audible range [{MIN_FREQ}, {MAX_FREQ}]"
    for a in amps:
        if not isinstance(a, (int, float)) or not 0.0 <= a <= 1.0:
            return f"amplitude {a} out of range [0, 1]"

    return None


@app.post("/webhook")
def webhook():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] != WEBHOOK_SECRET:
        return jsonify({"error": "unauthorized"}), 401

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "json body required"}), 400

    err = validate_payload(data)
    if err:
        app.logger.warning("rejected: %s", err)
        return jsonify({"error": err}), 400

    global _last_event_time, _current_compound
    now = time.time()
    freqs = data["frequencies"]
    amps = data["amplitudes"]
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

    osc_args = [
        data["compound"],
        data["accession"],
        data["algorithm"],
        len(freqs),
        *freqs,
        *amps,
    ]
    osc_client.send_message("/compound", osc_args)
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
