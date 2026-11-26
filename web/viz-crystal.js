// "crystal": the compound as crystals growing on a microscope slide (WebGPU).
//
// A drop of a melted compound, pressed thin under a slip of glass and left
// to cool, does not set all at once. A crystal begins at a point and grows
// outward from it in fine fibres, as a fan that closes into a disc, quickly
// at first and then more slowly, until it meets the crystals that began
// elsewhere; where two meet, both stop, and the line between them stays.
// Between two polarising filters set across one another the melt is black,
// because it does nothing to light, and the crystals are lit, because they
// turn it: brightest where their fibres lie at a slant to the filters and
// dark where they lie along one of them. Fibres that run out from a point
// lie every way at once, so each crystal carries a dark cross, and when the
// filters are turned every cross on the slide turns with them. The thin
// growing edge of a crystal is pale; where it is thicker it has colour.
//
// Here every voiced peak of the compound's mass spectrum seeds crystals of
// its own: more of them the stronger the peak, in its colour (warm for the
// low peaks through green to blue for the high, the same order as in the
// other visuals), and with finer fibres and closer growth rings the higher
// the peak. Where the crystals begin is different every time. Once the
// slide is full the filters go on turning over it for a few minutes; then
// it is warmed, the crystals melt back to the points they came from, and
// it is left to cool again, so the same compound makes a slide that has
// not been seen before.
//
// Where the page can hear the stream, a peak's crystals are lit more
// brightly while there is energy around its pitch, the crystals grow and
// the filters turn faster the louder the stream is, and a kick gives the
// filters a push and flares the lamp. Where it cannot (iOS gives a page no
// sound to look at for a live stream) a slow swell of its own does the
// same, as in "bloom". A new compound melts the slide at once, and its own
// crystals grow.
//
// Nothing is simulated: whose crystal a place belongs to is worked out once
// for each slide, and everything else where it is drawn.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

// Lengths are in slide units: the shorter side of the window is two.
const MAX_SEEDS = 48; // crystals on a slide, at most
const QUICK = 9; // seconds a crystal takes to a slide unit as it begins,
const SLOWING = 80; // and how many more for every unit it has grown
const STAGGER = 14; // the crystals begin over this many seconds
const SETTLE = 7; // the pale edges fade for this long after the slide is full
const HOLD = 150; // seconds a full slide is looked at
const MELT = 11; // seconds it takes to melt
const SWEPT = 3; // and to melt when a new compound has come
const GAP_SCALE = 24; // how the distance to a crystal's neighbour is kept

