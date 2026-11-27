// "sand": Chladni figures (WebGPU).
//
// Particles on a vibrating square plate collect along the nodal lines.
// Each voiced peak drives one plate mode (higher peak = finer mode, stronger
// peak = more drive). Each mode slowly rotates between its two degenerate
// shapes, so the figure keeps changing. Grains are coloured by the low, mid
// or high group of peaks they belong to and respond most to that group's
// modes. A new compound jolts the plate.
//
// Audio: energy near a peak drives its mode harder, loudness shakes the
// sand, kicks thump the plate. Without audio (e.g. iOS) a slow internal
// swell stands in.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. Throws if WebGPU is unavailable.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

// The plate's modes, coarsest first. Mode (n, m) has n still lines one way
// and m the other across half the plate, and a real plate's pitch rises
// with n*n + m*m, which is the order here.
const MODES = [];
for (let m = 2; m <= 6; m++) for (let n = 1; n < m; n++) MODES.push({ n, m });
MODES.sort((a, b) => (a.n * a.n + a.m * a.m) - (b.n * b.n + b.m * b.m) || a.m - b.m);

const SHADER = /* wgsl */ `
struct Uniforms {
  scale: vec2f,   // the plate's half-side in clip space
  noise: vec2f,   // two fresh random numbers every frame
  dt: f32,
  modeCount: f32,
  size: f32,      // a grain's radius, in plate half-sides
  shake: f32,     // how hard the sand is being shaken
  thump: f32,     // a kick, or a new compound: every grain jumps
  glow: f32,
  lean: f32,      // how much more a grain feels the modes of its own part
  sprinkle: f32,  // how fast grains are picked up and dropped again
};

struct Grain {
  pos: vec2f,
  vel: vec2f,     // how far it still has to go, smoothed: grains on their way are brighter
  seed: f32,
  seed2: f32,
  age: f32,
  life: f32,
};

struct Mode {
  n: f32,
  m: f32,
  a: f32,  // how much of each of the mode's two shapes is in the figure now
  b: f32,
  hue: f32,
  gain: f32,
  part: f32, // which of the figure's colours it belongs to: 0, 1 or 2
  pad: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> assign: array<u32>;
@group(0) @binding(2) var<storage, read> modes: array<Mode>;

fn hash(x: f32) -> f32 {
  return fract(sin(x * 127.1 + 0.3) * 43758.5453);
}

// The plate's height at p as a grain of the given part feels it, and its slope.
fn plate(p: vec2f, own: f32) -> vec3f {
  var f = vec3f(0.0);
  let count = u32(u.modeCount);
  for (var k = 0u; k < count; k++) {
    let md = modes[k];
    let w = 3.14159265 * vec2f(md.n, md.m);
    let cx = cos(w * p.x);
    let sx = sin(w * p.x);
    let cy = cos(w * p.y);
    let sy = sin(w * p.y);
    let one = vec3f(cx.x * cy.y, -w.x * sx.x * cy.y, -w.y * cx.x * sy.y);
    let two = vec3f(cx.y * cy.x, -w.y * sx.y * cy.x, -w.x * cx.y * sy.x);
    let felt = select(1.0, 1.0 + u.lean, md.part == own);
    f += felt * (md.a * one + md.b * two);
  }
  return f;
}

// ---- simulation ------------------------------------------------------------

@group(1) @binding(0) var<storage, read_write> grains: array<Grain>;

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&grains)) {
    return;
  }
  var g = grains[i];
  let r = hash(g.seed * 7.3 + u.noise.x * 91.7);
  let r2 = hash(g.seed2 * 5.9 + u.noise.y * 57.3);

  g.age += u.dt * u.sprinkle;
  if (g.age > g.life) {
    // Picked up and dropped somewhere else on the plate.
    g.pos = vec2f(r, r2) * 2.0 - 1.0;
    g.vel = vec2f(0.0);
    g.age = 0.0;
    g.life = 8.0 + 22.0 * hash(r + r2 * 3.1);
  }

  let f = plate(g.pos, modes[assign[i]].part);
  let slope = f.yz;
  // The nearest still line is about height / slope away, downhill of the
  // height squared. Sand does not find it at once: it is shaken there.
  var toLine = -f.x * slope / (dot(slope, slope) + 0.6);
  let far = length(toLine);
  toLine *= min(1.0, 0.2 / max(far, 0.0001));
  var walk = toLine * (1.0 - exp(-u.dt * (1.2 + 3.0 * u.shake)));

  // A grain hops further the more the plate moves under it.
  let hop = (0.0012 + 0.022 * abs(f.x) * u.shake + 0.018 * u.thump) * sqrt(u.dt * 60.0);
  let turn = r * 6.2831853;
  walk += vec2f(cos(turn), sin(turn)) * hop * (0.3 + r2);

  // The plate moves the same way on both sides of its edge, so a grain
  // that would leave is turned back as far as it went over.
  let to = g.pos + walk;
  g.pos = clamp(sign(to) * (1.0 - abs(1.0 - abs(to))), vec2f(-1.0), vec2f(1.0));
  g.vel = mix(g.vel, toLine * 3.0, 0.15);
  grains[i] = g;
}

// ---- drawing ---------------------------------------------------------------

@group(1) @binding(1) var<storage, read> drawn: array<Grain>;

struct Sprite {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};

// Warm for the lowest peaks, through green, to blue for the highest: the
// same order as the other visuals.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

@vertex
fn drawVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Sprite {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let g = drawn[ii];
  let md = modes[assign[ii]];
  let corner = corners[vi];
  let size = u.size * (0.7 + 0.6 * hash(g.seed2 * 9.7));
  // A grain fades in where it lands and out before it is picked up.
  let shown = smoothstep(0.0, 0.6, g.age) * (1.0 - smoothstep(g.life - 1.0, g.life, g.age));

  var out: Sprite;
  out.pos = vec4f((g.pos + corner * size) * u.scale, 0.0, 1.0);
  out.uv = corner;
  out.color = palette(md.hue) * md.gain * u.glow * shown
    * (0.55 + 0.9 * min(length(g.vel), 1.5));
  return out;
}

@fragment
fn drawFragment(sprite: Sprite) -> @location(0) vec4f {
  let d = dot(sprite.uv, sprite.uv);
  let a = exp(-d * 3.5) * step(d, 1.0);
  return vec4f(sprite.color * a, a);
}
`;

