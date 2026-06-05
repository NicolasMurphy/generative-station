# generative-station

Continuous generative audio stream. A SuperCollider piece runs forever inside a container, ffmpeg encodes AAC, Icecast serves it.

---

## Listen Live

**[station.berserkbrah.com](https://station.berserkbrah.com)**

---

## How It Works

Five voice elements (swells, plucks, clicks, sweeps, bass) play continuously inside a single SuperCollider piece. By default each voice picks pitches from its own random range.

### Mass Spectrum to Audio Converter Integration

When a compound is generated on [mass-spectrum-to-audio-converter](https://github.com/NicolasMurphy/mass-spectrum-to-audio-converter), it POSTs the spectrum's frequencies and amplitudes to a webhook on this server. A small Flask sidecar (`picker`) validates the payload, debounces incoming events, and forwards them via OSC to SuperCollider. The voices then pull their pitch material from that compound's mass spectrum.

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
docker compose up
```

`http://localhost:8000`.
