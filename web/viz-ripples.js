// "ripples": the last half minute of the stream, drawn round a point (WebGL).
//
// Sound leaves the hub in the middle and travels outward, so the distance
// from the centre is how long ago something was heard and a circle is one
// moment. The angle is the note: each half of the picture is one octave,
// from the bottom round to the top, and the colour says which octave, warm
// for low and blue for high, as in the other visuals. Notes an octave apart
// lie on the same line. The left half is the left channel and the right
// half the right one, so a voice placed to one side is brighter on that
// side. A held note is a ray, a pluck a dash followed by its echoes, a
// sweep a spiral, and what is too low to tell its note (the kick, the
// bass) is a circle.
//
// The hub holds the current compound: one stick per voiced peak of its mass
// spectrum, at the peak's own note and as long as the peak is strong. The
// station plays the spectrum as a chord, transposed differently every time,
// and transposing turns the chord round the hub: each fan of rays is the
// hub's figure, turned.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called.

const BASE_HZ = 110; // the note at the bottom of the picture, in the lowest octave drawn
const OCTAVES = 7; // drawn as notes: 110 Hz to 14 kHz
const LOW_HZ = 35; // from here up to BASE_HZ is drawn as circles
const BINS = 256; // steps round each half
const ROWS = 1024; // moments of history kept
const ROW_RATE = 40; // moments per second: 25.6 s in all
const SPEED = 0.085; // outward speed, in half-heights of the picture a second
const HUB = 0.16; // radius of the hub, same unit
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const QUIET = 0.3; // analyser level (0..1) below which nothing is drawn
const GLOW = 0.4; // brightness of the glow round a note, against the note's own line
const LINE = 0.75; // half-width of a note's line, in steps

// Warm for the lowest octave, through green, to blue for the highest: the
// same order as the other two visuals.
const LOW = [1.0, 0.28, 0.12];
const MID = [0.22, 1.0, 0.4];
const HIGH = [0.18, 0.4, 1.0];
function palette(h) {
  const t = Math.min(1, Math.max(0, h));
  const [a, b, x] = t < 0.5 ? [LOW, MID, t * 2] : [MID, HIGH, (t - 0.5) * 2];
  return [a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x, a[2] + (b[2] - a[2]) * x];
}

// Where a frequency is drawn: its place in the octave (0..1, the angle) and
// how high it is over the whole range (0..1, the colour).
function noteOf(hz) {
  const octaves = Math.log2(hz / BASE_HZ);
  return { place: octaves - Math.floor(octaves), height: octaves / OCTAVES };
}

// How brightly a level from the analyser (0..255) is drawn, 0..1.
function brightness(value) {
  const x = Math.min(1, Math.max(0, (value / 255 - QUIET) / (1 - QUIET)));
  return Math.pow(x * x * (3 - 2 * x), 1.6);
}

const VERTEX = `
attribute vec2 corner;
void main() {
  gl_Position = vec4(corner, 0.0, 1.0);
}
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D history; // x: note, the left half then the right half; y: moment
uniform vec2 size;         // of the canvas, in pixels
uniform float head;        // moments written so far (modulo ROWS), with its fraction
uniform vec2 level;        // how loud each side is now
uniform float shown;       // 0..1, fades a new compound's sticks in
uniform vec2 sticks[${MAX_PEAKS}]; // per stick: place in the octave, length
uniform vec3 tints[${MAX_PEAKS}];  // and colour
uniform int stickCount;

const float PI = 3.14159265;
const float BINS = ${BINS}.0;
const float ROWS = ${ROWS}.0;
const float ROW_RATE = ${ROW_RATE}.0;
const float SPEED = ${SPEED};
const float HUB = ${HUB};
const float OLDEST = ${((ROWS - 8) / ROW_RATE).toFixed(3)}; // seconds
const vec3 GROUND = vec3(0.0667); // the page's #111

void main() {
  float unit = 0.5 * min(size.x, size.y);
  float px = 1.0 / unit;
  vec2 p = (gl_FragCoord.xy - 0.5 * size) / unit;
  float r = length(p);
  float place = atan(abs(p.x), -p.y) / PI;        // 0 at the bottom, 1 at the top
  float side = smoothstep(-0.012, 0.012, p.x);    // 0 on the left, 1 on the right
  vec3 colour = GROUND;

  if (r >= HUB) {
    float age = (r - HUB) / SPEED;
    // Never past the newest moment written: the row after it still holds
    // what was heard 25 seconds ago.
    float row = (min(head - age * ROW_RATE, floor(head)) + 0.5) / ROWS;
    float x = (place * (BINS - 1.0) + 0.5) / (2.0 * BINS);
    vec3 heard = mix(texture2D(history, vec2(x, row)).rgb,
                     texture2D(history, vec2(x + 0.5, row)).rgb, side);
    float fade = 1.0 - smoothstep(0.3, 1.0, age / OLDEST);
    fade *= smoothstep(HUB, HUB + 0.02, r);
    float strongest = max(heard.r, max(heard.g, heard.b));
    colour += (heard * 1.5 + vec3(pow(strongest, 3.0)) * 0.6) * fade;
  } else {
    float loud = mix(level.x, level.y, side);
    float best = 0.0;
    vec3 tint = vec3(0.0);
    for (int i = 0; i < ${MAX_PEAKS}; i++) {
      if (i >= stickCount) break;
      // the octave closes on itself, so the nearer way round counts
      float apart = abs(place - sticks[i].x);
      apart = min(apart, 1.0 - apart);
      float across = apart * PI * r;
      float from = HUB * 0.36;
      float to = from + HUB * 0.52 * sticks[i].y;
      float stick = (1.0 - smoothstep(0.5 * px, 1.6 * px, across))
        * smoothstep(from - px, from + px, r)
        * (1.0 - smoothstep(to - px, to + px, r));
      if (stick > best) {
        best = stick;
        tint = tints[i];
      }
    }
    colour += tint * best * shown * (0.5 + 0.7 * loud);
    float rim = 1.0 - smoothstep(0.4 * px, 1.6 * px, abs(r - HUB * 0.955));
    colour += vec3(0.5) * rim * (0.12 + 0.6 * loud);
  }
  gl_FragColor = vec4(colour, 1.0);
}
`;

