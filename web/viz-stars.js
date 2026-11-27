// "stars": what the station plays, where it is heard, as a night sky over
// water (WebGPU).
//
// The station is in stereo, and it puts every note somewhere between the
// left ear and the right: each note of a chord in a place of its own, the
// sweeps of noise gliding from one side to the other, the bass and the
// kick in the middle. None of the other visuals shows it. They hear the
// two sides as one.
//
// This one listens to each side by itself. Wherever a pitch stands out of
// the sound it compares how loud that pitch is on the left and on the
// right, which says where the station put it, and lights a star there:
// as far to the left or right as the note is heard, as high up the sky as
// its pitch is high, as large and bright as it is loud, and coloured as
// the peaks are in the other visuals, warm for low through green to blue.
// A star lasts as long as its note. So a chord that swells is a
// constellation that comes out slowly across the whole sky and goes out
// again, a plucked one is there at once and fades, and the next chord is
// the same pitches somewhere else. A sweep of noise is a shooting star,
// which it is in the sound as well: one pitch, moving, on its way across.
// The bass and the kick are below the sky's pitches and in the middle of
// it, and are the glow on the horizon.
//
// Under the sky is water, and the stars lie on it as water shows them,
// drawn out and never still. Behind them is a sky of small stars that
// belong to no note and turn slowly about a point overhead.
//
// Where the page cannot hear the stream (before the first play, while it
// is paused, and on an iPhone, which gives a page no sound to look at for
// a live stream) the sky is the compound as the station would play it:
// the same peaks, as chords of its own making, each note put where the
// station might have put it.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

const MOST = 256; // stars that can be lit at once
// What the station does with a compound's peaks: it plays them between
// about 0.4 and 2.5 times their pitch, and the call puts the strongest
// between 1000 and 2000 Hz. The sky runs over that.
const BELOW = 0.4;
const ABOVE = 2.5;
const AT_LEAST = 2200; // Hz the sky reaches, whatever the compound
const WATER = 0.2; // of the picture's height
const SAME_PITCH = 0.035; // octaves within which a pitch heard again is the same star,
const SAME_PLACE = 0.45; // if it is also no further off than this, of the way to one side
const NEIGHBOURS = 14; // analyser bins either side that a pitch has to stand out from
const STAND_OUT = 7; // by this many decibels
const SPAN_DB = 40; // a star is lit by what is within this of the loudest thing of late

