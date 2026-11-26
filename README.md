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

Every compound also has a **call**, the one thing the station plays that is the same each time. It is the compound's strongest peaks one at a time, strongest first, as single soft notes: five at most, a weaker peak a quieter note that is followed sooner, so the call falls away as it goes. The notes are the compound's own frequencies moved up or down by whole octaves, to sit above the other voices. A station says what it is every so often, and this is how this one does: the call is the first thing heard of a compound, a moment after it arrives, and it comes round again every 8 to 16 minutes for as long as the compound stays.

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

The player connects to the stream when play is pressed, not when the page opens, and play after a pause of more than a few seconds connects again. So what is heard is what is on now, in step with the name and the picture, and "listening now" counts listeners rather than open pages.

If the connection dies while someone is listening, the page connects again by itself. That includes the death nothing reports: a connection that goes quiet without being closed, as when a phone is out of signal for so long that the server gives it up and the word never arrives. A browser left to itself then shows a playing player over silence for good. The page notices that the player has been waiting for the stream for ten seconds and joins it afresh.

The page can be asked what it is: **about** (or **a**) lays a few paragraphs over the picture for someone who has just arrived. They say what the station is, where its notes come from, that the compound is the last one somebody turned into sound with the converter and so is anyone's to choose, and that the spectra are MassBank's (CC BY 4.0). With them is the compound that is playing, as its own spectrum: the peaks the station voices, low to high, each as tall as it is loud, with the pitches they run between and the number of its MassBank record. The page's other words step back while it is read, a press beside it or Escape puts it away, and its links open beside the page, since following one in place would stop the sound.

The station does not end, so there is a **sleep timer** for someone who falls asleep to it. Each press of it (or of **s**) asks for longer, 15 minutes, then 30, 60 and 90, and one more calls it off; the button counts down what is left. The sound is turned down over the last twenty seconds, where a page may turn it (an iPhone keeps the volume to its own buttons, so there it simply stops), and is then paused, which also lets go of a screen that was being kept awake. Nothing the page does by itself brings the sound back afterwards, a reconnection included; the next play does, with what is on then.

A link to the station, passed on in a chat or a post, is shown with a line about what the station is and a picture: the figure the trace visual draws of choline (`web/share.png`).

What is playing is also told to the device, so a phone's lock screen and a desktop's media controls show the compound's name. Its cover is the compound's own spectrum: the voiced peaks from low to high, each as tall as it is strong.

There are twelve visuals. **change visual** lists them by name and a press on a name goes to that one, so the one that is wanted is a press away and not eleven; the list stays while one after another is tried, with the picture changing behind it, and a press beside it or Escape puts it away. **v** steps to the next. The WebGPU ones are already drawing when the page opens, from the compound alone, and follow the stream from the first play on:

