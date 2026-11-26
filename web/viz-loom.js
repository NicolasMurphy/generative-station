// "loom": what the station plays, woven into cloth (WebGPU).
//
// Cloth is made of two sets of threads. The warp is stretched on the loom
// from end to end, and the weft is passed across it one row at a time; at
// each place where they cross, one of the two lies on top. Raise a warp
// thread for a row and it shows there, leave it down and the weft covers
// it. Which threads are raised in which rows is all a woven pattern is,
// and a loom that is told row by row what to raise will weave any picture,
// which is what Jacquard's cards did.
//
// Here the warp is pitch: a thread for each step from low at the left to
// high at the right, coloured as the peaks are in the other visuals, warm
// through green to blue. The weft is dark, and it is time: three rows a
// second. Where nothing sounds the cloth is plain, over one and under one,
// and dark. Where there is sound at a thread's pitch the thread is left on
// top, for more of the row's crossings the louder the sound, until it lies
// along the face of the cloth with only a stitch here and there to hold
// it; and it is drawn brighter, as if the sound lit it. So the cloth is
// what was played, the newest at the top where it is being woven, the last
// half minute or so on its way down the picture and out of it.
//
// The station plays a compound as chords: all its peaks at once, moved up
// or down together by a different amount every time. On a cloth whose
// threads are pitches a chord is therefore one figure, the compound's
// peaks side by side, and the same figure comes again further left or
// right: short where it was plucked, long where it swelled. That figure,
// repeated, is the compound. A sweep of noise is a slanting line, and a
// kick is a row of pale weft.
//
// Above the cloth the warp is bare, and a thread there is a string: it
// stands still while its pitch is silent and swings while it sounds.
//
// Where the page cannot hear the stream (before the first play, and on an
// iPhone, which gives a page no sound to look at for a live stream) the
// loom weaves the compound as the station would play it: the same peaks,
// as chords of its own making. So it does while the player is paused, and
// the cloth that is there when the page opens is woven the same way. A new
// compound begins after a few pale rows.
//
// The cloth is kept as a small texture, a number for every crossing of a
// thread and a row, and drawn from it: which thread lies on top at each
// crossing, and how the light falls on a round thread that goes over one
// and under the next.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

const WIDE = 256; // the texture: a column to a thread, and the last for the row
const ROWS = 256; // the rows of cloth that are kept
const INFO = WIDE - 1; // the column that says what a row's weft is
const MOST_THREADS = 220;
const ROW_RATE = 3; // rows woven in a second
const SQUAT = 0.86; // a row is this much of a thread's width high
const REST = 0.5; // how far a thread is raised where nothing sounds: plain cloth,
const FULL = 0.95; // and where the loudest thing does
// What the station does with a compound's peaks: it plays them between
// about 0.4 and 2.5 times their pitch, and the call puts the strongest
// between 1000 and 2000 Hz. The warp runs over that.
const BELOW = 0.4;
const ABOVE = 2.5;
const AT_LEAST = 2200; // Hz the warp reaches, whatever the compound
const HEADER = 3; // pale rows before a new compound
const SMEAR = 2; // analyser bins either side that one note spills into

