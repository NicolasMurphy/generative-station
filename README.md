# generative-station

Continuous generative audio stream. A SuperCollider piece runs forever inside a container, ffmpeg encodes AAC, Icecast serves it.

---

## Listen Live

**[station.berserkbrah.com](https://station.berserkbrah.com)**

---

## How It Works

Seven voice elements (swells, lowPlucks, plucks, clicks, sweeps, bass, percussion) run inside a single SuperCollider piece. By default each pitched voice picks pitches from its own random range.

- **Swells and lowPlucks** alternate, never overlapping, in legs of 5–20 minutes.
- **Percussion** is silent for 10–20 minutes at a time, then plays for a 5–10 minute window. Each window picks one of four related grooves and a tempo between 120 and 136 bpm.
- **Plucks, clicks, sweeps and bass** come and go on their own timers.
- **Slow drift**: over hours the pitched voices move a little lower or higher and every voice gets a little rarer or denser, each on its own cycle.
- **Once every hour or three**, the plucks play the whole spectrum as a single run from its lowest peak to its highest.

The percussion's kick ducks the other voices through a sidechain, and everything is summed through a master limiter before it reaches the encoder.

### Mass Spectrum to Audio Converter Integration

When a compound is generated on [mass-spectrum-to-audio-converter](https://github.com/NicolasMurphy/mass-spectrum-to-audio-converter), it POSTs the spectrum's frequencies and amplitudes to a webhook on this server. A small Flask sidecar (`picker`) validates the payload, debounces incoming events, and forwards them via OSC to SuperCollider. The voices then pull their pitch material from that compound's mass spectrum. Each event plays the spectrum as a chord, one sine per peak, so only the 32 strongest peaks are voiced and peaks more than 40 dB below the strongest are skipped.

[Architecture Diagrams](https://mass-spectrum-to-audio-converter.onrender.com/architecture.html)

**Tech Stack:**

- **Synthesis**: SuperCollider (scsynth + sclang)
- **Sidecar**: Python, Flask, python-osc
- **Streaming**: ffmpeg → Icecast (AAC)
- **Visualization**: Three.js
- **Web server and reverse proxy**: Caddy (TLS, HTTP/3) serves the page and proxies the stream and the webhook
- **Deployment**: Docker hosted on Hetzner VPS, tested and deployed by GitHub Actions

### The page

The page shows what is playing, how long the station has been on air (since the first commit, 20 May 2026) and how long the current stream has been up, how many are listening, and a visit counter.

What is playing is also told to the device, so a phone's lock screen and a desktop's media controls show the compound's name. Its cover is the compound's own spectrum: the voiced peaks from low to high, each as tall as it is strong.

There are four visuals, stepped through with **v** or the page's own switch. The WebGPU ones are already drawing when the page opens, from the compound alone, and follow the stream from the first play on:

- **bloom** (WebGPU): particles simulated on the GPU. Each voiced peak of the compound's spectrum is a ring whose radius and colour follow its frequency, and which swells when the stream has energy around that frequency.
- **sand** (WebGPU): the compound as a figure in sand on a vibrating plate. Each voiced peak drives one of the plate's modes, a finer one the higher the peak, and the sand gathers along the lines where the plate is still. The low, middle and high peaks each draw a figure in their own colour, and the figures change slowly all the time, faster where the stream has energy around their peaks.
- **reaction** (WebGPU): the compound as a reaction spreading through a dish, drawn in contour lines. Two substances, one feeding on the other, are enough to grow spots that divide, stripes that branch or shapes that never settle, and which of them grows depends on two numbers that the compound sets: where its peaks lie between low and high, and how far apart they are spread. The low, middle and high peaks each colour a part of the dish, larger the stronger they are, and a part swells and brightens while the stream has energy around its peaks.
- **rings** (WebGL, three.js): eight rings of spectrum bars. Browsers without WebGPU get this one.

Fullscreen (**f**, or the button beside the switch, which is what a phone or a tablet has) is for watching. Once nothing has been touched for a few seconds the player, the words and the pointer fade out of the picture; a movement, a tap or a key brings them back, and so does a new compound, for long enough to read its name. While the station plays in fullscreen the screen is kept from dimming and locking.

An iPhone cannot put a page in fullscreen. There the button reads **hide words** and does the rest of it inside the browser: the words leave the picture, a tap brings them back for a few seconds (and with them **keep words**, which ends it), and the screen stays awake while the station plays.

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
