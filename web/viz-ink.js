// "ink": the compound as ink let into water (WebGPU).
//
// A dish of still water, seen from above. Each voiced peak of the current
// compound's mass spectrum has a place on the rim of the dish, low peaks at
// the left to high peaks at the right, and lets ink into the water from
// there in puffs: ink of the colour the peak has in the other visuals, warm
// for the low peaks to blue for the high, more of it and more often the
// stronger the peak. So what is in the dish is the spectrum as amounts of
// colour.
//
// The water is a real fluid. A puff is a short push at the water, and what
// a push does to water is roll it up into a pair of whirls that travel on
// together and carry the ink along as a mushroom, until they meet the ink
// of another peak and are wound into it. Nothing is drawn but the ink: the
// water is only seen by what it does to it. The ink thins out as it goes,
// so the dish never fills.
//
// Where the page can hear the stream, a peak lets its ink in faster and
// with more force while there is energy around its pitch, and a kick sends
// one hard puff more, from a different place every time. Where it cannot
// (iOS gives a page no sound to look at for a live stream) a slow swell of
// its own does the same, as in "bloom". A new compound clears the water,
// and its peaks begin on it.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const MAX_PUFFS = 16; // pushing at the water at one time
const FINE = 3; // the ink is kept this many times finer than the water's motion

