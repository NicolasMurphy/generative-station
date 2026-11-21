# generative-station

Continuous generative audio stream. A SuperCollider piece runs forever inside a container, ffmpeg encodes AAC, Icecast serves it.

---

## Listen Live

**[station.berserkbrah.com](https://station.berserkbrah.com)**

---

## How It Works

Seven voice elements (swells, lowPlucks, plucks, clicks, sweeps, bass, percussion) run inside a single SuperCollider piece. By default each pitched voice picks pitches from its own random range.

- **Swells and lowPlucks** alternate, never overlapping, in legs of 5–20 minutes.
- **Percussion** (128 bpm) is silent for 10–20 minutes at a time, then plays for a 5–10 minute window.
- **Plucks, clicks, sweeps and bass** come and go on their own timers.

Everything is summed through a master limiter before it reaches the encoder.

### Mass Spectrum to Audio Converter Integration

When a compound is generated on [mass-spectrum-to-audio-converter](https://github.com/NicolasMurphy/mass-spectrum-to-audio-converter), it POSTs the spectrum's frequencies and amplitudes to a webhook on this server. A small Flask sidecar (`picker`) validates the payload, debounces incoming events, and forwards them via OSC to SuperCollider. The voices then pull their pitch material from that compound's mass spectrum. Each event plays the spectrum as a chord, one sine per peak, so only the 32 strongest peaks are voiced and peaks more than 40 dB below the strongest are skipped.

[Architecture Diagrams](https://mass-spectrum-to-audio-converter.onrender.com/architecture.html)

**Tech Stack:**

- **Synthesis**: SuperCollider (scsynth + sclang)
- **Sidecar**: Python, Flask, python-osc
- **Streaming**: ffmpeg → Icecast (AAC)
- **Visualization**: Three.js
- **Reverse proxy**: Caddy (TLS, HTTP/3)
- **Deployment**: Docker hosted on Hetzner VPS

---

## Running Locally

```sh
cp .env.example .env   # then set the passwords and the webhook secret
docker compose up
```

`http://localhost:8000`.

To use the webhook locally, set `STATION_SITE=http://localhost` in `.env` so Caddy serves plain HTTP instead of requesting a certificate for the production domain. `dev-commands.md` has an example request.

## Deployment

Pushes to `main` deploy automatically. See [DEPLOY.md](DEPLOY.md).