const SHADER = /* wgsl */ `
struct Seed {
  at: vec2f,     // where the crystal began
  start: f32,    // and when, on the slide's clock
  lamp: f32,     // how brightly it is lit now
  hue: f32,      // its peak's place from the lowest (0) to the highest (1)
  fine: f32,     // how fine its fibres are, 0 to 1
  ring: f32,     // growth rings to a slide unit, times two pi
  turn: f32,     // a number of its own, so that no two crystals are alike
};

struct Uniforms {
  view: vec2f,   // the canvas, in pixels
  grown: f32,    // the slide's clock: how long it has been growing
  polar: f32,    // how far the filters have been turned
  count: f32,
  glow: f32,
  flare: f32,
  pixel: f32,    // slide units to a pixel
  seeds: array<Seed, ${MAX_SEEDS}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn cover(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

fn place(at: vec4f) -> vec2f {
  return (at.xy - 0.5 * u.view) * u.pixel;
}

// How long a crystal takes to grow this far from where it began: quickly at
// first, then more and more slowly.
fn takes(d: f32) -> f32 {
  return d * (${QUICK}.0 + ${SLOWING}.0 * d);
}

// ---- whose crystal each place is, once for a slide ---------------------------

@fragment
fn mapFragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
  // A place belongs to the crystal that reaches it first. Kept with it is
  // how near the place is to where the next crystal would have taken it:
  // that is where the line between the two is drawn.
  let p = place(at);
  var first = 1e9;
  var second = 1e9;
  var firstFar = 0.0;
  var secondFar = 0.0;
  var owner = 0u;
  let count = u32(u.count);
  for (var k = 0u; k < count; k++) {
    let d = distance(p, u.seeds[k].at);
    let t = u.seeds[k].start + takes(d);
    if (t < first) {
      second = first;
      secondFar = firstFar;
      first = t;
      firstFar = d;
      owner = k;
    } else if (t < second) {
      second = t;
      secondFar = d;
    }
  }
  let gap = (second - first) / (2.0 * ${QUICK}.0 + 2.0 * ${SLOWING}.0 * (firstFar + secondFar));
  return vec4f(f32(owner) / 255.0, clamp(gap * ${GAP_SCALE}.0, 0.0, 1.0), 0.0, 1.0);
}

// ---- the slide, between the filters -------------------------------------------

@group(1) @binding(0) var map: texture_2d<f32>;

fn hash2(a: f32, b: f32) -> vec2f {
  let p = vec2f(a * 0.1031 + b * 0.3183, a * 0.2317 + b * 0.0973);
  var q = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

// Warm for the lowest peaks, through green, to blue for the highest.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

// The fibres of a crystal at a place round it and out from it: how much
// light this one passes, and how far it leans from running straight out.
// A crystal begins as a few broad fans, and its fibres divide as they grow,
// so that further out there are more of them and they are no wider.
fn fibres(round: f32, d: f32, own: f32, fine: f32) -> vec2f {
  var sum = vec2f(0.0);
  var whole = 0.0;
  var square = 0.0;
  var weight = 1.0;
  let keep = mix(0.8, 1.1, fine);
  let narrowest = max(mix(0.016, 0.0045, fine), 1.6 * u.pixel);
  for (var o = 3u; o < 10u; o++) {
    let n = f32(1u << o);
    let wide = 6.2831853 * d / n; // a fibre of this many round the crystal, here
    let w = weight * smoothstep(0.5 * narrowest, narrowest, wide);
    weight *= keep;
    if (w <= 0.0) {
      continue;
    }
    let x = round * n;
    let i = floor(x);
    var f = x - i;
    f = f * f * (3.0 - 2.0 * f);
    let a = hash2(i + f32(o) * 61.0, own);
    let b = hash2(((i + 1.0) % n) + f32(o) * 61.0, own);
    sum += w * (mix(a, b, f) - 0.5);
    whole += w;
    square += w * w;
  }
  if (whole <= 0.0) {
    return vec2f(0.5);
  }
  // As many fibres laid over one another as there are would come out grey.
  return clamp(vec2f(0.5) + 1.5 * sum / sqrt(square) * min(1.0, whole), vec2f(0.0), vec2f(1.0));
}

@fragment
fn showFragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let page = vec3f(0.0667); // the page's #111, and the melt
  let cell = textureLoad(map, vec2i(at.xy), 0);
  let seed = u.seeds[u32(cell.r * 255.0 + 0.5)];
  let off = place(at) - seed.at;
  let d = length(off);

  // How far the crystal's edge is past this place.
  let pace = ${QUICK}.0 + 2.0 * ${SLOWING}.0 * d;
  let behind = (u.grown - seed.start - takes(d)) / pace;
  let there = clamp(behind / u.pixel + 0.5, 0.0, 1.0);
  if (there <= 0.0) {
    return vec4f(page, 1.0);
  }

  let angle = atan2(off.y, off.x);
  let fibre = fibres(angle / 6.2831853 + 0.5, d, seed.turn, seed.fine);
  let streak = smoothstep(0.1, 0.9, fibre.x);
  let lean = (fibre.y - 0.5) * 0.4;

  // Between crossed filters a fibre is dark when it lies along either of
  // them and brightest half way between: four dark arms to a crystal. On
  // one side of an arm the colour is a little further up the scale and on
  // the other a little further down, as it is with a tint plate in the way.
  let across = sin(2.0 * (angle + lean - u.polar));
  let passes = across * across;

  // Growth rings: the crystal is a little thicker and thinner by turns,
  // not evenly, and each fibre has them at its own distance.
  let out = d * seed.ring;
  let ring = 0.5 + 0.5 * cos(out + 1.7 * sin(0.31 * out + seed.turn) + (fibre.y - 0.5) * 5.0);

  // And thicker in some places than in others, which moves its colour.
  let thick = sin(d * 5.0 + seed.turn * 7.0) * 0.5 + (fibre.x - 0.5) * 0.6;
  var colour = palette(seed.hue + 0.09 * across + 0.07 * thick + 0.03 * (ring - 0.5));
  var light = (0.04 + 0.96 * passes * sqrt(passes)) * (0.5 + 0.5 * streak) * (0.8 + 0.2 * ring);

  // The edge that is still growing is thin, and a thin crystal is pale.
  let edge = exp(-max(behind, 0.0) / 0.014);
  colour = mix(colour, vec3f(1.0, 0.96, 0.88), 0.8 * edge);
  light = mix(light, 0.3 + 0.7 * passes, 0.7 * edge);

  // Where it met its neighbour, the line between them.
  let gap = cell.g / ${GAP_SCALE}.0;
  light *= mix(0.16, 1.0, smoothstep(0.0, 0.007 + 1.5 * u.pixel, gap));

  let lit = colour * light * seed.lamp * u.glow * (1.0 + 0.35 * u.flare);
  let shown = (1.0 - page) * (1.0 - exp(-1.2 * lit));
  return vec4f(page + shown * there, 1.0);
}
`;