const SHADER = /* wgsl */ `
struct Puff {
  at: vec2f,     // where, in cells
  push: vec2f,   // what it adds to the water's speed there in this step
  ink: vec3f,    // what it adds to the ink there in this step
  radius: f32,   // in cells
};

struct Uniforms {
  grid: vec2f,   // cells across and down
  fine: vec2f,   // cells of ink across and down
  view: vec2f,   // the canvas, in pixels
  time: f32,
  dt: f32,
  fade: f32,     // what is left of the ink after this step
  calm: f32,     // what is left of the water's speed after this step
  curl: f32,     // how much a whirl is helped to keep turning
  glow: f32,
  puffCount: f32,
  puffs: array<Puff, ${MAX_PUFFS}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// The water's speed in each cell, in cells a second; its pressure; how much
// more flows out of a cell than into it; and the ink, on its finer grid.
@group(1) @binding(0) var<storage, read> velIn: array<vec2f>;
@group(1) @binding(1) var<storage, read_write> velOut: array<vec2f>;
@group(1) @binding(2) var<storage, read> prsIn: array<f32>;
@group(1) @binding(3) var<storage, read_write> prsOut: array<f32>;
@group(1) @binding(4) var<storage, read> divIn: array<f32>;
@group(1) @binding(5) var<storage, read_write> divOut: array<f32>;
@group(1) @binding(6) var<storage, read> inkIn: array<vec4f>;
@group(1) @binding(7) var<storage, read_write> inkOut: array<vec4f>;

// The dish has no walls: what leaves by one side comes in by the other, so
// the water is the same everywhere and the picture has no edge to it.
fn cellIndex(c: vec2i) -> u32 {
  let n = vec2i(u.grid);
  let q = ((c % n) + n) % n;
  return u32(q.y) * u32(n.x) + u32(q.x);
}

fn velAt(c: vec2i) -> vec2f {
  return velIn[cellIndex(c)];
}

// The water's speed at a place between cells. A cell's own value is at its
// middle.
fn velNear(p: vec2f) -> vec2f {
  let q = p - vec2f(0.5);
  let i = vec2i(floor(q));
  let f = fract(q);
  return mix(
    mix(velAt(i), velAt(i + vec2i(1, 0)), f.x),
    mix(velAt(i + vec2i(0, 1)), velAt(i + vec2i(1, 1)), f.x),
    f.y,
  );
}

// The short way from one place to another, which may be across an edge.
fn around(d: vec2f) -> vec2f {
  return d - u.grid * round(d / u.grid);
}

// How fast the water turns about a cell.
fn turnAt(c: vec2i) -> f32 {
  return 0.5 * ((velAt(c + vec2i(1, 0)).y - velAt(c - vec2i(1, 0)).y)
    - (velAt(c + vec2i(0, 1)).x - velAt(c - vec2i(0, 1)).x));
}

// ---- the water ---------------------------------------------------------------

// The water carries its own motion along with it, and is pushed.
@compute @workgroup_size(8, 8)
fn carryWater(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.grid.x) || id.y >= u32(u.grid.y)) {
    return;
  }
  let c = vec2i(id.xy);
  let here = vec2f(c) + vec2f(0.5);
  var v = velNear(here - u.dt * velAt(c));

  // Carrying the motion along on a grid smears the whirls out, which real
  // water does not do to them. Each is given back a little of its turning:
  // a push round the place where the turning is strongest.
  let turn = turnAt(c);
  let toward = 0.5 * vec2f(
    abs(turnAt(c + vec2i(1, 0))) - abs(turnAt(c - vec2i(1, 0))),
    abs(turnAt(c + vec2i(0, 1))) - abs(turnAt(c - vec2i(0, 1))),
  );
  let n = toward / (length(toward) + 0.25);
  v += u.curl * u.dt * turn * vec2f(n.y, -n.x);
  v *= u.calm;

  let count = u32(u.puffCount);
  for (var k = 0u; k < count; k++) {
    let p = u.puffs[k];
    let d = around(here - p.at) / p.radius;
    let far = dot(d, d);
    if (far < 9.0) {
      v += p.push * exp(-far);
    }
  }
  velOut[cellIndex(c)] = v;
}

// Water cannot be squeezed, so as much must flow into a cell as out of it.
// After the step above that is no longer so. How far off each cell is:
@compute @workgroup_size(8, 8)
fn measure(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.grid.x) || id.y >= u32(u.grid.y)) {
    return;
  }
  let c = vec2i(id.xy);
  divOut[cellIndex(c)] = 0.5 * ((velAt(c + vec2i(1, 0)).x - velAt(c - vec2i(1, 0)).x)
    + (velAt(c + vec2i(0, 1)).y - velAt(c - vec2i(0, 1)).y));
}

// The pressure that would put it right, found a little better each time
// this is run.
@compute @workgroup_size(8, 8)
fn press(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.grid.x) || id.y >= u32(u.grid.y)) {
    return;
  }
  let c = vec2i(id.xy);
  prsOut[cellIndex(c)] = 0.25 * (prsIn[cellIndex(c - vec2i(1, 0))] + prsIn[cellIndex(c + vec2i(1, 0))]
    + prsIn[cellIndex(c - vec2i(0, 1))] + prsIn[cellIndex(c + vec2i(0, 1))]
    - divIn[cellIndex(c)]);
}

// And the water gives way to the pressure.
@compute @workgroup_size(8, 8)
fn giveWay(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.grid.x) || id.y >= u32(u.grid.y)) {
    return;
  }
  let c = vec2i(id.xy);
  let slope = 0.5 * vec2f(
    prsIn[cellIndex(c + vec2i(1, 0))] - prsIn[cellIndex(c - vec2i(1, 0))],
    prsIn[cellIndex(c + vec2i(0, 1))] - prsIn[cellIndex(c - vec2i(0, 1))],
  );
  velOut[cellIndex(c)] = velAt(c) - slope;
}

// ---- the ink -----------------------------------------------------------------

fn inkIndex(c: vec2i) -> u32 {
  let n = vec2i(u.fine);
  let q = ((c % n) + n) % n;
  return u32(q.y) * u32(n.x) + u32(q.x);
}

// The ink at a place between its cells.
fn inkNear(p: vec2f) -> vec3f {
  let q = p - vec2f(0.5);
  let i = vec2i(floor(q));
  let f = fract(q);
  return mix(
    mix(inkIn[inkIndex(i)].rgb, inkIn[inkIndex(i + vec2i(1, 0))].rgb, f.x),
    mix(inkIn[inkIndex(i + vec2i(0, 1))].rgb, inkIn[inkIndex(i + vec2i(1, 1))].rgb, f.x),
    f.y,
  );
}

// The water carries the ink, the ink thins, and the puffs add to it.
@compute @workgroup_size(8, 8)
fn carryInk(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.fine.x) || id.y >= u32(u.fine.y)) {
    return;
  }
  let c = vec2i(id.xy);
  let scale = u.fine / u.grid;
  let here = (vec2f(c) + vec2f(0.5)) / scale; // in the water's cells
  // Along the edge of the picture the ink thins quickly, so that none is
  // carried out by one side and in by the other.
  let inside = min(min(here.x, u.grid.x - here.x), min(here.y, u.grid.y - here.y));
  let edge = 1.0 - smoothstep(0.0, 0.08 * min(u.grid.x, u.grid.y), inside);
  var ink = inkNear((here - u.dt * velNear(here)) * scale) * u.fade * exp(-2.5 * u.dt * edge);

  let count = u32(u.puffCount);
  for (var k = 0u; k < count; k++) {
    let p = u.puffs[k];
    let d = around(here - p.at) / (0.7 * p.radius);
    let far = dot(d, d);
    if (far < 9.0) {
      ink += p.ink * exp(-far);
    }
  }
  inkOut[inkIndex(c)] = vec4f(ink, 1.0);
}

// ---- drawing ---------------------------------------------------------------------

@vertex
fn drawVertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

@fragment
fn drawFragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy / u.view * u.fine;
  let ink = inkNear(at) * u.glow;
  // Thick ink is bright but keeps its colour: the strongest of red, green
  // and blue is what is held under white, and the others stay in step.
  // Thin ink is shown fainter than its share, so that a haze of it does
  // not hide the threads and curls of the thick.
  let most = max(ink.r, max(ink.g, ink.b));
  let held = (1.0 - exp(-0.25 * most - 0.6 * most * most)) / max(most, 0.0001);
  var colour = ink * held;
  // Where it is thickest it is lit a little towards white.
  colour += vec3f(0.2) * (1.0 - exp(-0.05 * most * most));
  let ground = vec3f(0.0667); // the page's #111
  return vec4f(ground + colour * (1.0 - ground), 1.0);
}
`;