- **bloom** (WebGPU): particles simulated on the GPU. Each voiced peak of the compound's spectrum is a ring whose radius and colour follow its frequency, and which swells when the stream has energy around that frequency.
- **sand** (WebGPU): the compound as a figure in sand on a vibrating plate. Each voiced peak drives one of the plate's modes, a finer one the higher the peak, and the sand gathers along the lines where the plate is still. The low, middle and high peaks each draw a figure in their own colour, and the figures change slowly all the time, faster where the stream has energy around their peaks.
- **reaction** (WebGPU): the compound as a reaction spreading through a dish, drawn in contour lines. Two substances, one feeding on the other, are enough to grow spots that divide, stripes that branch or shapes that never settle, and which of them grows depends on two numbers that the compound sets: where its peaks lie between low and high, and how far apart they are spread. The low, middle and high peaks each colour a part of the dish, larger the stronger they are, and a part swells and brightens while the stream has energy around its peaks.
- **trace** (WebGPU): the compound as the line a pen draws, as a harmonograph does. Each voiced peak is a pendulum that swings the pen, more often the higher the peak and further the stronger it is, and the line the pen leaves is a figure of how the peaks stand to one another. A peak is never exactly a whole number of swings to a round of the pen, so each round is drawn a little beside the last and the figure turns slowly into another. The line is warm where it sweeps wide and blue where it turns tightly, and the whole figure swells where the stream has energy around its peaks. A new compound lifts the pen and a new figure is drawn.
- **aurora** (WebGPU): the compound as northern lights. The curtain is the compound's spectrum hung across the sky from its lowest peak to its highest, and each voiced peak is a ray in it: where the ray stands follows the peak's frequency, and how bright it is and how far up it reaches follow its strength. It is the lock screen's cover, hung in the air and seen from the ground. The curtain is a thin sheet that waves slowly, and where it turns along the line of sight it folds, its light piles up and its rays stand close together. A ray brightens and reaches higher while the stream has energy around its peak, and a new compound's rays grow in where the old ones fade.
- **pool** (WebGPU): the compound as sunlight on the floor of a pool. Light that falls through moving water is bent by it, gathered under the crests and spread under the troughs, and lands as a net of bright lines that never keeps still. Each voiced peak is a ripple on the water, finer the higher the peak, bending the light more the stronger the peak, and crossing the pool from more sides the stronger it is; the net on the floor is what all the ripples do to the light together. Nothing is drawn but the light: the sheet of it that enters the water is followed down to where it lands, and is as bright there as it has been gathered. It is tinted by the ripples that gather it at each place, warm for the low peaks to blue for the high. A ripple rises while the stream has energy around its peak, so the net is soft in quiet passages and drawn sharp in loud ones. A new compound stills the water, and its ripples rise from the calm.
- **magnet** (WebGPU): the compound as a mass spectrometer sorts it. A mass spectrum is read by throwing the pieces of a compound through a magnet: they enter by a slit, the magnet bends each onto a circle of its own, and they land in different places along a plate, where every place something lands is a peak. Here each voiced peak is a beam of ions that leaves the slit, swings half a circle that is wider the higher the peak, and lands on the plate, where its line stands as tall as the peak is strong: the lock screen's cover again, with how it comes to be there drawn above it. The ions do not all leave the slit quite straight, so a beam opens out on its way and the half circle brings it together again, which is why the beams are crescents. More ions are sent into a beam while the stream has energy around its peak, and a kick sends a burst into all of them; what is sent takes a second or three to come round, so the sound is seen leaving the slit, travelling the beams and striking the plate. A new compound shuts the slit: the ions in flight land, the plate goes dark, and the new compound's beams set out.
- **ink** (WebGPU): the compound as ink let into water. A dish of still water is seen from above, and each voiced peak has a place on its rim, low peaks at the left to high peaks at the right, from which it lets ink into the water in puffs: ink of the peak's colour, warm for the low peaks to blue for the high, more of it and more often the stronger the peak. So what is in the dish is the spectrum as amounts of colour: a compound of one strong peak is a dish of one ink, and a compound of many is a wheel of them. The water is a real fluid, worked out on the GPU. A puff is a short push at it, and what a push does to water is roll it up into a pair of whirls that travel on together and carry the ink along as a mushroom, until they meet the ink of another peak and are wound into it. Nothing is drawn but the ink, which thins as it goes, so the dish never fills. A peak lets its ink in faster and with more force while the stream has energy around its pitch, and a kick sends one hard puff more, from a different place every time. A new compound clears the water, and its peaks begin on it.
- **ferro** (WebGPU): the compound as a dish of ferrofluid over magnets. A ferrofluid is an oil so full of iron that a magnet can hold it: over a weak magnet it only gathers into a low mound, and over one that is strong enough the flat surface gives way and the fluid stands up in spikes, each as far from its neighbours as the next. Every voiced peak is a magnet under the dish, low peaks at the left to high peaks at the right and a wider magnet the stronger the peak, so a crown of spikes is one peak. The fluid is black and shows nothing of itself, only what it mirrors: white lamps, which the tips and flanks of the spikes find, and round the dish a glow in the colour of the peak beneath, warm for the low peaks to blue for the high, which their edges find. It is the one visual that is a solid thing with light on it and not a drawing in light. A magnet is driven harder while the stream has energy around its peak, and the fluid, which has weight, follows a moment late and overshoots: a peak that is only a mound in a quiet passage puts out spikes when its pitch sounds, and a kick lifts every crown at once. On a tall screen the dish is wider than the screen and the magnets keep to the part that is seen. A new compound lets the fluid fall flat, and its magnets take it up again.
- **crystal** (WebGPU): the compound as crystals growing on a microscope slide. A melted compound left to cool under a slip of glass does not set all at once: a crystal begins at a point and grows outward in fine fibres, quickly at first and then more slowly, until it meets the crystals that began elsewhere, and the line where two meet stays. Between two polarising filters set across one another the melt is black and the crystals are lit, except where their fibres lie along one of the filters: so every crystal carries a dark cross, and when the filters are turned every cross on the slide turns with them. Each voiced peak seeds crystals of its own, more of them the stronger the peak, in its colour (warm for the low peaks to blue for the high), with finer fibres and closer growth rings the higher the peak. The growing edge of a crystal is thin and pale. Once the slide is full the filters go on turning over it for a few minutes; then it is warmed, the crystals melt back to the points they came from, and it cools again with its crystals somewhere else, so the same compound makes a slide that has not been seen before. A peak's crystals are lit more brightly while the stream has energy around its pitch, the crystals grow and the filters turn faster the louder the stream is, and a kick gives the filters a push and flares the lamp. A new compound melts the slide at once, and its own crystals grow.
- **jellyfish** (WebGPU): the compound as jellyfish rising through dark water. A jellyfish swims by closing its bell: the bell draws in and lengthens, the animal is carried forward by about its own width, and then the bell opens again, slowly, while it glides and what trails behind it slackens and curls. Each voiced peak is a kind of jellyfish, large and slow for the lowest peaks to small and quick for the highest, in its colour (warm for the low peaks to blue for the high), and more of them the stronger the peak. In water with no light of its own they are seen by the light they give: the thin wall of the bell, brightest where it is looked at edge on, the canals that run down it, the organs under the crown and the rim. They rise through the picture, each on its own way, the further ones smaller, dimmer and less sharp, and one that has left at the top comes in again from below. A kind swims a stroke when a note sounds around its peak's pitch, strokes more often and is lit more brightly while there is energy there, and a kick passes through all of them as a flicker. A new compound's jellyfish take the place of the old, which fade into the water.
- **rings** (WebGL, three.js): eight rings of spectrum bars. Browsers without WebGPU get this one.

Nobody watching presses a switch, so there is a **tour** beside it (or **t**). While it is on the page moves to the next visual by itself every five minutes, fading the old picture out first, and the button counts down to the change. It goes round the visuals that draw the compound and passes over rings, which would be an empty screen while the station is paused. Only time the page is in sight counts, a visual chosen by hand gets its full five minutes, and the tour is remembered for the next visit, as the visual is.

Under the compound's name the page says which visual is showing and, in a line, what it is a picture of: that a ring, a ray or a swing of the pen is one of the compound's peaks.

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