// The peaks the station voices: at most MAX_PEAKS, strongest first, none
// more than 40 dB below the strongest. Same rule as piece.scd.
function voicedPeaks(compound) {
  const freqs = (compound && compound.frequencies) || [];
  const amps = (compound && compound.amplitudes) || [];
  let found = freqs.map((f, i) => ({ f, a: amps[i] })).filter((p) => p.f > 0 && p.a >= 0);
  const top = Math.max(0, ...found.map((p) => p.a));
  if (!found.length || top <= 0) return [];
  found = found.filter((p) => p.a >= top * PEAK_FLOOR);
  if (found.length > MAX_PEAKS) {
    found = found.sort((p, q) => q.a - p.a).slice(0, MAX_PEAKS);
  }
  return found.map((p) => ({ f: p.f, a: p.a / top }));
}

// One stick per peak: where it is in the octave, how long, what colour.
function describeSticks(compound) {
  const found = voicedPeaks(compound);
  const sticks = new Float32Array(MAX_PEAKS * 2);
  const tints = new Float32Array(MAX_PEAKS * 3);
  found.forEach((p, k) => {
    const note = noteOf(p.f);
    sticks.set([note.place, 0.25 + 0.75 * Math.sqrt(p.a)], k * 2);
    tints.set(palette(note.height), k * 3);
  });
  return { sticks, tints, count: found.length };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

export async function start(canvas, analyser, { getCompound = () => null, onLost = () => {} } = {}) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
  if (!gl) throw new Error('WebGL is not available in this browser');
  if (gl.isContextLost()) throw new Error('the WebGL context is lost');

  let running = true;
  function lost(event) {
    event.preventDefault();
    if (running) {
      running = false;
      onLost({ message: 'WebGL context lost' });
    }
  }
  canvas.addEventListener('webglcontextlost', lost);

  // ---- drawing: one triangle that covers the canvas ----

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('program: ' + gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);
  const uniform = (name) => gl.getUniformLocation(program, name);
  const at = {
    size: uniform('size'), head: uniform('head'), level: uniform('level'), shown: uniform('shown'),
    sticks: uniform('sticks'), tints: uniform('tints'), stickCount: uniform('stickCount'),
  };

  const triangle = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  // The history is a texture used as a ring: each moment overwrites the
  // oldest row, and the shader is told where the newest one is. A row is
  // the colour of every note of the left channel, then of the right.
  const history = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, history);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, BINS * 2, ROWS, 0,
    gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(BINS * 2 * ROWS * 3));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.uniform1i(uniform('history'), 0);

  // ---- listening: the two channels, each with its own analyser ----

  // The page's analyser passes the stream through unchanged, so the
  // channels can be split off behind it.
  const sides = [];
  let splitter = null;
  if (analyser) {
    const audio = analyser.context;
    splitter = audio.createChannelSplitter(2);
    analyser.connect(splitter);
    for (let channel = 0; channel < 2; channel++) {
      const node = audio.createAnalyser();
      node.fftSize = 8192; // tells notes a semitone apart down to about 400 Hz
      node.smoothingTimeConstant = 0.35; // the picture keeps the history itself
      node.minDecibels = -95;
      node.maxDecibels = -25;
      splitter.connect(node, channel);
      sides.push({
        node,
        spectrum: new Uint8Array(node.frequencyBinCount),
        held: 0, // the level the low end has settled at
      });
    }
  }

  // Where each note of each octave sits in the analyser's spectrum. Low
  // down several steps share one analyser bin and are interpolated; higher
  // up one step covers several bins and takes the strongest.
  const binCount = sides.length ? sides[0].node.frequencyBinCount : 1;
  const nyquist = analyser ? analyser.context.sampleRate / 2 : 24000;
  const binOf = (hz) => Math.min(binCount - 1, (hz / nyquist) * binCount);
  const centre = new Float32Array(BINS * OCTAVES);
  const first = new Int32Array(BINS * OCTAVES);
  const last = new Int32Array(BINS * OCTAVES);
  const tint = new Float32Array(BINS * OCTAVES * 3);
  for (let octave = 0; octave < OCTAVES; octave++) {
    for (let k = 0; k < BINS; k++) {
      const n = octave * BINS + k;
      const hz = (step) => BASE_HZ * Math.pow(2, octave + step / BINS);
      centre[n] = binOf(hz(k + 0.5));
      first[n] = Math.round(binOf(hz(k)));
      last[n] = Math.round(binOf(hz(k + 1)));
      tint.set(palette((octave + (k + 0.5) / BINS) / OCTAVES), n * 3);
    }
  }
  const binHz = nyquist / binCount;
  const lowFirst = Math.max(1, Math.round(binOf(LOW_HZ)));
  const lowLast = Math.max(lowFirst + 1, Math.round(binOf(BASE_HZ)));
  const noteFirst = lowLast;
  const noteLast = Math.min(binCount - 1, Math.floor(binOf(BASE_HZ * Math.pow(2, OCTAVES))));

  const now = new Float32Array(BINS * 2 * 3); // what is heard this frame, as colour, 0..1
  const moment = new Uint8Array(BINS * 2 * 3); // the brightest since the last row was written
  const blank = new Uint8Array(BINS * 2 * 3);
  const level = [0, 0];
  let silentFor = 0;
  let rightSilentFor = 0;

  function listen(time, dt) {
    const loud = [0, 0];
    now.fill(0);
    sides.forEach((side, channel) => {
      side.node.getByteFrequencyData(side.spectrum);
      const spectrum = side.spectrum;
      const base = channel * BINS * 3;
      let sum = 0;
      for (let n = 0; n < BINS * OCTAVES; n++) {
        let value;
        if (last[n] - first[n] < 2) {
          const i = Math.floor(centre[n]);
          const next = Math.min(binCount - 1, i + 1);
          value = spectrum[i] + (spectrum[next] - spectrum[i]) * (centre[n] - i);
        } else {
          value = 0;
          for (let i = first[n]; i < last[n]; i++) if (spectrum[i] > value) value = spectrum[i];
        }
        sum += value;
        // A faint glow as wide as the analyser sees the sound, which is
        // much wider than the note. Octaves that sound the same note add
        // up on its line.
        const lit = brightness(value) * GLOW;
        if (lit > 0) {
          const to = base + (n % BINS) * 3;
          now[to] += tint[n * 3] * lit;
          now[to + 1] += tint[n * 3 + 1] * lit;
          now[to + 2] += tint[n * 3 + 2] * lit;
        }
      }
      // The note itself is the top of each bump in the spectrum, found
      // between the analyser's bins from the bins either side, and drawn
      // as a thin line.
      for (let i = noteFirst; i < noteLast; i++) {
        const here = spectrum[i];
        const before = spectrum[i - 1];
        const after = spectrum[i + 1];
        if (here <= before || here < after) continue;
        const offset = (0.5 * (before - after)) / (before - 2 * here + after);
        const lit = brightness(here - 0.25 * (before - after) * offset);
        if (lit <= 0) continue;
        const octaves = Math.log2(((i + offset) * binHz) / BASE_HZ);
        const colour = palette(octaves / OCTAVES);
        const x = (octaves - Math.floor(octaves)) * BINS - 0.5;
        for (let k = Math.floor(x) - 1; k <= Math.floor(x) + 2; k++) {
          const weight = lit * Math.exp(-((k - x) * (k - x)) / (2 * LINE * LINE));
          const to = base + (((k % BINS) + BINS) % BINS) * 3; // the octave closes on itself
          now[to] += colour[0] * weight;
          now[to + 1] += colour[1] * weight;
          now[to + 2] += colour[2] * weight;
        }
      }
      // Below the lowest octave the analyser cannot tell one note from the
      // next: what is down there goes out as a circle, all the way round.
      // A beat is a clear ring. The bass holds for half a minute and would
      // fill the whole picture, so what stays is only a faint warmth.
      let low = 0;
      for (let i = lowFirst; i < lowLast; i++) if (spectrum[i] > low) low = spectrum[i];
      side.held += (low - side.held) * Math.min(1, dt * (low > side.held ? 3 : 8));
      const ring = Math.min(1, Math.max(0, low - side.held) / 70) * 0.2 + brightness(low) * 0.07;
      if (ring > 0) {
        for (let k = 0; k < BINS; k++) {
          now[base + k * 3] += LOW[0] * ring;
          now[base + k * 3 + 1] += LOW[1] * ring;
          now[base + k * 3 + 2] += LOW[2] * ring;
        }
      }
      loud[channel] = Math.max(sum / (BINS * OCTAVES), low * 0.5) / 255;
    });
    // A mono stream arrives on the left channel only: show it on both sides.
    rightSilentFor = loud[0] > 0 && loud[1] === 0 ? rightSilentFor + dt : 0;
    if (sides.length === 2 && rightSilentFor > 2) {
      now.copyWithin(BINS * 3, 0, BINS * 3);
      loud[1] = loud[0];
    }
    for (let i = 0; i < now.length; i++) {
      const value = Math.min(255, Math.round(now[i] * 255));
      if (value > moment[i]) moment[i] = value;
    }
    silentFor = loud[0] + loud[1] > 0 ? 0 : silentFor + dt;
    for (let channel = 0; channel < 2; channel++) {
      // No analyser data (iOS gives none for a live stream, and a paused
      // player gives silence): nothing leaves the hub, since nothing was
      // heard, but the hub itself keeps breathing.
      const target = silentFor > 2
        ? 0.2 + 0.12 * Math.sin(time * 0.5 + channel * 1.3)
        : Math.min(1, loud[channel] * 2.2);
      const rate = target > level[channel] ? 14 : 2.5; // quick to rise, slow to fall
      level[channel] += (target - level[channel]) * Math.min(1, dt * rate);
    }
  }

  // ---- the hub follows the compound ----

  let shownKey = null;
  let shownSince = 0;
  let clock = 0;

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key === shownKey || !running) return;
    shownKey = key;
    shownSince = clock;
    const { sticks, tints, count } = describeSticks(compound);
    gl.uniform2fv(at.sticks, sticks);
    gl.uniform3fv(at.tints, tints);
    gl.uniform1i(at.stickCount, count);
  }
  followCompound();
  const followTimer = setInterval(followCompound, 1000);

  // ---- frame loop ----

  let width = 0;
  let height = 0;
  let began = null; // time of the first frame
  let written = 0; // moments written so far
  let previous = 0;

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function frame(ms) {
    if (!running) return;
    requestAnimationFrame(frame);
    const time = ms / 1000;
    if (began === null) began = previous = time;
    const dt = Math.min(0.1, Math.max(0.001, time - previous));
    previous = time;
    clock = time - began;
    fit();
    listen(time, dt);

    // Time moves on whether or not a frame was drawn. A slow frame rate
    // repeats what was heard over the moments it missed; after a real gap
    // (the tab was in the background) the moments nobody listened to stay
    // empty.
    const head = clock * ROW_RATE;
    const due = Math.floor(head);
    if (due > written) {
      const gap = due - written;
      for (let n = Math.max(written + 1, due - ROWS + 1); n <= due; n++) {
        const row = gap > ROW_RATE && n < due ? blank : moment;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, n % ROWS, BINS * 2, 1,
          gl.RGB, gl.UNSIGNED_BYTE, row);
      }
      written = due;
      moment.fill(0);
    }

    gl.uniform2f(at.size, width, height);
    gl.uniform1f(at.head, head % ROWS);
    gl.uniform2f(at.level, level[0], level[1]);
    gl.uniform1f(at.shown, Math.min(1, (clock - shownSince) / 1.5));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      clearInterval(followTimer);
      canvas.removeEventListener('webglcontextlost', lost);
      if (splitter) {
        try { analyser.disconnect(splitter); } catch (e) {}
        splitter.disconnect();
      }
      // The context stays with the canvas and is used again the next time
      // this visual is shown; only what was made in it is given back.
      gl.deleteTexture(history);
      gl.deleteBuffer(triangle);
      gl.deleteProgram(program);
    },
  };
}