const SHADER = /* wgsl */ `
struct Uniforms {
  view: vec2f,    // the canvas, in pixels
  time: f32,
  horizon: f32,   // where the water ends, in pixels from the bottom
  unit: f32,      // pixels: what a star's size is counted in
  count: f32,     // stars that are lit
  glow: f32,      // the bass
  flare: f32,     // the kick
  level: f32,
  dim: f32,       // less of everything while there is no compound
  squash: f32,    // how much lower a star lies on the water than it stands in the sky
  turn: f32,      // how far the sky has turned
  scale: f32,     // canvas pixels to a CSS pixel
  spare0: f32,
  spare1: f32,
  spare2: f32,
};

struct Star {
  place: vec2f,   // across the picture 0 to 1, and pixels from the bottom
  level: f32,
  hue: f32,
  seed: f32,
  trail: f32,     // not a star but the way one came: a line from its place
  to: vec2f,      // to this one
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> stars: array<Star>;

fn hash1(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 3.7) * 43758.5453);
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), s.x),
             mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), s.x), s.y);
}

fn fbm(p: vec2f) -> f32 {
  var q = p;
  var sum = 0.0;
  var weight = 0.5;
  for (var i = 0; i < 4; i++) {
    sum += weight * noise(q);
    q = q * 2.03 + vec2f(11.7, 5.3);
    weight *= 0.5;
  }
  return sum;
}

// Warm for the lowest pitches, through green, to blue for the highest.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

// The far shore: how high the land stands at a place across the picture,
// in pixels from the bottom. A nearer line of hills and a further one.
fn shore(x: f32, far: f32) -> f32 {
  let s = x / u.view.y + 13.0 * far;
  let rise = 0.008 + 0.034 * noise(vec2f(s * 2.6, 0.5 + far)) + 0.011 * noise(vec2f(s * 11.0, 3.5));
  return u.horizon + u.view.y * rise * (1.0 + 0.55 * far);
}

// The small stars that are no note: a few to a square, most of them faint.
fn dust(q: vec2f, size: f32, offset: f32) -> f32 {
  let g = q / size;
  let cell = floor(g) + offset;
  let at = vec2f(hash2(cell + 17.3), hash2(cell + 41.9)) * 0.7 + 0.15;
  let d = length(fract(g) - at) * size;
  let h = hash2(cell);
  let twinkle = 0.72 + 0.28 * sin(u.time * (0.7 + 2.2 * h) + h * 61.0);
  return pow(h, 7.0) * twinkle * smoothstep(1.35 * u.scale, 0.0, d);
}

// The sky and the land at a place, in pixels from the bottom left. The
// water asks for it too, upside down, and then without the small stars,
// which moving water does not keep.
fn sky(at: vec2f, fine: bool) -> vec3f {
  let high = clamp((at.y - u.horizon) / (u.view.y - u.horizon), 0.0, 1.0);
  var c = mix(vec3f(0.05, 0.062, 0.098), vec3f(0.012, 0.014, 0.03), pow(high, 0.55));

  // The sky turns about a point overhead, and the band of far stars with it.
  let pole = vec2f(0.5 * u.view.x, u.horizon + 1.2 * (u.view.y - u.horizon));
  let away = at - pole;
  let cs = cos(u.turn);
  let sn = sin(u.turn);
  let q = vec2f(cs * away.x - sn * away.y, sn * away.x + cs * away.y);
  let w = q / u.view.y;
  let across = dot(w, vec2f(0.5, 0.866)) + 0.75;
  let band = exp(-across * across / 0.02) * (0.25 + 0.75 * fbm(w * 5.0 + 3.0)) * smoothstep(0.25, 0.75, fbm(w * 2.1 + 9.0) + 0.25);
  let clear = smoothstep(0.02, 0.3, high); // there is haze low down
  c += vec3f(0.05, 0.058, 0.085) * band * clear * u.dim;
  if (fine) {
    let small = dust(q, 11.0 * u.scale, 0.0) * 0.55 + dust(q, 27.0 * u.scale, 50.0) * 0.95;
    c += vec3f(0.8, 0.85, 1.0) * small * (0.55 + 1.6 * band) * clear;
  }

  // The bass and the kick: below the sky's pitches, in the middle of it.
  let middle = (at.x - 0.5 * u.view.x) / (0.5 * u.view.x);
  let low = exp(-high * 7.0) * exp(-middle * middle * 1.3);
  c += vec3f(0.95, 0.4, 0.16) * low * (0.03 + 0.2 * u.glow + 0.22 * u.flare) * u.dim;

  // The land is in front of all of it.
  let further = shore(at.x, 1.0);
  let nearer = shore(at.x, 0.0);
  c = mix(c, vec3f(0.03, 0.036, 0.054) + 0.3 * c, smoothstep(1.0, -1.0, at.y - further));
  c = mix(c, vec3f(0.014, 0.016, 0.022), smoothstep(1.0, -1.0, at.y - nearer));
  return c;
}

@vertex
fn cover(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

@fragment
fn ground(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = vec2f(pos.x, u.view.y - pos.y);
  if (at.y >= u.horizon) {
    return vec4f(sky(at, true), 1.0);
  }
  // Water: the sky upside down, pushed about by the ripples, which lie
  // closer together the further off they are.
  let down = u.horizon - at.y;
  let far = down / u.horizon;
  let s = u.scale;
  let ripple = noise(vec2f(at.x / (70.0 * s), down / ((1.5 + 5.0 * far) * s) - u.time * 0.45))
    + 0.5 * noise(vec2f(at.x / (23.0 * s) + u.time * 0.2, down / ((1.0 + 2.5 * far) * s) + u.time * 0.6));
  let push = (ripple - 0.75) * (2.0 + 16.0 * far) * s * (1.0 + 2.0 * u.flare);
  let seen = vec2f(at.x + push, u.horizon + down * 1.6 + push * 0.7);
  var c = sky(seen, false) * (0.5 + 0.32 * (ripple - 0.75));
  // and it is darker close by, where it is looked into and not across
  c *= 1.0 - 0.5 * far;
  c += vec3f(0.006, 0.008, 0.012);
  return vec4f(c, 1.0);
}

struct Sprite {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) colour: vec3f,
  @location(2) @interpolate(flat) about: vec4f, // level, seed, whether it is the one on the water, and whether a trail
};

@vertex
fn star(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Sprite {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let n = max(1u, u32(u.count));
  let onWater = ii >= n;
  let s = stars[ii % n];
  let corner = corners[vi];
  var half = vec2f(u.unit * (1.7 + 5.3 * pow(s.level, 0.8)));
  var centre = vec2f(s.place.x * u.view.x, s.place.y);
  var end = vec2f(s.to.x * u.view.x, s.to.y);
  if (onWater) {
    centre.y = u.horizon - (centre.y - u.horizon) * u.squash;
    end.y = u.horizon - (end.y - u.horizon) * u.squash;
    half *= vec2f(0.85, 2.3);
  }
  var px = centre + corner * half;
  if (s.trail > 0.5) {
    // a line as long as the way from one place to the other, and thin
    let way = end - centre;
    let long = max(length(way), 0.001);
    let along = way / long;
    let wide = u.unit * (0.45 + 1.1 * pow(s.level, 0.8));
    px = 0.5 * (centre + end) + along * corner.x * 0.5 * long + vec2f(-along.y, along.x) * corner.y * wide;
  }
  var out: Sprite;
  out.pos = vec4f(px / u.view * 2.0 - 1.0, 0.0, 1.0);
  out.uv = corner;
  out.colour = palette(s.hue);
  out.about = vec4f(s.level, s.seed, select(0.0, 1.0, onWater), s.trail);
  return out;
}

@fragment
fn light(in: Sprite) -> @location(0) vec4f {
  let level = in.about.x;
  let seed = in.about.y;
  let at = vec2f(in.pos.x, u.view.y - in.pos.y);
  var uv = in.uv;
  var shown = 1.0;
  var spiked = 1.0;
  if (in.about.z > 0.5) {
    // On the water a star is drawn out towards whoever looks, and broken
    // up by the ripples it lies across.
    let y = at.y / u.scale;
    uv.x += (0.25 + 0.55 * abs(uv.y)) * 0.6 * sin(y * 0.55 + u.time * 2.1 + seed * 37.0);
    shown = 0.5 * (0.5 + 0.5 * sin(y * 1.15 - u.time * 2.9 + seed * 91.0))
      * smoothstep(0.0, 2.0, u.horizon - at.y);
    spiked = 0.0;
  } else {
    // The land is in front of the stars.
    shown = smoothstep(-0.5, 1.5, at.y - shore(at.x, 1.0));
  }
  if (in.about.w > 0.5) {
    // the way a shooting star came: a thin line of its light
    let across = exp(-in.uv.y * in.uv.y * 6.0);
    let c = in.colour * 0.75 + vec3f(0.4, 0.39, 0.37);
    return vec4f(c * across * (0.12 + 0.6 * level) * shown * select(1.0, 1.6, spiked < 0.5), 1.0);
  }
  let r2 = dot(uv, uv);
  let core = exp(-r2 * 90.0);
  let halo = 0.11 / (1.0 + 34.0 * r2);
  // A bright star seen through anything with an edge has rays.
  let rays = spiked * level * 0.6
    * (exp(-abs(uv.x) * 46.0 - abs(uv.y) * 3.6) + exp(-abs(uv.y) * 46.0 - abs(uv.x) * 3.6));
  let edge = smoothstep(1.0, 0.5, max(abs(uv.x), abs(uv.y)));
  let twinkle = 0.84 + 0.16 * sin(u.time * (2.5 + 5.0 * hash1(seed)) + seed * 53.0);
  let bright = (0.3 + 0.7 * pow(level, 0.7)) * twinkle * shown * edge;
  let c = in.colour * (1.1 * core + halo + rays) + vec3f(1.0, 0.98, 0.94) * (0.9 * core + 0.35 * rays);
  return vec4f(c * bright, 1.0);
}
`;