// ---- the crystals a compound grows ---------------------------------------------

// Position of a frequency on the analyser's band axis, 0..1.
function bandOf(hz) {
  return Math.min(1, Math.max(0, Math.log(hz / LOW_HZ) / Math.log(SPAN)));
}

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

// With no compound: three plain kinds of crystal, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 1, idle: true }, { f: 640, a: 1, idle: true }];
}

// What each peak's crystals are like, and how many of them it gets.
function describeSlide(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const strengths = peaks.map((p) => Math.sqrt(p.a));
  const whole = strengths.reduce((sum, s) => sum + s, 0);
  // A compound of few peaks grows fewer, larger crystals than one of many.
  const wanted = Math.min(MAX_SEEDS, Math.round(11 + 1.4 * peaks.length));
  const counts = strengths.map((s) => Math.max(1, Math.round((wanted * s) / whole)));
  for (;;) {
    const most = Math.max(...counts);
    if (counts.reduce((sum, n) => sum + n, 0) <= MAX_SEEDS || most <= 1) break;
    counts[counts.indexOf(most)] -= 1;
  }
  const kinds = peaks.map((p, k) => {
    // the lowest peak has the coarsest crystals, the highest the finest; a
    // lone peak ones in between
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    return {
      hue: x,
      fine: x,
      ring: (2 * Math.PI) / (0.11 * Math.pow(0.3, x)),
      band: bandOf(p.f),
      strength: strengths[k],
      count: counts[k],
    };
  });
  return { idle: !!peaks[0].idle, kinds };
}

// Where and when the crystals of a slide begin: somewhere else every time,
// each as far from the others as a few tries can put it. Places are kept
// as shares of the window, so that a window that changes its shape keeps
// its slide.
function sow(slide, reachX, reachY) {
  const which = [];
  slide.kinds.forEach((kind, k) => {
    for (let j = 0; j < kind.count; j++) which.push(k);
  });
  for (let i = which.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [which[i], which[j]] = [which[j], which[i]];
  }
  const seeds = [];
  for (const k of which.slice(0, MAX_SEEDS)) {
    let best = null;
    let bestFar = -1;
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = (2 * Math.random() - 1) * 1.04;
      const y = (2 * Math.random() - 1) * 1.04;
      let far = Infinity;
      for (const s of seeds) far = Math.min(far, Math.hypot((x - s.x) * reachX, (y - s.y) * reachY));
      if (far > bestFar) {
        bestFar = far;
        best = { x, y };
      }
    }
    seeds.push({
      kind: k,
      x: best.x,
      y: best.y,
      // A strong peak's crystals tend to begin sooner, and so grow larger.
      start: STAGGER * Math.random() * (1 - 0.55 * slide.kinds[k].strength),
      turn: Math.random() * 100,
      // No two crystals are quite as thick as one another.
      shade: 0.07 * (Math.random() - 0.5),
    });
  }
  const soonest = Math.min(...seeds.map((s) => s.start));
  for (const s of seeds) s.start -= soonest;
  return seeds;
}

