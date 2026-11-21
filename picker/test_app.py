"""Tests for the picker. Run with: python -m pytest picker"""

import os

os.environ["STATION_WEBHOOK_SECRET"] = "test-secret"
os.environ["SC_HOST"] = "127.0.0.1"
os.environ["DEBOUNCE_SECONDS"] = "30"
os.environ["RESEND_SECONDS"] = "60"
os.environ["PICKER_BACKGROUND"] = "0"  # the tests call tick() themselves
os.environ["PICKER_DATA_DIR"] = "/nonexistent-picker-data"  # each test sets its own file

import pytest

import app as picker

AUTH = {"Authorization": "Bearer test-secret"}


class FakeOsc:
    def __init__(self):
        self.sent = []
        self.fail = False

    def send_message(self, address, args):
        if self.fail:
            raise OSError("station is down")
        self.sent.append((address, list(args)))


@pytest.fixture
def osc(monkeypatch):
    fake = FakeOsc()
    monkeypatch.setattr(picker, "osc_client", fake)
    for name, value in [
        ("_last_change_time", 0.0),
        ("_last_send_time", 0.0),
        ("_current_compound", None),
        ("_current_osc_args", None),
        ("_pending", None),
        ("_listeners", None),
        ("_stream_started", None),
        ("_last_icecast_poll", 0.0),
        ("_visits", 0),
        ("_recent_visitors", {}),
    ]:
        monkeypatch.setattr(picker, name, value)
    monkeypatch.setattr(picker, "read_icecast", lambda: (None, None))
    return fake


@pytest.fixture
def clock(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(picker.time, "time", lambda: now[0])
    return now


@pytest.fixture
def client():
    return picker.app.test_client()


def payload(name="Choline", freqs=(356.2, 404.1), amps=(0.345, 1), **extra):
    body = {
        "compound": name,
        "accession": "ACC-1",
        "algorithm": "linear",
        "frequencies": list(freqs),
        "amplitudes": list(amps),
    }
    body.update(extra)
    return body


def post(client, body, headers=AUTH):
    return client.post("/webhook", json=body, headers=headers)


# --- auth -------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "test-secret"}, {"Authorization": "Bearer "}],
)
def test_rejects_bad_auth(client, osc, headers):
    assert post(client, payload(), headers).status_code == 401
    assert osc.sent == []


def test_empty_secret_authorizes_nothing(client, osc, monkeypatch):
    monkeypatch.setattr(picker, "WEBHOOK_SECRET", "")
    assert post(client, payload(), {"Authorization": "Bearer "}).status_code == 401
    assert post(client, payload(), {}).status_code == 401


# --- validation -------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        [1, 2, 3],
        {k: v for k, v in payload().items() if k != "accession"},
        payload(name=""),
        payload(name="x" * 350),
        payload(algorithm="other"),
        payload(freqs=(440,), amps=(1, 0.5)),
        payload(freqs=(), amps=()),
        payload(freqs=[440] * 101, amps=[1] * 101),
        payload(freqs=(19.9,), amps=(1,)),
        payload(freqs=(20000.1,), amps=(1,)),
        payload(freqs=("440",), amps=(1,)),
        payload(freqs=(440,), amps=(1.01,)),
        payload(freqs=(440,), amps=(-0.1,)),
        payload(freqs=(True,), amps=(1,)),
        payload(freqs=(440, 880), amps=(True, 0.5)),
    ],
)
def test_rejects_invalid_payload(client, osc, body):
    assert post(client, body).status_code == 400
    assert osc.sent == []


def test_rejects_non_json(client, osc):
    r = client.post("/webhook", data="not json", headers=AUTH)
    assert r.status_code == 400


# --- accepting a compound ---------------------------------------------------


def test_accepts_and_forwards(client, osc, clock):
    assert client.get("/current").status_code == 204
    r = post(client, payload(parameters={"offset": 300}))
    assert r.status_code == 200 and r.get_json() == {"status": "ok"}
    # [name, accession, algorithm, nPeaks, freq1..N, amp1..N]
    assert osc.sent == [("/compound", ["Choline", "ACC-1", "linear", 2, 356.2, 404.1, 0.345, 1])]
    assert client.get("/current").get_json() == {
        "name": "Choline",
        "accession": "ACC-1",
        "algorithm": "linear",
        "parameters": {"offset": 300},
        "n_peaks": 2,
    }


def test_send_failure_is_not_an_error_and_is_retried(client, osc, clock):
    osc.fail = True
    assert post(client, payload()).status_code == 200
    assert osc.sent == []
    osc.fail = False
    clock[0] += 60
    picker.tick()
    assert len(osc.sent) == 1 and osc.sent[0][1][0] == "Choline"


# --- debounce: the newest compound wins -------------------------------------


def test_compound_inside_the_window_is_held_then_applied(client, osc, clock):
    post(client, payload("A"))
    clock[0] += 10
    r = post(client, payload("B"))
    assert r.get_json() == {"status": "debounced", "applies_in": 20.0}
    clock[0] += 5
    assert post(client, payload("C")).get_json()["status"] == "debounced"
    # still inside the window: the station stays on A
    picker.tick()
    assert [m[1][0] for m in osc.sent] == ["A"]
    assert client.get("/current").get_json()["name"] == "A"
    # window over: the newest held compound (C, not B) is applied once
    clock[0] += 15
    picker.tick()
    picker.tick()
    assert [m[1][0] for m in osc.sent] == ["A", "C"]
    assert client.get("/current").get_json()["name"] == "C"