const SHADER = /* wgsl */ `
struct Uniforms {
  view: vec2f,    // the canvas, in pixels
  left: f32,      // where the first thread begins, in pixels
  pitch: f32,     // pixels to a thread
  fell: f32,      // where the cloth begins, in pixels from the top
  rise: f32,      // pixels to a row
  grow: f32,      // how much of the newest row is woven, 0 to 1
  head: f32,      // which row of the texture the newest is
  threads: f32,
  time: f32,
  flare: f32,
  glow: f32,
  beam: f32,      // where the bare warp is made fast, above the picture
  level: f32,
  spare0: f32,
  spare1: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var cloth: texture_2d<f32>;

const PI = 3.14159265;
const GROUND = vec3f(0.0667, 0.0667, 0.0667); // the page's #111
const WARP_WIDE = 0.46;  // half a warp thread, in threads
const WEFT_WIDE = 0.47;  // half a weft thread, in rows
const BARE_WIDE = 0.27;  // half a thread of the bare warp, which is taut

@vertex
fn cover(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

fn hash1(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 3.7) * 43758.5453);
}

// Warm for the lowest pitches, through green, to blue for the highest.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

// The colour of a warp thread. The two at the edges are the selvedge,
// which is undyed.
fn dye(i: i32) -> vec3f {
  let n = i32(u.threads);
  if (i < 0 || i >= n) { return vec3f(0.42, 0.4, 0.36); }
  let own = 0.86 + 0.26 * hash1(f32(i));
  return palette(f32(i) / max(1.0, u.threads - 1.0)) * own;
}

// How far a thread is raised in a row, 0 to 1. The selvedge is plain cloth.
fn lift(i: i32, row: i32) -> f32 {
  let n = i32(u.threads);
  if (i < 0 || i >= n) { return 0.5; }
  return textureLoad(cloth, vec2i(i, row & ${ROWS - 1}), 0).r;
}

// Whether the warp lies on top where thread i crosses a row. Half raised
// is plain cloth, over one and under one. Less than that leaves some of
// those out and more adds others between them, a few at first and spread
// apart as in satin, so that a thread shows more the further it is raised
// and is still bound into the cloth.
fn over(i: i32, row: i32) -> bool {
  let e = lift(i, row);
  let d1 = (i + row) >> 1u;
  let d2 = (i - row) >> 1u;
  let m = (d1 + 3 * d2) & 7;
  let t = (f32(m) + 0.5) / 8.0;
  let odd = ((i + row) & 1) == 1;
  return e > select(0.5 * t, 0.5 + 0.5 * t, odd);
}

// Light on a round thread: n is the way its surface faces, along is the
// way the thread runs. A thread shines in a line along itself.
fn lit(base: vec3f, n: vec3f, along: vec3f, shade: f32) -> vec3f {
  let swing = 0.35 * sin(u.time * 0.11);
  let light = normalize(vec3f(-0.45 + swing, -0.5, 0.74));
  let diffuse = max(dot(n, light), 0.0);
  let between = normalize(light + vec3f(0.0, 0.0, 1.0));
  let across = sqrt(max(0.0, 1.0 - pow(dot(along, between), 2.0)));
  let sheen = pow(max(dot(n, between), 0.0), 12.0) * pow(across, 6.0);
  return (base * (0.24 + 0.86 * diffuse) + (base * 0.5 + vec3f(0.12)) * sheen * 0.7) * shade;
}

// The cloth at a place: x in threads from the first, s in rows from the
// top edge of the newest whole row.
fn woven(x: f32, s: f32, px: f32) -> vec3f {
  let n = i32(u.threads);
  let i = i32(floor(x));
  let fu = x - floor(x);
  let k = i32(floor(s));
  let rv = s - floor(s);
  let row = i32(u.head) - (k + 1);
  let info = textureLoad(cloth, vec2i(${INFO}, row & ${ROWS - 1}), 0);

  let e = lift(i, row);
  let heard = clamp((e - ${REST}) / ${FULL - REST}, 0.0, 1.0);
  let warp = dye(i) * (0.2 + 1.2 * heard);
  let pale = info.r;
  let weft = mix(vec3f(0.105, 0.11, 0.135), vec3f(0.62, 0.6, 0.54), pale);

  var colour: vec3f;
  if (over(i, row)) {
    // The warp thread is on top, and runs down the picture. At an end where
    // it is not on top in the next row too, it goes down under the weft.
    let fore = select(smoothstep(0.0, 0.55, rv), 1.0, over(i, row + 1));
    let aft = select(smoothstep(0.0, 0.55, 1.0 - rv), 1.0, over(i, row - 1));
    let high = fore * aft;
    let wide = WARP_WIDE * (0.8 + 0.2 * high);
    let cx = (fu - 0.5) / wide;
    let edge = 1.0 - smoothstep(1.0 - 1.5 * px / wide, 1.0, abs(cx));
    let c = clamp(cx, -1.0, 1.0);
    let face = normalize(vec3f(c, 0.75 * ((1.0 - aft) - (1.0 - fore)), sqrt(max(0.02, 1.0 - c * c))));
    let top = lit(warp, face, vec3f(0.0, 1.0, 0.0), 0.3 + 0.7 * high);
    colour = mix(weft * 0.22, top, edge);
  } else {
    // The weft is on top, and runs across.
    let fore = select(1.0, smoothstep(0.0, 0.55, fu), over(i - 1, row));
    let aft = select(1.0, smoothstep(0.0, 0.55, 1.0 - fu), over(i + 1, row));
    let high = fore * aft;
    let wide = WEFT_WIDE * (0.8 + 0.2 * high);
    let cy = (rv - 0.5) / wide;
    let edge = 1.0 - smoothstep(1.0 - 1.5 * px / wide, 1.0, abs(cy));
    let c = clamp(cy, -1.0, 1.0);
    let face = normalize(vec3f(0.75 * ((1.0 - aft) - (1.0 - fore)), c, sqrt(max(0.02, 1.0 - c * c))));
    let top = lit(weft, face, vec3f(1.0, 0.0, 0.0), 0.3 + 0.7 * high);
    colour = mix(warp * 0.16, top, edge);
  }
  return colour;
}

// The bare warp at a place above the cloth. A thread that sounds swings
// too fast to be followed, and what is seen of it is everywhere it goes:
// a spindle, thin at its ends and brightest at its edges.
fn bare(x: f32, y: f32, px: f32) -> vec3f {
  let n = i32(u.threads);
  let along = clamp((y - u.beam) / (u.fell - u.beam), 0.0, 1.0);
  let belly = sin(PI * along);
  let i = i32(floor(x));
  var sum = vec3f(0.0);
  for (var d = -3; d <= 3; d++) {
    let j = i + d;
    if (j < -1 || j > n) { continue; }
    let e = lift(j, i32(u.head));
    let heard = max(0.0, e - ${REST}) / ${FULL - REST};
    let swing = 2.3 * heard * heard * belly;
    let dx = abs(x - (f32(j) + 0.5));
    let reach = swing + BARE_WIDE;
    let within = 1.0 - smoothstep(reach - px, reach + px, dx);
    // It is seen for less of the time at any one place the further it
    // swings, and for longest where it turns back.
    let seen = BARE_WIDE / (BARE_WIDE + 0.75 * swing);
    let turn = mix(1.0, 0.6 + 0.9 * pow(dx / reach, 3.0), smoothstep(0.0, 0.5, swing));
    let c = clamp(dx / reach, 0.0, 1.0);
    let body = mix(0.55 + 0.45 * sqrt(1.0 - c * c), 1.0, smoothstep(0.0, 0.3, swing));
    sum += dye(j) * (0.22 + 0.9 * heard) * within * seen * turn * body;
  }
  // further off toward the top
  return sum * (0.1 + 0.9 * along * along);
}

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = (pos.x - u.left) / u.pitch;
  let px = 1.0 / u.pitch;
  var colour = GROUND;
  if (pos.y < u.fell) {
    colour = GROUND + bare(x, pos.y, px) * u.glow;
  }
  // The cloth, and at its top the row that is being woven, as much of it
  // as there is yet.
  let s = (pos.y - u.fell) / u.rise - u.grow;
  let inside = x > -1.0 && x < u.threads + 1.0;
  if (pos.y >= u.fell && inside) {
    var c = woven(x, s, px);
    // The newest rows are in the light of the work, a kick most of all.
    let fresh = exp(-max(0.0, s + u.grow) / 5.0);
    c *= u.glow * (1.0 + (0.18 + 0.5 * u.flare) * fresh);
    // It is rolled away at the bottom of the picture, out of the light.
    let away = smoothstep(u.view.y, u.view.y * 0.62, pos.y);
    c *= 0.38 + 0.62 * away;
    // The edge of the cloth is soft against the page.
    let side = min(x + 1.0, u.threads + 1.0 - x);
    colour = mix(GROUND, c, smoothstep(0.0, 1.5 * px, side));
  }
  return vec4f(colour, 1.0);
}
`;