// ---- modes from a compound -----------------------------------------------------

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

// With no compound: three plain modes, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 0.7, idle: true }, { f: 640, a: 0.5, idle: true }];
}

// Which mode each peak drives. Where the compound sits between 80 Hz and
// 4 kHz sets how fine its figure is as a whole, and its peaks are spread
// over the modes around that in the order of their frequencies: three modes
// to the octave, but over at least six modes (or one a peak, for fewer
// peaks) however close together the peaks lie, so that every compound
// draws a figure of its own.
function describeModes(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const last = MODES.length - 1;
  const mean = logs.reduce((sum, l) => sum + l, 0) / logs.length;
  const centre = last * Math.min(1, Math.max(0, (mean - Math.log(80)) / Math.log(50)));
  const width = Math.min(last, Math.max((span / Math.LN2) * 3, Math.min(peaks.length - 1, 5)));
  const from = Math.min(last - width, Math.max(0, centre - width / 2));

  const byMode = new Map();
  peaks.forEach((p, k) => {
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    const index = Math.round(from + x * width);
    const strength = Math.sqrt(p.a);
    const mode = byMode.get(index) || { index, power: 0, weight: 0, hue: 0, band: 0, share: 0, idle: !!p.idle };
    mode.power += p.a;
    mode.weight += strength;
    mode.hue += x * strength;
    mode.band += bandOf(p.f) * strength;
    mode.share += strength + 0.08;
    byMode.set(index, mode);
  });
  // The modes fall into at most three parts, low, middle and high, of about
  // the same number of grains each; up to three modes are a part each.
  const found = [...byMode.values()].sort((a, b) => a.index - b.index);
  const grains = found.reduce((sum, mode) => sum + mode.share, 0);
  let before = 0;
  found.forEach((mode, k) => {
    mode.part = found.length <= 3 ? k : Math.min(2, Math.floor((3 * (before + mode.share / 2)) / grains));
    before += mode.share;
  });
  return found.map((mode, k) => ({
    n: MODES[mode.index].n,
    m: MODES[mode.index].m,
    drive: Math.sqrt(mode.power),
    hue: mode.hue / mode.weight,
    band: mode.band / mode.weight,
    gain: mode.idle ? 0.5 : 1,
    part: mode.part,
    share: mode.share, // of the grains
    // Where the mode starts among its mixes, and how fast and which way it
    // turns through them: different for every mode, the same for a compound
    // every time it is shown.
    turn: mode.index * 2.399963 + 0.6,
    rate: (k % 2 ? -1 : 1) * (0.03 + 0.025 * ((mode.index * 0.6180339887) % 1)),
  }));
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

  // Fewer grains on small or low-powered devices; ?particles=N overrides.
  const asked = Number(new URLSearchParams(location.search).get('particles'));
  const modest = Math.min(window.innerWidth, window.innerHeight) < 700
    || (navigator.hardwareConcurrency || 4) <= 4;
  const count = asked > 0 ? Math.min(Math.floor(asked), 400000) : (modest ? 60000 : 140000);

  // Grains start scattered all over the plate, at every age, so they are
  // not all picked up at once later.
  const grainData = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const life = 8 + 22 * Math.random();
    grainData.set([
      Math.random() * 2 - 1, Math.random() * 2 - 1, 0, 0,
      Math.random(), Math.random(), Math.random() * life, life,
    ], i * 8);
  }
  const grainBuffer = device.createBuffer({
    size: grainData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(grainBuffer, 0, grainData);

  const assignBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const modeData = new Float32Array(MODES.length * 8);
  const modeBuffer = device.createBuffer({
    size: modeData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new Float32Array(12);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  }

  const sharedLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const simulateLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
  });
  const drawLayout = device.createBindGroupLayout({
    entries: [{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
  });

  const simulatePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, simulateLayout] }),
    compute: { module, entryPoint: 'simulate' },
  });
  const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, drawLayout] }),
    vertex: { module, entryPoint: 'drawVertex' },
    fragment: {
      module,
      entryPoint: 'drawFragment',
      targets: [{ format, blend: { color: additive, alpha: additive } }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const sharedGroup = device.createBindGroup({
    layout: sharedLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: assignBuffer } },
      { binding: 2, resource: { buffer: modeBuffer } },
    ],
  });
  const simulateGroup = device.createBindGroup({
    layout: simulateLayout,
    entries: [{ binding: 0, resource: { buffer: grainBuffer } }],
  });
  const drawGroup = device.createBindGroup({
    layout: drawLayout,
    entries: [{ binding: 1, resource: { buffer: grainBuffer } }],
  });

  // ---- the figure follows the compound ----

  let modes = [];
  let shownKey = null;
  let changed = 0; // a new compound jolts the plate

  function applyCompound(compound) {
    modes = describeModes(compound);

    // Hand out grains in proportion to each mode's share. Walking the
    // shares with the golden ratio spreads every mode evenly along the
    // buffer, so drawing only the first part of it (see "active" below)
    // thins every colour instead of dropping some.
    const total = modes.reduce((sum, m) => sum + m.share, 0);
    const upTo = [];
    modes.reduce((sum, m) => {
      upTo.push((sum + m.share) / total);
      return sum + m.share;
    }, 0);
    const assignData = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const at = ((i + 0.5) * 0.6180339887498949) % 1;
      let mode = 0;
      while (mode < upTo.length - 1 && at > upTo[mode]) mode++;
      assignData[i] = mode;
    }
    device.queue.writeBuffer(assignBuffer, 0, assignData);
  }

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      if (shownKey !== null) changed = 1;
      shownKey = key;
      applyCompound(compound);
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
      // player gives silence): the plate is driven by a slow swell instead.
      for (let b = 0; b < BANDS; b++) {
        fresh[b] = 0.22 + 0.16 * Math.sin(time * (0.17 + 0.05 * b) + b * 1.9);
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

  // Energy of the stream around a mode's pitch: 0 is the lowest band, 1 the highest.
  function bandEnergy(b) {
    const x = Math.min(1, Math.max(0, b)) * (BANDS - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, BANDS - 1);
    return bands[i] + (bands[j] - bands[i]) * (x - i);
  }

  // How much of each mode is in the figure now.
  function driveModes(dt) {
    let total = 0;
    const driven = modes.map((mode) => {
      const e = bandEnergy(mode.band);
      mode.turn += mode.rate * (0.5 + 2.5 * e) * dt;
      const d = mode.drive * (0.25 + e);
      total += d;
      return d;
    });
    modes.forEach((mode, k) => {
      const d = driven[k] / (total || 1);
      // Either shape alone is a plain grid of straight lines; the even
      // mixes are the figures. The mode lingers at those and hurries past
      // the grids.
      const mix = mode.turn + 0.2 * Math.sin(4 * mode.turn);
      modeData.set([mode.n, mode.m, d * Math.cos(mix), d * Math.sin(mix), mode.hue, mode.gain, mode.part, 0], k * 8);
    });
    device.queue.writeBuffer(modeBuffer, 0, modeData);
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the number of grains simulated and drawn comes down
  // until they are not. A slow GPU gets less sand, not a backlog.
  let busy = false;
  let active = count;
  let slowness = 0; // smoothed seconds per frame
  const fewest = Math.min(count, 4000);

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
    }
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
      if (slowness > 0.045 && active > fewest) {
        active = Math.max(fewest, Math.floor(active * 0.8));
        slowness = 0.03;
      } else if (slowness < 0.02 && active < count) {
        active = Math.min(count, Math.ceil(active * 1.05));
      }
    }
    fit();
    listen(time, dt);
    driveModes(dt);
    changed *= Math.exp(-dt * 3);

    // The plate is a square in the middle, as wide as the shorter side of
    // the window allows, which leaves the page's words clear of it on a
    // phone held upright.
    const side = 0.94 * Math.min(width, height);
    uniformData[0] = side / width;
    uniformData[1] = side / height;
    uniformData[2] = Math.random();
    uniformData[3] = Math.random();
    uniformData[4] = dt;
    uniformData[5] = modes.length;
    uniformData[6] = 0.011; // grain size
    uniformData[7] = Math.min(1, 0.25 + 1.6 * level);
    uniformData[8] = Math.max(kick, 2 * changed);
    uniformData[9] = 0.2 * Math.sqrt(60000 / active); // per-grain glow: fewer grains, each brighter
    uniformData[10] = 2.0;
    uniformData[11] = 0.6 + 1.6 * level;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const compute = encoder.beginComputePass();
    compute.setPipeline(simulatePipeline);
    compute.setBindGroup(0, sharedGroup);
    compute.setBindGroup(1, simulateGroup);
    compute.dispatchWorkgroups(Math.ceil(active / 64));
    compute.end();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.0667, g: 0.0667, b: 0.0667, a: 1 }, // the page's #111
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(drawPipeline);
    pass.setBindGroup(0, sharedGroup);
    pass.setBindGroup(1, drawGroup);
    pass.draw(6, active);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const done = () => { busy = false; };
    device.queue.onSubmittedWorkDone().then(done, done);
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
