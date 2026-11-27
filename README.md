# generative-station

Continuous generative audio stream. A SuperCollider piece runs forever inside a container, ffmpeg encodes AAC, Icecast serves it.

---

## Listen Live

**[station.berserkbrah.com](https://station.berserkbrah.com)**

---

## How It Works

A single SuperCollider piece runs seven voices: swells, lowPlucks, plucks, clicks, sweeps, bass and percussion.

- **Swells** and **lowPlucks** take turns, 5–20 minutes each.
- **Percussion** plays for 5–10 minutes, then rests for 10–20. Each set picks one of four grooves at 120–136 bpm.
- **Plucks, clicks, sweeps and bass** come and go on their own timers.
- Over hours, pitch range and density drift slowly.
- Every hour or three, the plucks run through the whole spectrum from lowest peak to highest.

The kick sidechains the other voices, and everything goes through a master limiter before the encoder.

### Mass Spectrum to Audio Converter Integration

When a compound is generated on [mass-spectrum-to-audio-converter](https://github.com/NicolasMurphy/mass-spectrum-to-audio-converter), it POSTs the spectrum's frequencies and amplitudes to a webhook here. A small Flask sidecar (`picker`) validates and debounces it and forwards it to SuperCollider over OSC. The voices then take their pitches from that spectrum, playing it as chords: up to the 32 strongest peaks, skipping anything more than 40 dB below the strongest.

Each compound also has a **call**: its five strongest peaks played as single notes, strongest first, octave-shifted above the other voices. It plays shortly after a compound arrives and again every 8–16 minutes.

[Architecture Diagrams](https://mass-spectrum-to-audio-converter.onrender.com/architecture.html)

**Tech Stack:**

- **Synthesis**: SuperCollider (scsynth + sclang)
- **Sidecar**: Python, Flask, python-osc
- **Streaming**: ffmpeg → Icecast (AAC)
- **Visualization**: WebGPU, Three.js
- **Web server and reverse proxy**: Caddy (TLS, HTTP/3)
- **Deployment**: Docker on a Hetzner VPS, tested and deployed by GitHub Actions

### The page

Shows the current compound, uptime, listener count and a visit counter.

- **Playback** connects on play, and reconnects after a pause of more than a few seconds, so you always hear what's live. It also reconnects automatically if the stream drops or stalls silently.
- **About** (`a`): what the station is, plus the current compound's spectrum.
- **Sleep timer** (`s`): 15, 30, 60 or 90 minutes, then fades out and pauses.
- **Media session**: the compound's name and spectrum show on lock screens and media controls.
- **Fullscreen** (`f`): the UI fades out when idle, and the screen stays awake while playing. On iPhone this is **hide words** instead.
- **Tour** (`t`): changes visual every five minutes.
- **Change visual** (`v` steps to the next one).

### Visuals

The WebGPU visuals draw from the compound's peaks before anything plays, and react to the audio once it does. Peaks are coloured warm (low) to blue (high).

- **bloom**: each peak is a ring of GPU particles.
- **sand**: Chladni figures, one plate mode per peak.
- **reaction**: Gray-Scott reaction-diffusion with parameters set by the spectrum.
- **pool**: caustics from one ripple per peak.
- **magnet**: a magnetic-sector mass spectrometer, one ion beam per peak.
- **rings** (WebGL, three.js): spectrum bars from the audio. The fallback for browsers without WebGPU.

---

## Running Locally

```sh
cp .env.example .env   # then set the passwords and the webhook secret
docker compose up
```

`http://localhost:8000` is Icecast directly: the page and the stream.

To run the whole site locally, webhook included, set `STATION_SITE=http://localhost` in `.env` so Caddy serves plain HTTP at `http://localhost` instead of requesting a certificate for the production domain. `dev-commands.md` has an example webhook request.

## Tests

```sh
python -m pytest picker   # picker unit tests (needs picker/requirements.txt and pytest)
sh ci/test-deploy.sh      # what deploy.sh rebuilds and restarts, against a fake docker
sh ci/smoke.sh            # builds and starts everything in Docker and checks the stream end to end
```

CI runs all three on every push.

## Deployment

Pushes to `main` are deployed automatically once the tests pass. See [DEPLOY.md](DEPLOY.md).