// ---- what a compound is to the loom -----------------------------------------------

// The peaks the station voices: at most MAX_PEAKS, strongest first, none
// more than 40 dB below the strongest. Same rule as piece.scd.
function voicedPeaks(compound) {
  const freqs = (compound && compound.frequencies) || [];
  const amps = (compound && compound.amplitudes) || [];
  let peaks = freqs.map((f, i) => ({ f, a: amps[i] })).filter((p) => p.f > 0 && p.a >= 0);
  const top = Math.max(0, ...peaks.map((p) => p.a));
  if (!peaks.length || top <= 0) return null;
  peaks = peaks.filter((p) => p.a >= top * PEAK_FLOOR);
  if (peaks.length > MAX_PEAKS) {
    peaks = peaks.sort((p, q) => q.a - p.a).slice(0, MAX_PEAKS);
  }
  return peaks.sort((p, q) => p.f - q.f).map((p) => ({ f: p.f, a: p.a / top }));
}

// With no compound: three plain pitches, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 0.5, idle: true }, { f: 640, a: 0.7, idle: true }];
}

// The peaks, and the pitches the warp runs between for them.
function describeWarp(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const lowest = peaks[0].f;
  const highest = peaks[peaks.length - 1].f;
  const low = Math.max(30, lowest * BELOW);
  const high = Math.min(16000, Math.max(highest * ABOVE, AT_LEAST, low * 6));
  return { idle: !!peaks[0].idle, peaks, low, high };
}