// ---- what a compound is to the sky ------------------------------------------------

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

// The peaks, and the pitches the sky runs between for them, in octaves.
function describeSky(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const lowest = peaks[0].f;
  const highest = peaks[peaks.length - 1].f;
  const low = Math.max(30, lowest * BELOW);
  const high = Math.min(16000, Math.max(highest * ABOVE, AT_LEAST, low * 6));
  return { idle: !!peaks[0].idle, peaks, low: Math.log2(low), high: Math.log2(high) };
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
  const starData = new Float32Array(MOST * 8);
  const starBuffer = device.createBuffer({
    size: starData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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

  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const groundPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'cover' },
    fragment: { module, entryPoint: 'ground', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  // Light is added to what is there: two stars in one place are brighter.
  const adding = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const starPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'star' },
    fragment: { module, entryPoint: 'light', targets: [{ format, blend: { color: adding, alpha: adding } }] },
    primitive: { topology: 'triangle-list' },
  });
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: starBuffer } },
    ],
  });

  // ---- the sky follows the compound ----

  let heavens = describeSky(null);
  let shownKey = null;
  let low = heavens.low; // the pitches the sky runs between now, in octaves:
  let high = heavens.high; // they go over to a new compound's, they do not jump
  let dim = 0;

  // ---- what the stream is doing ----

  // Each side by itself, in decibels, a number for each of the analyser's
  // steps of pitch. A page that has only the two sides as one cannot say
  // where anything is, and the sky is then the page's own playing.
  const sides = analyser && typeof analyser.getStereoFrequencyData === 'function';
  const bins = analyser ? analyser.frequencyBinCount : 0;
  const nyquist = analyser ? analyser.context.sampleRate / 2 : 24000;
  const leftDb = new Float32Array(bins);
  const rightDb = new Float32Array(bins);
  const leftPower = new Float32Array(bins);
  const rightPower = new Float32Array(bins);
  const loud = new Float32Array(bins); // both sides together, in decibels
  const sums = new Float64Array(bins + 1);
  let sightings = []; // what is sounding now: { oct, pan, v }
  let top = -45; // the loudest thing heard of late, in the analyser's decibels
  let kick = 0;
  let bass = 0;
  let slowBass = 0;
  let level = 0;
  let silentFor = 3; // seconds; nothing has been heard yet

  function hear(dt) {
    if (!analyser.getStereoFrequencyData(leftDb, rightDb)) return false;
    let heard = false;
    for (let b = 0; b < bins; b++) {
      const l = leftDb[b] > -140 ? Math.pow(10, leftDb[b] / 10) : 0;
      const r = rightDb[b] > -140 ? Math.pow(10, rightDb[b] / 10) : 0;
      leftPower[b] = l;
      rightPower[b] = r;
      const d = l + r > 1e-12 ? 10 * Math.log10(l + r) : -120;
      loud[b] = d;
      sums[b + 1] = sums[b] + d;
      if (d > -95) heard = true;
    }
    if (!heard) return false;

    // The bass, for the glow on the horizon, and the kick in it.
    const k0 = Math.max(1, Math.floor((40 / nyquist) * bins));
    const k1 = Math.max(k0 + 1, Math.floor((110 / nyquist) * bins));
    let under = 0;
    for (let b = k0; b < k1; b++) under += Math.min(1, Math.max(0, (loud[b] + 85) / 55));
    under /= k1 - k0;
    slowBass += (under - slowBass) * Math.min(1, dt * 2);
    bass += (under - bass) * Math.min(1, dt * 5);
    kick = Math.max(kick * Math.exp(-dt * 7), Math.min(1, Math.max(0, under - slowBass) * 5));

    // A pitch that stands out: louder than its neighbours either side, and
    // by enough to be a note and not the hiss and wash that notes sit in.
    const from = Math.max(3, Math.floor((Math.pow(2, low) / nyquist) * bins));
    const to = Math.min(bins - 4, Math.ceil((Math.pow(2, high) / nyquist) * bins));
    let loudest = -120;
    const found = [];
    for (let b = from; b <= to; b++) {
      const d = loud[b];
      if (d < -92 || d <= loud[b - 1] || d < loud[b + 1] || d <= loud[b - 2] || d < loud[b + 2]) continue;
      const a = Math.max(0, b - NEIGHBOURS);
      const z = Math.min(bins, b + NEIGHBOURS + 1);
      const stands = d - (sums[z] - sums[a]) / (z - a);
      if (stands < STAND_OUT) continue;
      if (d > loudest) loudest = d;
      found.push(b, stands);
    }
    top = Math.max(-75, loudest > top ? top + (loudest - top) * Math.min(1, dt * 8) : top - dt * 1.5);
    for (let n = 0; n < found.length; n += 2) {
      const b = found[n];
      const d = loud[b];
      const sure = Math.min(1, 0.45 + (found[n + 1] - STAND_OUT) / 9);
      const v = Math.min(1, Math.max(0, (d - (top - SPAN_DB)) / (SPAN_DB - 6))) * sure;
      if (v < 0.03) continue;
      // Between two of the analyser's steps, by the lie of the three.
      const bend = loud[b - 1] - 2 * d + loud[b + 1];
      const off = bend < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (loud[b - 1] - loud[b + 1]) / bend)) : 0;
      // The station moves a sound to one side by turning it down on the
      // other, and to that side by as much as it is turned down.
      const l = leftPower[b - 1] + leftPower[b] + leftPower[b + 1];
      const r = rightPower[b - 1] + rightPower[b] + rightPower[b + 1];
      const pan = r >= l ? 1 - Math.sqrt(l / r) : Math.sqrt(r / l) - 1;
      sightings.push({ oct: Math.log2(((b + off) * nyquist) / bins), pan, v });
    }
    return true;
  }

  // The page's own playing, where the stream cannot be heard: the
  // compound's peaks as chords, each moved up or down by its own amount,
  // some plucked and some swelling, every note in a place of its own; now
  // and then a sweep, and the compound's call. As the station does it.
  let notes = [];
  let played = 0; // seconds of it
  let nextPluck = 0.3;
  let nextSwell = 0;
  let nextSweep = 9 + 14 * Math.random();
  let nextCall = 18 + 12 * Math.random();
  const between = (a, b) => a + (b - a) * Math.random();
  function chord(by, rise, hold, fall, wide, strength) {
    for (const p of heavens.peaks) {
      notes.push({ at: played, f: p.f * by, a: p.a * strength, rise, hold, fall, pan: between(-wide, wide) });
    }
  }
  function play(dt) {
    played += dt;
    if (played >= nextPluck) {
      nextPluck = played + between(1.5, 6);
      chord(between(1, 2), 0.02, 0, between(0.3, 0.6), 0.8, between(0.7, 1));
    }
    if (played >= nextSwell) {
      nextSwell = played + between(2.5, 8);
      chord(between(0.5, 1.5), between(2, 5), between(0.5, 2), between(2.5, 5), 0.7, between(0.6, 1));
    }
    if (played >= nextSweep) {
      nextSweep = played + between(25, 60);
      const ends = [between(6.3, 8.6), between(11, 13)];
      if (Math.random() < 0.5) ends.reverse();
      notes.push({ at: played, sweep: true, from: ends[0], to: ends[1], last: between(0.9, 2.6), pan: between(-0.8, 0.8), panTo: between(-0.8, 0.8) });
    }
    if (played >= nextCall && !heavens.idle) {
      nextCall = played + between(35, 70);
      // The strongest peaks one at a time, strongest first, each in the
      // octave from 1000 to 2000 Hz, the lower the further left.
      const said = heavens.peaks.slice().sort((p, q) => q.a - p.a).slice(0, 5)
        .map((p) => ({ a: p.a, oct: Math.log2(p.f) - Math.floor(Math.log2(p.f / 1000)) }));
      const lo = Math.min(...said.map((n) => n.oct));
      const hi = Math.max(...said.map((n) => n.oct));
      let at = played;
      for (const n of said) {
        notes.push({ at, f: Math.pow(2, n.oct), a: 0.9 * Math.pow(n.a, 0.3), rise: 0.02, hold: 0, fall: 1.1 + 0.7 * Math.sqrt(n.a),
          pan: hi > lo ? -0.5 + (n.oct - lo) / (hi - lo) : 0 });
        at += 0.32 + 0.5 * Math.sqrt(n.a);
      }
    }
    notes = notes.filter((n) => played - n.at < (n.sweep ? n.last : n.rise + n.hold + 5 * n.fall));
    for (const n of notes) {
      const t = played - n.at;
      if (t < 0) continue;
      if (n.sweep) {
        const x = t / n.last;
        sightings.push({ oct: n.from + (n.to - n.from) * x, pan: n.pan + (n.panTo - n.pan) * x, v: 0.75 * Math.sin(Math.PI * Math.min(1, x)) ** 0.5 });
        continue;
      }
      // in decibels under full, as the analyser would count it
      const under = t < n.rise ? 30 * (1 - t / n.rise) : 26 * Math.max(0, t - n.rise - n.hold) / (2.2 * n.fall);
      const db = 20 * Math.log10(Math.max(1e-3, n.a)) - under;
      const v = Math.min(1, Math.max(0, (db + SPAN_DB) / (SPAN_DB - 6)));
      if (v >= 0.03) sightings.push({ oct: Math.log2(n.f), pan: n.pan, v });
    }
  }

  // ---- the stars ----

  // A star is a pitch in a place. What sounds now is laid against the
  // stars there are: a pitch heard again where it was is the same star,
  // and one heard nowhere near any is a new one. A star comes up quickly
  // and goes out slowly, so that a plucked note is seen.
  //
  // A sweep is one pitch on its way across the sky, and is not where it
  // was: what sounds where nothing did, close to a star that has only
  // just come out or is already on its way, and whose own pitch has this
  // moment stopped, is that star, moved. It goes there, and the way it
  // came is left behind it as a line of light that fades, which is what a
  // shooting star is. A star that has stood a while is a note, and stays.
  let lit = []; // { oct, pan, level, heard, was, age, still, seed }, and for a trail { trail, toOct, toPan }
  const YOUNG = 0.25; // seconds
  function trail(star, oct, pan) {
    if (lit.length < MOST && Math.abs(oct - star.oct) > 0.003) {
      lit.push({ trail: true, oct: star.oct, pan: star.pan, toOct: oct, toPan: pan, level: star.level, heard: 0, seed: star.seed });
    }
    star.oct = oct;
    star.pan = pan;
    star.still = 0;
  }
  function follow(dt) {
    sightings.sort((a, b) => b.v - a.v);
    if (sightings.length > 160) sightings.length = 160;
    for (const star of lit) {
      star.was = star.heard;
      star.heard = 0;
      star.age += dt;
      star.still += dt;
    }
    const strays = [];
    for (const seen of sightings) {
      let best = null;
      let nearest = 1;
      for (const star of lit) {
        if (star.heard > 0 || star.trail) continue;
        const d = Math.abs(star.oct - seen.oct) / SAME_PITCH;
        const aside = Math.abs(star.pan - seen.pan) / SAME_PLACE;
        if (d >= 1 || aside > 1) continue;
        if (d + 0.5 * aside < nearest) {
          nearest = d + 0.5 * aside;
          best = star;
        }
      }
      if (!best) {
        strays.push(seen);
        continue;
      }
      best.heard = seen.v;
      if (best.still < YOUNG) {
        trail(best, seen.oct, seen.pan); // on its way: it is where it is heard
      } else {
        best.oct += (seen.oct - best.oct) * Math.min(1, dt * 10);
        best.pan += (seen.pan - best.pan) * Math.min(1, dt * 6);
      }
    }
    // As far as the fastest sweep gets between two looks and no further,
    // and at least as far as the slowest.
    const reach = Math.min(0.7, 0.03 + 11 * dt);
    const least = Math.min(SAME_PITCH, 1.2 * dt);
    const aside = Math.min(0.5, 0.08 + 3 * dt);
    for (const seen of strays) {
      let best = null;
      let nearest = 1;
      for (const star of lit) {
        if (star.heard > 0 || star.trail || !(star.was > 0)) continue;
        if (star.age > YOUNG && star.still > YOUNG) continue;
        const d = Math.abs(star.oct - seen.oct);
        if (d >= reach || d < least || Math.abs(star.pan - seen.pan) > aside) continue;
        if (d / reach < nearest) {
          nearest = d / reach;
          best = star;
        }
      }
      if (best) {
        trail(best, seen.oct, seen.pan);
        best.heard = seen.v;
      } else if (lit.length < MOST) {
        lit.push({ oct: seen.oct, pan: seen.pan, level: 0, heard: seen.v, was: 0, age: 0, still: 1, seed: Math.random() });
      }
    }
    sightings = [];
    let sum = 0;
    for (const star of lit) {
      const rate = star.trail ? 2.6 : star.heard > star.level ? 16 : 1.7;
      star.level += (star.heard - star.level) * Math.min(1, dt * rate);
      if (!star.trail) sum += star.level;
    }
    lit = lit.filter((star) => star.level > 0.006 || star.heard > 0);
    level += (Math.min(1, sum / 24) - level) * Math.min(1, dt * 3);
  }

  function listen(dt) {
    const heard = sides ? hear(dt) : false;
    silentFor = heard ? 0 : silentFor + dt;
    if (silentFor > 2) {
      // Nothing is heard, and the page plays the compound itself.
      sightings = [];
      play(dt);
      kick *= Math.exp(-dt * 7);
      bass += (0.12 - bass) * Math.min(1, dt * 0.5);
    }
    follow(dt);
    low += (heavens.low - low) * Math.min(1, dt * 1.5);
    high += (heavens.high - high) * Math.min(1, dt * 1.5);
  }

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key === shownKey) return;
    const first = shownKey === null;
    shownKey = key;
    heavens = describeSky(compound);
    // What the page was playing of the old compound stops; its stars go out.
    notes = [];
    if (first) {
      low = heavens.low;
      high = heavens.high;
    }
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let horizon = 0;
  let unit = 6;
  let scale = 1;
  let turn = 6.283 * Math.random(); // the sky is found somewhere on its way round
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
    scale = w / Math.max(1, canvas.clientWidth);
    horizon = Math.round(h * WATER);
    // A star is as large on a phone as on a wide screen, near enough.
    unit = Math.min(10, Math.max(5.5, Math.min(canvas.clientWidth, canvas.clientHeight) / 75)) * scale;
  }

  // Where each star is in the picture.
  function place() {
    const floor = horizon + 0.07 * height; // clear of the land
    const ceiling = 0.975 * height;
    // The station goes no further to a side than eight tenths of the way,
    // for anything with a pitch: that is the edge of the sky.
    const across = (pan) => 0.5 + 0.47 * Math.max(-1, Math.min(1, pan * 1.2));
    const above = (oct) => (oct - low) / (high - low);
    let n = 0;
    for (const star of lit) {
      const up = above(star.oct);
      // What is below the sky's pitches is the bass, which is the glow.
      if (up < 0 || up > 1.02 || n >= MOST) continue;
      // The colours are spread over the part of the sky the chords are
      // played in, which is not all of it.
      const hue = (up - 0.15) / 0.6;
      const y = floor + up * (ceiling - floor);
      if (star.trail) {
        starData.set([across(star.pan), y, star.level, hue, star.seed, 1, across(star.toPan), floor + above(star.toOct) * (ceiling - floor)], n * 8);
      } else {
        starData.set([across(star.pan), y, star.level, hue, star.seed, 0, 0, 0], n * 8);
      }
      n += 1;
    }
    return n;
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
    listen(dt);
    const count = place();
    dim += ((heavens.idle ? 0.55 : 1) - dim) * Math.min(1, dt * 0.8);
    // once round in a little over half an hour
    turn = (turn + dt * 0.003) % 6.2831853;

    uniformData.set([width, height, time % 3600, horizon, unit, count, bass, kick,
      level, dim, (0.9 * horizon) / (height - horizon), turn, scale, 0, 0, 0], 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    if (count) device.queue.writeBuffer(starBuffer, 0, starData, 0, count * 8);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.0667, g: 0.0667, b: 0.0667, a: 1 }, // the page's #111
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setBindGroup(0, group);
    pass.setPipeline(groundPipeline);
    pass.draw(3);
    if (count) {
      // each star twice: in the sky, and on the water
      pass.setPipeline(starPipeline);
      pass.draw(6, 2 * count);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    const done = () => { busy = false; };
    device.queue.onSubmittedWorkDone().then(done, done);
  }

  followCompound();
  const followTimer = setInterval(followCompound, 1000);
  fit();
  // The sky that is there to begin with: a quarter of a minute of the
  // page's own playing, so that it does not open on an empty one.
  for (let n = 0; n < 300; n++) {
    play(0.05);
    follow(0.05);
  }
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