// When the last place of the slide has been reached.
function fullAt(seeds, reachX, reachY) {
  let last = 0;
  for (let i = 0; i <= 28; i++) {
    for (let j = 0; j <= 28; j++) {
      const x = (i / 14 - 1) * reachX;
      const y = (j / 14 - 1) * reachY;
      let first = Infinity;
      for (const s of seeds) {
        const d = Math.hypot(x - s.x * reachX, y - s.y * reachY);
        first = Math.min(first, s.start + d * (QUICK + SLOWING * d));
      }
      last = Math.max(last, first);
    }
  }
  return last;
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

  const uniformData = new Float32Array(8 + 8 * MAX_SEEDS);
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

  const sharedLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const showLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }],
  });
  const MAP = 'rgba8unorm';
  const mapPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout] }),
    vertex: { module, entryPoint: 'cover' },
    fragment: { module, entryPoint: 'mapFragment', targets: [{ format: MAP }] },
    primitive: { topology: 'triangle-list' },
  });
  const showPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, showLayout] }),
    vertex: { module, entryPoint: 'cover' },
    fragment: { module, entryPoint: 'showFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sharedGroup = device.createBindGroup({
    layout: sharedLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // ---- the slide follows the compound ----

  let slide = describeSlide(null);
  let next = null; // the crystals of a compound that has come, while the old ones melt
  let shownKey = null;

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      if (shownKey === null) slide = describeSlide(compound);
      else next = describeSlide(compound);
      shownKey = key;
    }
  }
  followCompound();
  const followTimer = setInterval(followCompound, 1000);

  // ---- what the stream is doing ----

  const spectrum = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const nyquist = analyser ? analyser.context.sampleRate / 2 : 24000;
  const bands = new Float32Array(BANDS);
  let level = 0;
  let kick = 0;
  let slowBass = 0;
  let silentFor = 0;

  function listen(time, dt) {
    let heard = false;
    const fresh = new Float32Array(BANDS);
    if (spectrum) {
      analyser.getByteFrequencyData(spectrum);
      for (let b = 0; b < BANDS; b++) {
        const from = Math.max(1, Math.floor((LOW_HZ * Math.pow(SPAN, b / BANDS)) / nyquist * spectrum.length));
        const to = Math.min(spectrum.length, Math.max(from + 1, Math.floor((LOW_HZ * Math.pow(SPAN, (b + 1) / BANDS)) / nyquist * spectrum.length)));
        let sum = 0;
        for (let i = from; i < to; i++) sum += spectrum[i];
        fresh[b] = sum / (to - from) / 255;
        if (sum > 0) heard = true;
      }
    }
    silentFor = heard ? 0 : silentFor + dt;
    if (silentFor > 2) {
      // No analyser data (iOS gives none for a live stream, and a paused
      // player gives silence): a slow swell takes the stream's place.
      for (let b = 0; b < BANDS; b++) {
        fresh[b] = 0.24 + 0.17 * Math.sin(time * (0.19 + 0.06 * b) + b * 1.9);
      }
    }
    let sum = 0;
    for (let b = 0; b < BANDS; b++) {
      const rate = fresh[b] > bands[b] ? 18 : 3; // quick to rise, slow to fall
      bands[b] += (fresh[b] - bands[b]) * Math.min(1, dt * rate);
      sum += bands[b];
    }
    level = sum / BANDS;
    const bass = (bands[0] + bands[1]) / 2;
    slowBass += (bass - slowBass) * Math.min(1, dt * 2);
    kick = Math.max(kick * Math.exp(-dt * 7), Math.min(1, Math.max(0, bass - slowBass) * 5));
  }

  // Energy of the stream around a peak: 0 is the lowest band, 1 the highest.
  function bandEnergy(b) {
    const x = Math.min(1, Math.max(0, b)) * (BANDS - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, BANDS - 1);
    return bands[i] + (bands[j] - bands[i]) * (x - i);
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let reachX = 1; // half the window, in slide units
  let reachY = 1;
  let map = null; // whose crystal each pixel is
  let mapView = null;
  let showGroup = null;
  let stale = true; // the map is not of this slide, or not of this window
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the picture is drawn coarser until they are not.
  let busy = false;
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let slowness = 0; // smoothed seconds per frame

  let seeds = [];
  let grown = 0; // the slide's clock
  let full = 1; // when its last place is reached
  let state = 'growing'; // then 'full', then 'melting'
  let held = 0; // how long it has been full
  let meltIn = MELT;
  let meltFrom = 0; // the clock when the melting began,
  let melted = 0; // and how far it has gone, 0 to 1
  let polar = Math.random() * Math.PI;
  let glow = 0;

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, sharp);
    const largest = device.limits.maxTextureDimension2D;
    const w = Math.min(largest, Math.max(1, Math.floor(canvas.clientWidth * ratio)));
    const h = Math.min(largest, Math.max(1, Math.floor(canvas.clientHeight * ratio)));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
      const least = Math.min(w, h);
      reachX = w / least;
      reachY = h / least;
      if (map) map.destroy();
      map = device.createTexture({
        size: [w, h],
        format: MAP,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      mapView = map.createView();
      showGroup = device.createBindGroup({
        layout: showLayout,
        entries: [{ binding: 0, resource: mapView }],
      });
      stale = true;
      // The slide keeps its crystals, and they have further to go or less.
      if (seeds.length) full = fullAt(seeds, reachX, reachY);
    }
  }

  function melt(seconds) {
    state = 'melting';
    meltIn = seconds;
    meltFrom = grown;
    melted = 0;
  }

  function begin() {
    seeds = sow(slide, reachX, reachY);
    full = fullAt(seeds, reachX, reachY);
    grown = 0;
    state = 'growing';
    stale = true;
  }

  function frame(ms) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (busy) return;
    busy = true;
    const time = ms / 1000;
    const real = time - (last || time);
    const dt = Math.min(0.05, Math.max(0.001, real));
    last = time;
    if (real > 0) {
      slowness += (Math.min(real, 0.5) - slowness) * 0.1;
      if (slowness > 0.045 && sharp > 0.75) {
        sharp = sharp > 1 ? 1 : 0.75;
        slowness = 0.03;
      }
    }
    fit();
    listen(time, dt);

    // The slide cools, is looked at, and is warmed again. A page that was
    // out of sight comes back to the slide it left.
    const passed = Math.min(0.25, Math.max(0.001, real)); // a slow GPU is not kept waiting
    if (next && state !== 'melting') melt(SWEPT);
    if (state === 'growing') {
      grown += passed * (0.45 + 1.8 * level);
      if (grown >= full + SETTLE) {
        state = 'full';
        held = 0;
      }
    } else if (state === 'full') {
      grown = Math.max(grown, full + SETTLE);
      held += passed;
      if (held >= HOLD) melt(MELT);
    } else {
      // A crystal's edge covers less and less ground as it grows, so the
      // clock is run back faster at first: the edges then draw in evenly.
      melted = Math.min(1, melted + passed / meltIn);
      grown = meltFrom * (1 - melted) * (1 - melted);
      if (melted >= 1) {
        if (next) {
          slide = next;
          next = null;
        }
        begin();
      }
    }
    polar = (polar + dt * (0.03 + 0.1 * level + 0.55 * kick)) % Math.PI;
    glow += ((slide.idle ? 0.5 : 1) - glow) * Math.min(1, dt * 0.8);

    uniformData.set([width, height, grown, polar, seeds.length, glow, kick, 2 / Math.min(width, height)], 0);
    seeds.forEach((seed, k) => {
      const kind = slide.kinds[seed.kind];
      const at = 8 + 8 * k;
      uniformData[at] = seed.x * reachX;
      uniformData[at + 1] = seed.y * reachY;
      uniformData[at + 2] = seed.start;
      uniformData[at + 3] = 0.45 + 1.05 * bandEnergy(kind.band);
      uniformData[at + 4] = kind.hue + seed.shade;
      uniformData[at + 5] = kind.fine;
      uniformData[at + 6] = kind.ring;
      uniformData[at + 7] = seed.turn;
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    if (stale) {
      stale = false;
      const lay = encoder.beginRenderPass({
        colorAttachments: [{
          view: mapView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      lay.setPipeline(mapPipeline);
      lay.setBindGroup(0, sharedGroup);
      lay.draw(3);
      lay.end();
    }
    const show = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.0667, g: 0.0667, b: 0.0667, a: 1 }, // the page's #111
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    show.setPipeline(showPipeline);
    show.setBindGroup(0, sharedGroup);
    show.setBindGroup(1, showGroup);
    show.draw(3);
    show.end();
    device.queue.submit([encoder.finish()]);
    const done = () => { busy = false; };
    device.queue.onSubmittedWorkDone().then(done, done);
  }
  fit();
  begin();
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