// ---- the visual ----------------------------------------------------------------

export async function start(canvas, analyser, { getCompound = () => null, onLost = () => {} } = {}) {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('no WebGPU canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  let running = true;
  device.lost.then((info) => {
    if (running) {
      running = false;
      onLost(info);
    }
  });

  const uniformData = new Float32Array(16);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Anything the GPU will not do is asked about once everything is set up,
  // so that the page can turn to another visual instead of an empty one.
  device.pushErrorScope('validation');

  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  }

  const texture = device.createTexture({
    size: [WIDE, ROWS],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'cover' },
    fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: texture.createView() },
    ],
  });

  // ---- the warp follows the compound ----

  let warp = describeWarp(null);
  let shownKey = null;
  let header = 0; // pale rows still to weave before a new compound
  let threads = 64; // how many there are across the cloth, set by fit()
  let glow = 0;

  // ---- what the stream is doing ----

  const spectrum = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const nyquist = analyser ? analyser.context.sampleRate / 2 : 24000;
  const now = new Float32Array(MOST_THREADS); // how far each thread is raised, 0 to 1
  const fresh = new Float32Array(MOST_THREADS);
  let top = 0.5; // the loudest thing heard of late, as the analyser counts,
  let wash = 0; // and how loud it is at every pitch taken together
  let kick = 0;
  let level = 0;
  let slowBass = 0;
  let silentFor = 3; // seconds; nothing has been heard yet
  let standIn = true; // nothing is heard, and the loom plays the compound itself

  // The pitch at a place across the warp, 0 at its left edge and 1 at its right.
  const pitchAt = (x) => warp.low * Math.pow(warp.high / warp.low, x);
  const placeOf = (hz) => Math.log(hz / warp.low) / Math.log(warp.high / warp.low);

  // How loud the stream is at each thread's pitch: the loudest of the
  // analyser's bins that the thread covers. Low down a bin is wider than a
  // thread, and there it is read between two.
  function hear(dt) {
    let heard = false;
    let loudest = 0;
    let all = 0;
    analyser.getByteFrequencyData(spectrum);
    const bins = spectrum.length;
    for (let i = 0; i < threads; i++) {
      const from = (pitchAt(i / threads) / nyquist) * bins;
      const to = (pitchAt((i + 1) / threads) / nyquist) * bins;
      let most = 0;
      if (to - from < 1) {
        const at = Math.min(bins - 2, Math.max(0, (from + to) / 2 - 0.5));
        const b = Math.floor(at);
        most = spectrum[b] + (spectrum[b + 1] - spectrum[b]) * (at - b);
      } else {
        const last = Math.min(bins, Math.ceil(to));
        for (let b = Math.max(0, Math.floor(from)); b < last; b++) if (spectrum[b] > most) most = spectrum[b];
      }
      if (most > 0) heard = true;
      if (most / 255 > loudest) loudest = most / 255;
      all += most / 255;
      // One note is a few bins wide to the analyser, which low down is
      // several threads, and it is only one thread's note. So a thread is
      // counted for less the further it is under the loudest thing near it.
      let around = most;
      const last = Math.min(bins, Math.ceil(to) + SMEAR);
      for (let b = Math.max(0, Math.floor(from) - SMEAR); b < last; b++) if (spectrum[b] > around) around = spectrum[b];
      fresh[i] = (most - (around - most)) / 255;
    }
    // The bass, for the kick, which is below most warps.
    let bass = 0;
    const b0 = Math.max(1, Math.floor((40 / nyquist) * bins));
    const b1 = Math.max(b0 + 1, Math.floor((110 / nyquist) * bins));
    for (let b = b0; b < b1; b++) bass += spectrum[b];
    bass /= (b1 - b0) * 255;
    if (bass > 0) heard = true;
    slowBass += (bass - slowBass) * Math.min(1, dt * 2);
    kick = Math.max(kick * Math.exp(-dt * 7), Math.min(1, Math.max(0, bass - slowBass) * 5));

    // The analyser counts in decibels. A thread is raised by how near its
    // pitch comes to the loudest thing of late: nothing for what is 30 dB
    // under it, all the way for what is within 6. And nothing for what
    // does not stand out from the sound there is at every pitch, the hiss
    // and wash a note sits in, or a loud passage would raise the whole warp.
    top = Math.max(0.3, loudest > top ? top + (loudest - top) * Math.min(1, dt * 8) : top - dt * 0.012);
    wash += (all / threads - wash) * Math.min(1, dt * 3);
    const least = Math.max(top - 0.43, wash + 0.07);
    const range = Math.max(0.16, top - 0.09 - least);
    for (let i = 0; i < threads; i++) {
      fresh[i] = Math.min(1, Math.max(0, (fresh[i] - least) / range));
    }
    return heard;
  }

  // The loom's own playing, where the stream cannot be heard: the
  // compound's peaks as chords, each moved up or down by its own amount,
  // some plucked and some swelling, as the station does it.
  let chords = [];
  let played = 0; // seconds of it
  let nextPluck = 0.4;
  let nextSwell = 0;
  function play(dt) {
    played += dt;
    if (played >= nextPluck) {
      nextPluck = played + 0.6 + 3 * Math.random();
      chords.push({ at: played, by: 1 + Math.random(), rise: 0.02, hold: 0, fall: 0.28 + 0.3 * Math.random(), loud: 0.7 + 0.3 * Math.random() });
    }
    if (played >= nextSwell) {
      nextSwell = played + 1.2 + 5 * Math.random();
      chords.push({ at: played, by: 0.5 + Math.random(), rise: 1.5 + 3 * Math.random(), hold: 0.5 + 2 * Math.random(), fall: 2 + 3.5 * Math.random(), loud: 0.6 + 0.4 * Math.random() });
    }
    chords = chords.filter((c) => played - c.at < c.rise + c.hold + 5 * c.fall);
    fresh.fill(0, 0, threads);
    for (const c of chords) {
      const t = played - c.at;
      // in decibels under full, as the analyser would count it
      const under = t < c.rise ? 30 * (1 - t / c.rise) : 26 * Math.max(0, t - c.rise - c.hold) / (2.2 * c.fall);
      for (const p of warp.peaks) {
        const i = Math.floor(placeOf(p.f * c.by) * threads);
        if (i < 0 || i >= threads) continue;
        const db = 20 * Math.log10(Math.max(1e-3, p.a * c.loud)) - under;
        const v = Math.min(1, Math.max(0, (db + 30) / 24));
        if (v > fresh[i]) fresh[i] = v;
      }
    }
  }

  function listen(dt, own) {
    const heard = spectrum && !own ? hear(dt) : false;
    silentFor = heard ? 0 : silentFor + dt;
    standIn = own || silentFor > 2;
    if (standIn) {
      play(dt);
      kick *= Math.exp(-dt * 7);
    }
    let sum = 0;
    for (let i = 0; i < threads; i++) {
      const rate = fresh[i] > now[i] ? 30 : 6; // quick to rise, slower to fall
      now[i] += (fresh[i] - now[i]) * Math.min(1, dt * rate);
      sum += now[i];
    }
    level = sum / threads;
  }

  // ---- the cloth ----

  const kept = new Uint8Array(WIDE * ROWS * 4);
  const rowBytes = new Uint8Array(WIDE * 4);
  const rowMost = new Float32Array(MOST_THREADS); // the most each thread was raised in the newest row
  let rowPale = 0;
  let head = 0; // the texture's row that is being woven
  let grow = 0; // how much of it is woven

  function beginRow() {
    head = (head + 1) % ROWS;
    rowMost.fill(0);
    rowPale = header > 0 ? 1 : 0;
    if (header > 0) header -= 1;
  }
  // The newest row, as it stands: it goes on changing until the next begins.
  function setRow() {
    const pale = rowPale >= 1;
    for (let i = 0; i < threads; i++) {
      if (now[i] > rowMost[i]) rowMost[i] = now[i];
      // the pale rows before a new compound are all weft
      rowBytes[i * 4] = pale ? 20 : Math.round(255 * (REST + (FULL - REST) * rowMost[i]));
    }
    if (!pale && 0.7 * kick > rowPale) rowPale = 0.7 * kick;
    rowBytes[INFO * 4] = Math.round(255 * rowPale);
    kept.set(rowBytes, head * WIDE * 4);
  }
  function sendRow() {
    device.queue.writeTexture({ texture, origin: { x: 0, y: head } }, rowBytes, { bytesPerRow: WIDE * 4 }, { width: WIDE, height: 1 });
  }
  function sendAll() {
    device.queue.writeTexture({ texture }, kept, { bytesPerRow: WIDE * 4 }, { width: WIDE, height: ROWS });
  }
  function weave(dt, own) {
    listen(dt, own);
    grow += dt * ROW_RATE;
    while (grow >= 1) {
      grow -= 1;
      beginRow();
    }
    setRow();
  }
  // The cloth that is there to begin with: the loom's own playing of the
  // compound, as long as the texture holds.
  function weaveAhead() {
    const step = 1 / ROW_RATE / 4;
    for (let n = 0; n < ROWS * 4; n++) weave(step, true);
    sendAll();
  }

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key === shownKey) return;
    const first = shownKey === null;
    shownKey = key;
    warp = describeWarp(compound);
    chords = [];
    if (!first) header = HEADER;
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let left = 0;
  let pitch = 8;
  let rise = 7;
  let fell = 0;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the picture is drawn coarser until they are not.
  let busy = false;
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let slowness = 0; // smoothed seconds per frame

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, sharp);
    const largest = device.limits.maxTextureDimension2D;
    const w = Math.min(largest, Math.max(1, Math.floor(canvas.clientWidth * ratio)));
    const h = Math.min(largest, Math.max(1, Math.floor(canvas.clientHeight * ratio)));
    if (w === width && h === height) return;
    width = canvas.width = w;
    height = canvas.height = h;
    const cssWide = Math.max(1, canvas.clientWidth);
    const cssHigh = Math.max(1, canvas.clientHeight);
    // A thread is five or six CSS pixels wide on a phone and up to nine on
    // a wide screen, where the cloth does not have to reach the sides.
    const span = Math.min(0.93 * cssWide, 1.9 * cssHigh);
    const wanted = Math.round(span / (cssWide < 700 ? 5.6 : 8.5));
    const count = Math.min(MOST_THREADS, Math.max(36, wanted));
    fell = Math.round(h * 0.26);
    // No more rows in sight than are kept.
    pitch = (span / count) * (w / cssWide);
    rise = Math.max(pitch * SQUAT, (h - fell) / (ROWS - 12));
    left = (w - count * pitch) / 2;
    if (count !== threads) {
      // A window that changes its shape keeps its cloth: each row is
      // spread over the threads there are now.
      const old = threads;
      threads = count;
      const was = kept.slice();
      for (let r = 0; r < ROWS; r++) {
        for (let i = 0; i < threads; i++) {
          const from = Math.min(old - 1, Math.floor(((i + 0.5) / threads) * old));
          kept[(r * WIDE + i) * 4] = was[(r * WIDE + from) * 4];
        }
      }
      for (let i = 0; i < threads; i++) {
        const from = Math.min(old - 1, Math.floor(((i + 0.5) / threads) * old));
        fresh[i] = now[from];
      }
      now.set(fresh.subarray(0, threads));
      rowMost.fill(0);
      sendAll();
    }
  }

  function frame(ms) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (busy) return;
    busy = true;
    const time = ms / 1000;
    const real = time - (last || time);
    const dt = Math.min(0.1, Math.max(0.001, real));
    last = time;
    if (real > 0) {
      slowness += (Math.min(real, 0.5) - slowness) * 0.1;
      if (slowness > 0.045 && sharp > 0.75) {
        sharp = sharp > 1 ? 1 : 0.75;
        slowness = 0.03;
      }
    }
    fit();
    weave(dt, false);
    sendRow();
    glow += ((warp.idle ? 0.55 : 1) - glow) * Math.min(1, dt * 0.8);

    uniformData.set([width, height, left, pitch, fell, rise, grow, head,
      threads, time % 3600, kick, glow, -0.2 * height, level, 0, 0], 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.0667, g: 0.0667, b: 0.0667, a: 1 }, // the page's #111
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const done = () => { busy = false; };
    device.queue.onSubmittedWorkDone().then(done, done);
  }

  followCompound();
  const followTimer = setInterval(followCompound, 1000);
  fit();
  weaveAhead();
  const refused = await device.popErrorScope();
  if (refused) {
    running = false;
    clearInterval(followTimer);
    device.destroy();
    throw new Error('the GPU refused: ' + refused.message);
  }
  requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      clearInterval(followTimer);
      device.destroy();
    },
  };
}