// ---- sources from a compound ----------------------------------------------------

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

// With no compound: twelve even sources spread over the audible range.
function idlePeaks() {
  return Array.from({ length: 12 }, (_, k) => ({ f: 80 * Math.pow(75, k / 11), a: 0.5, idle: true }));
}

// Warm for the lowest peaks, through green, to blue for the highest: the
// same order as in the other visuals.
function palette(h) {
  const t = Math.min(1, Math.max(0, h));
  const low = [1.0, 0.28, 0.12];
  const mid = [0.22, 1.0, 0.4];
  const high = [0.18, 0.4, 1.0];
  const [a, b, s] = t < 0.5 ? [low, mid, t * 2] : [mid, high, (t - 0.5) * 2];
  return a.map((v, k) => v + (b[k] - v) * s);
}

function describeSources(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const strengths = peaks.map((p) => Math.sqrt(p.a));
  const whole = strengths.reduce((sum, s) => sum + s + 0.08, 0);
  // A compound of a few peaks is a quieter dish than one of many.
  const puffsASecond = Math.min(2.8, 0.6 + 0.09 * peaks.length);
  const rates = strengths.map((s) => puffsASecond * (s + 0.08) / whole);
  // How much ink a puff holds, and how wide it is, as a share of the
  // dish's shorter side.
  const inks = peaks.map((p, k) => (p.idle ? 0.9 : 1.1 + 1.5 * strengths[k]));
  const radii = strengths.map((s) => 0.028 + 0.03 * s);
  // A compound of many strong peaks would fill the dish with flat colour.
  // Its puffs come less often, until it lets in no more ink in a second
  // than a typical compound does, so that its threads and curls can be
  // seen too.
  const flood = rates.reduce((sum, rate, k) => sum + rate * inks[k] * radii[k] * radii[k], 0);
  const thinned = Math.min(1, 0.012 / flood);
  return peaks.map((p, k) => {
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    return {
      // Low peaks at the left of the rim to high peaks at the right, as
      // a spectrum is drawn, and by turns over the top and under the foot
      // of the dish, so that the rim is filled all the way round.
      across: -Math.cos(Math.PI * x),
      down: (k % 2 ? 1 : -1) * Math.sin(Math.PI * x),
      band: bandOf(p.f),
      strength: strengths[k],
      colour: palette(x),
      rate: rates[k] * thinned,
      ink: inks[k],
      radius: radii[k],
      due: 0.4 + 0.6 * Math.random(), // how near its next puff is, 0..1
      lean: k * 2.399963, // where its aim has got to in its wandering
    };
  });
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

  const uniformData = new Float32Array(16 + MAX_PUFFS * 8);
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
      { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const sharedGroup = device.createBindGroup({
    layout: sharedLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // Each step of the simulation reads some of the buffers and writes one.
  // The numbers are the bindings in the shader; an odd one is written to.
  const reads = (binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  const writes = (binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  const step = (entryPoint, entries) => {
    const layout = device.createBindGroupLayout({ entries });
    return {
      layout,
      pipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, layout] }),
        compute: { module, entryPoint },
      }),
      // buffers in the order of the entries
      group: (...buffers) => device.createBindGroup({
        layout,
        entries: buffers.map((buffer, k) => ({ binding: entries[k].binding, resource: { buffer } })),
      }),
    };
  };
  const carryWater = step('carryWater', [reads(0), writes(1)]);
  const measure = step('measure', [reads(0), writes(5)]);
  const press = step('press', [reads(2), reads(4), writes(3)]);
  const giveWay = step('giveWay', [reads(0), reads(2), writes(1)]);
  const carryInk = step('carryInk', [reads(0), reads(6), writes(7)]);

  const drawLayout = device.createBindGroupLayout({
    entries: [{ binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
  });
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, drawLayout] }),
    vertex: { module, entryPoint: 'drawVertex' },
    fragment: { module, entryPoint: 'drawFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  // ---- the ink follows the compound ----

  let sources = describeSources(null);
  let shownKey = null;
  let clearing = 0; // seconds a new compound still has to wait for clear water

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      if (shownKey !== null) clearing = 2.5;
      shownKey = key;
      sources = describeSources(compound);
    }
  }
  followCompound();
  const followTimer = setInterval(followCompound, 1000);

  // ---- the dish ----

  // A cell of water is three CSS pixels, more on a large window so the
  // dish never has more cells than a phone's GPU steps through with ease.
  function dishFor(cssWidth, cssHeight) {
    const shrink = Math.max(3, Math.sqrt((cssWidth * cssHeight) / 60000));
    return {
      w: Math.max(32, Math.round(cssWidth / shrink)),
      h: Math.max(32, Math.round(cssHeight / shrink)),
    };
  }

  let dish = null;

  function buildDish(w, h) {
    if (dish) dish.buffers.forEach((b) => b.destroy());
    const buffer = (floats) => device.createBuffer({
      size: floats * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Buffers start out as zeros: still water, and no ink in it.
    const vel = [buffer(w * h * 2), buffer(w * h * 2)];
    const prs = [buffer(w * h), buffer(w * h)];
    const div = buffer(w * h);
    const ink = [buffer(w * h * FINE * FINE * 4), buffer(w * h * FINE * FINE * 4)];
    dish = {
      w,
      h,
      buffers: [...vel, ...prs, div, ...ink],
      // The water as it is stands in vel[0] between frames, and the
      // pressure in prs[0], which is why it is always pressed an even
      // number of times.
      carryWater: carryWater.group(vel[0], vel[1]),
      measure: measure.group(vel[1], div),
      press: [0, 1].map((from) => press.group(prs[from], div, prs[1 - from])),
      giveWay: giveWay.group(vel[1], prs[0], vel[0]),
      carryInk: [0, 1].map((from) => carryInk.group(vel[0], ink[from], ink[1 - from])),
      draw: ink.map((b) => device.createBindGroup({
        layout: drawLayout,
        entries: [{ binding: 6, resource: { buffer: b } }],
      })),
      now: 0, // which of the two ink buffers holds the ink as it is now
      puffs: [], // { x, y, dx, dy, colour, radius, force, ink, born, life, given }
    };
  }

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

  // Energy of the stream around a peak: 0 is the lowest band, 1 the highest.
  function bandEnergy(b) {
    const x = Math.min(1, Math.max(0, b)) * (BANDS - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, BANDS - 1);
    return bands[i] + (bands[j] - bands[i]) * (x - i);
  }

  // ---- puffs ----

  // A source lets one puff of its ink into the water: from its place on the
  // rim, aimed across the dish at the middle or to one side of it, as its
  // aim wanders.
  function puff(source, time, energy, hard) {
    if (dish.puffs.length >= MAX_PUFFS) return;
    const short = Math.min(dish.w, dish.h);
    const cx = dish.w / 2;
    const cy = dish.h / 2;
    const x = cx + 0.38 * dish.w * source.across;
    const y = cy + 0.3 * dish.h * source.down;
    const aim = Math.atan2(cy - y, cx - x) + 0.6 * Math.sin(time * 0.11 + source.lean);
    const strength = source.strength;
    // It is pushed harder the further it has to go, so that in a long
    // window the ink from the two ends still meets.
    const reach = Math.sqrt(short * Math.hypot(cx - x, cy - y) / 0.38);
    dish.puffs.push({
      x,
      y,
      dx: Math.cos(aim),
      dy: Math.sin(aim),
      colour: source.colour,
      radius: short * source.radius,
      // what it adds in all to the water's speed at its middle, in cells a second
      force: reach * (0.34 + 0.3 * strength) * (0.7 + 1.1 * energy) * (hard ? 1.4 : 1),
      ink: source.ink * (0.8 + 0.9 * energy),
      born: time,
      life: 0.28,
      given: 0, // how much of its force and ink the water has had, 0..1
    });
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the pressure is found less exactly in each until
  // they are not. A slow GPU gets looser water, not a backlog.
  let busy = false;
  let most = 24; // times the pressure is bettered in one frame
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let slowness = 0; // smoothed seconds per frame
  let wasKick = false;
  let kicks = 0;
  let begun = 0; // seconds the sources have been at work on clear water

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, sharp);
    const w = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
    }
    // A dish made for a window of another shape is stretched to cover this
    // one, up to a point; past it (a phone turned on its side) a new dish
    // is started.
    const want = dishFor(canvas.clientWidth, canvas.clientHeight);
    if (!dish || Math.abs(want.w - dish.w) > 0.15 * dish.w || Math.abs(want.h - dish.h) > 0.15 * dish.h) {
      buildDish(want.w, want.h);
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
      if (slowness > 0.045 && most > 6) {
        most = Math.max(6, 2 * Math.floor(most * 0.35));
        slowness = 0.03;
      } else if (slowness > 0.045 && sharp > 1) {
        sharp = 1; // still slow with loose water: a coarser picture too
        slowness = 0.03;
      } else if (slowness < 0.02 && most < 24) {
        most += 2;
      }
    }
    fit();
    listen(time, dt);

    // Each source comes due at its own rate, sooner while the stream has
    // energy around its peak. On clear water they are all in haste at
    // first, so that the dish is not left empty while the slow ones come
    // round. A kick is one hard puff more, from a source that is somewhere
    // else on the rim at every kick.
    clearing = Math.max(0, clearing - dt);
    begun = clearing > 0 ? 0 : begun + dt;
    const haste = 1 + 3 * Math.exp(-begun / 0.8);
    // A puff is as wide as the dish's shorter side makes it, so a dish that
    // is nearly square has less room for them than a long one.
    const room = Math.min(1, Math.max(dish.w, dish.h) / Math.min(dish.w, dish.h) / 1.9);
    if (clearing === 0) {
      const kicked = kick > 0.55;
      if (kicked && !wasKick) {
        kicks += 1;
        const source = sources[Math.floor(((kicks * 0.6180339887498949) % 1) * sources.length)];
        puff(source, time, bandEnergy(source.band), true);
      }
      wasKick = kicked;
      sources.forEach((source) => {
        const energy = bandEnergy(source.band);
        source.due += dt * source.rate * (0.35 + 2.4 * energy) * haste * room;
        if (source.due >= 1) {
          source.due = Math.min(source.due - 1, 0.5);
          puff(source, time, energy, false);
        }
      });
    }

    // A puff pushes for a moment, most in the middle of it. Over its life
    // it adds its whole force and ink, however long the frames are: each
    // frame gives what has come due since the last.
    dish.puffs = dish.puffs.filter((p) => p.given < 1);
    uniformData.fill(0, 16);
    dish.puffs.forEach((p, k) => {
      const age = Math.min(1, (time - p.born) / p.life);
      const due = age - Math.sin(2 * Math.PI * age) / (2 * Math.PI); // 2 sin^2, summed up to now
      const share = due - p.given;
      p.given = age < 1 ? due : 1;
      uniformData.set([
        p.x, p.y, p.dx * p.force * share, p.dy * p.force * share,
        p.colour[0] * p.ink * share, p.colour[1] * p.ink * share, p.colour[2] * p.ink * share, p.radius,
      ], 16 + k * 8);
    });

    uniformData.set([
      dish.w, dish.h, dish.w * FINE, dish.h * FINE,
      width, height, time, dt,
      // The ink thins all the time, and is gone at once before a new compound.
      Math.exp(-dt / (clearing > 0 ? 0.45 : 16)),
      // Left alone, the water comes to rest in a few seconds.
      Math.exp(-dt / 5),
      Math.min(dish.w, dish.h) * 0.02,
      2.2 * (1 + 0.2 * kick),
      dish.puffs.length,
    ], 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const across = Math.ceil(dish.w / 8);
    const down = Math.ceil(dish.h / 8);
    const encoder = device.createCommandEncoder();
    const compute = encoder.beginComputePass();
    compute.setBindGroup(0, sharedGroup);
    compute.setPipeline(carryWater.pipeline);
    compute.setBindGroup(1, dish.carryWater);
    compute.dispatchWorkgroups(across, down);
    compute.setPipeline(measure.pipeline);
    compute.setBindGroup(1, dish.measure);
    compute.dispatchWorkgroups(across, down);
    compute.setPipeline(press.pipeline);
    for (let s = 0; s < most; s++) {
      compute.setBindGroup(1, dish.press[s % 2]);
      compute.dispatchWorkgroups(across, down);
    }
    compute.setPipeline(giveWay.pipeline);
    compute.setBindGroup(1, dish.giveWay);
    compute.dispatchWorkgroups(across, down);
    compute.setPipeline(carryInk.pipeline);
    compute.setBindGroup(1, dish.carryInk[dish.now]);
    compute.dispatchWorkgroups(Math.ceil((dish.w * FINE) / 8), Math.ceil((dish.h * FINE) / 8));
    dish.now = 1 - dish.now;
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
    pass.setBindGroup(1, dish.draw[dish.now]);
    pass.draw(3);
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