def test_applying_a_held_compound_starts_a_new_window(client, osc, clock):
    post(client, payload("A"))
    clock[0] += 10
    post(client, payload("B"))
    clock[0] += 20
    picker.tick()  # B applied at the end of A's window
    clock[0] += 5
    assert post(client, payload("C")).get_json() == {"status": "debounced", "applies_in": 25.0}


def test_compound_after_the_window_applies_immediately(client, osc, clock):
    post(client, payload("A"))
    clock[0] += 30
    assert post(client, payload("B")).get_json() == {"status": "ok"}
    assert [m[1][0] for m in osc.sent] == ["A", "B"]


# --- re-sending the current compound ----------------------------------------


def test_resends_current_compound_every_resend_seconds(client, osc, clock):
    picker.tick()
    assert osc.sent == []  # nothing to re-send yet
    post(client, payload("A"))
    clock[0] += 59
    picker.tick()
    assert len(osc.sent) == 1
    clock[0] += 1
    picker.tick()
    picker.tick()
    assert [m[1][0] for m in osc.sent] == ["A", "A"]
    clock[0] += 60
    picker.tick()
    assert len(osc.sent) == 3


# --- stats for the page -----------------------------------------------------


def test_stats_before_anything(client, osc, clock):
    r = client.get("/stats")
    assert r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == {
        "now": clock[0], "listeners": None, "stream_started": None, "visits": 0, "compound": None,
    }


def test_stats_carries_the_compound_with_its_peaks(client, osc, clock):
    post(client, payload(parameters={"offset": 300}))
    assert client.get("/stats").get_json()["compound"] == {
        "name": "Choline", "accession": "ACC-1", "algorithm": "linear",
        "parameters": {"offset": 300}, "n_peaks": 2,
        "frequencies": [356.2, 404.1], "amplitudes": [0.345, 1],
    }
    # /current keeps its old, smaller shape
    assert "frequencies" not in client.get("/current").get_json()


def test_stats_follow_icecast(client, osc, clock, monkeypatch):
    monkeypatch.setattr(picker, "read_icecast", lambda: (3, 1_000_000.0 - 3600))
    picker.tick()
    body = client.get("/stats").get_json()
    assert body["listeners"] == 3 and body["stream_started"] == 1_000_000.0 - 3600
    # polled every ICECAST_POLL_SECONDS, not on every tick
    monkeypatch.setattr(picker, "read_icecast", lambda: (None, None))
    clock[0] += 1
    picker.tick()
    assert client.get("/stats").get_json()["listeners"] == 3
    clock[0] += 5
    picker.tick()  # stream gone
    body = client.get("/stats").get_json()
    assert body["listeners"] is None and body["stream_started"] is None


class FakeResponse:
    def __init__(self, text):
        self.text = text

    def read(self):
        return self.text.encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.mark.parametrize(
    "text, expected",
    [
        # one mount: "source" is an object
        ('{"icestats":{"source":{"listeners":2,"listenurl":"http://localhost:8000/stream",'
         '"stream_start_iso8601":"2026-11-21T21:56:53+0000"}}}', (2, 1795298213.0)),
        # several mounts: "source" is a list
        ('{"icestats":{"source":[{"listeners":9,"listenurl":"http://x/other"},'
         '{"listeners":0,"listenurl":"http://x/stream","stream_start_iso8601":"2026-11-21T21:56:53+0000"}]}}',
         (0, 1795298213.0)),
        ('{"icestats":{"admin":"a"}}', (None, None)),  # nothing is streaming
        ('{"icestats":{"source":{"listenurl":"http://x/stream","listeners":1}}}', (1, None)),
        ("not json", (None, None)),
    ],
)
def test_read_icecast(monkeypatch, text, expected):
    monkeypatch.setattr(picker.urllib.request, "urlopen", lambda url, timeout: FakeResponse(text))
    assert picker.read_icecast() == expected


def test_read_icecast_unreachable(monkeypatch):
    def refuse(url, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(picker.urllib.request, "urlopen", refuse)
    assert picker.read_icecast() == (None, None)


# --- visit counter ----------------------------------------------------------


def visit(client, address):
    return client.post("/visit", headers={"X-Forwarded-For": address}).get_json()["visits"]


def test_visits_count_each_address_once_per_cooldown(client, osc, clock, monkeypatch, tmp_path):
    monkeypatch.setattr(picker, "VISITS_FILE", str(tmp_path / "data" / "visits.json"))
    assert visit(client, "203.0.113.1") == 1
    assert visit(client, "203.0.113.1") == 1  # a reload is not a new visit
    assert visit(client, "203.0.113.2, 10.0.0.1") == 2  # first address in the chain
    clock[0] += 12 * 3600
    assert visit(client, "203.0.113.1") == 3  # back the next day
    assert client.get("/stats").get_json()["visits"] == 3


def test_visits_survive_a_restart(client, osc, clock, monkeypatch, tmp_path):
    monkeypatch.setattr(picker, "VISITS_FILE", str(tmp_path / "visits.json"))
    visit(client, "203.0.113.1")
    visit(client, "203.0.113.2")
    assert picker._load_visits() == 2
    assert "203.0.113" not in (tmp_path / "visits.json").read_text()  # no addresses on disk


def test_visits_work_without_a_writable_volume(client, osc, clock, monkeypatch):
    monkeypatch.setattr(picker, "VISITS_FILE", "/proc/nonexistent/visits.json")
    assert visit(client, "203.0.113.1") == 1
    assert visit(client, "203.0.113.2") == 2


def test_health(client):
    assert client.get("/health").get_json() == {"status": "ok"}
