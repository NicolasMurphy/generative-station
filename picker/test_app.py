"""Tests for the picker. Run with: python -m pytest picker"""

import os

os.environ["STATION_WEBHOOK_SECRET"] = "test-secret"
os.environ["SC_HOST"] = "127.0.0.1"
os.environ["DEBOUNCE_SECONDS"] = "30"
os.environ["RESEND_SECONDS"] = "60"
os.environ["PICKER_BACKGROUND"] = "0"  # the tests call tick() themselves

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
    ]:
        monkeypatch.setattr(picker, name, value)
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


def test_health(client):
    assert client.get("/health").get_json() == {"status": "ok"}
