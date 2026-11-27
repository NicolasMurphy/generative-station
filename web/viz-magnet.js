// "magnet": a magnetic-sector mass spectrometer, seen from above (WebGPU).
//
// Each voiced peak is a beam of ions leaving a slit and bending through a
// 180° arc (radius grows with frequency) onto a detector plate, where a bar
// builds up to the peak's strength. Ions leave with a small angular spread,
// which the half circle refocuses, so beams are crescents.
//
// Audio: energy near a peak sends more ions into its beam, kicks send a
// burst into all of them. Flight takes a second or so, so you see the
// sound travel. Without audio (e.g. iOS) a slow internal swell stands in.
// A new compound closes the slit and lets the plate clear first.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. Throws if WebGPU is unavailable.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_BEAMS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const SLOTS = 256; // how much of what was sent is remembered, in steps
const SLOT_RATE = 30; // steps to a second
const NARROWEST = 0.3; // the lowest peak's circle, the highest's being 1
const ROUND = 3.4; // seconds from the slit to the plate on the widest circle

const SHADER = /* wgsl */ `
struct Uniforms {
  origin: vec2f,   // the slit, on the canvas (clip space)
  along: vec2f,    // one widest-circle radius along the plate
  away: vec2f,     // and one away from it, into the magnet
  pixel: vec2f,    // one pixel of the canvas
  slot: f32,       // where now is, in the ring of what was sent
  spread: f32,     // how far from straight the ions leave the slit
  glow: f32,       // of one ion
  long: f32,       // an ion's streak, in pixels
  wide: f32,
  beams: f32,      // how many there are
  bars: f32,       // the reach of the tallest line on the plate
  shine: f32,      // the plate itself
};

struct Beam {
  radius: f32,
  time: f32,       // seconds from the slit to the plate
  phase: f32,      // how far round its ions have come, as a part of the way
  hue: f32,
  gain: f32,
  bar: f32,        // its line on the plate, as a part of the tallest
  lands: f32,      // how much is landing just now
  pad: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> beams: array<Beam>;
@group(0) @binding(2) var<storage, read> sent: array<f32>;
@group(0) @binding(3) var<storage, read> assign: array<u32>;

const PI = 3.14159265;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// The same number between 0 and 1 for the same ion, every frame.
fn chance(ion: u32, which: u32) -> f32 {
  return f32(pcg(ion * 16u + which) >> 8u) / 16777216.0;
}

// Warm for the lowest, through green, to blue for the highest: the same
// order as in the other visuals.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

// A place in the instrument, on the canvas.
fn place(p: vec2f) -> vec2f {
  return u.origin + u.along * p.x + u.away * p.y;
}

// How much was being sent into a beam some seconds ago.
fn sentThen(beam: u32, ago: f32) -> f32 {
  var s = u.slot - ago * ${SLOT_RATE}.0;
  s = s - floor(s / ${SLOTS}.0) * ${SLOTS}.0;
  let i = u32(floor(s)) % ${SLOTS}u;
  let j = (i + 1u) % ${SLOTS}u;
  return mix(sent[beam * ${SLOTS}u + i], sent[beam * ${SLOTS}u + j], fract(s));
}

// ---- the ions ----------------------------------------------------------------

struct Ion {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) colour: vec3f,
};

@vertex
fn ionVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Ion {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vi];
  let k = assign[ii];
  let b = beams[k];

  // Most leave the slit very nearly straight, and those are the beam's
  // bright line; the rest leave well to one side or the other, and are the
  // haze about it. Leaning towards the plate is positive.
  let side = chance(ii, 0u) + chance(ii, 1u) + chance(ii, 2u) - 1.5;
  let lean = u.spread * side * select(1.0, 0.09, chance(ii, 3u) < 0.6);
  // Nor are they all quite as fast, which is what gives a line on the
  // plate its width.
  let radius = b.radius * (1.0 + 0.006 * (chance(ii, 4u) + chance(ii, 8u) - 1.0));
  let part = fract(chance(ii, 5u) + b.phase);
  let turned = part * (PI - 2.0 * lean);
  let p = radius * vec2f(cos(lean) - cos(lean + turned), sin(lean + turned) - sin(lean));
  let heading = vec2f(sin(lean + turned), cos(lean + turned));

  // An ion is drawn as a short streak along its way, a few pixels long
  // whatever the size of the canvas.
  let forward = normalize((u.along * heading.x + u.away * heading.y) / u.pixel);
  let aside = vec2f(-forward.y, forward.x);
  let streak = 0.7 + 0.6 * chance(ii, 6u);
  let offset = forward * corner.x * u.long * streak + aside * corner.y * u.wide;

  // It is as bright as the beam was when it left.
  let level = sentThen(k, part * b.time);
  let sparkle = 0.35 + 1.3 * chance(ii, 7u) * chance(ii, 6u);
  // and brightest where it strikes
  let strikes = 1.0 + 1.5 * smoothstep(0.965, 1.0, part);

  var out: Ion;
  out.pos = vec4f(place(p) + offset * u.pixel, 0.0, 1.0);
  out.uv = corner;
  out.colour = mix(palette(b.hue), vec3f(1.0), 0.12) * (b.gain * level * sparkle * strikes * u.glow);
  return out;
}

@fragment
fn ionFragment(ion: Ion) -> @location(0) vec4f {
  let d = dot(ion.uv, ion.uv);
  let a = exp(-d * 3.2) * step(d, 1.0);
  return vec4f(ion.colour * a, 1.0);
}

// ---- the plate, and what has landed on it -------------------------------------

struct Mark {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) colour: vec3f,
  @location(2) kind: f32,
};

// Three things are drawn here: a line for every beam, standing on the
// plate on the side away from the magnet; a glow where the beam strikes;
// and the plate.
@vertex
fn markVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Mark {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vi];
  let kind = ii / ${MAX_BEAMS}u;
  let k = ii % ${MAX_BEAMS}u;
  let b = beams[k];
  let alongPx = normalize(u.along / u.pixel);
  let awayPx = normalize(u.away / u.pixel);
  let unit = length(u.along / u.pixel); // a radius, in pixels

  var out: Mark;
  out.kind = f32(kind);
  out.uv = corner;
  out.colour = vec3f(0.0);
  out.pos = vec4f(2.0, 2.0, 0.0, 1.0); // nowhere, unless it is one of the three
  if (kind == 2u) {
    if (k == 0u) {
      let middle = place(vec2f(1.0, 0.0));
      let offset = alongPx * corner.x * 1.07 * unit + awayPx * corner.y * 1.5;
      out.pos = vec4f(middle + offset * u.pixel, 0.0, 1.0);
      out.colour = vec3f(u.shine);
    }
    return out;
  }
  if (f32(k) >= u.beams) {
    return out;
  }
  let foot = place(vec2f(2.0 * b.radius, 0.0));
  let colour = mix(palette(b.hue), vec3f(1.0), 0.15);
  if (kind == 0u) {
    let tall = max(u.bars * b.bar * unit, 0.001);
    let half = clamp(0.008 * unit, 2.2, 4.5);
    let offset = alongPx * corner.x * half - awayPx * (0.5 + 0.5 * corner.y) * tall;
    out.pos = vec4f(foot + offset * u.pixel, 0.0, 1.0);
    out.colour = colour * b.gain * min(1.0, 4.0 * b.bar) * (0.9 + 2.4 * b.lands);
  } else {
    let size = clamp(0.03 * unit, 7.0, 16.0) * (0.7 + 0.5 * min(b.lands, 1.5));
    out.pos = vec4f(foot + (alongPx * corner.x + awayPx * corner.y) * size * u.pixel, 0.0, 1.0);
    out.colour = mix(colour, vec3f(1.0), 0.35) * b.gain * b.lands * 1.3;
  }
  return out;
}

@fragment
fn markFragment(mark: Mark) -> @location(0) vec4f {
  var a = 0.0;
  if (mark.kind < 0.5) {
    // a line: soft at its sides, fading towards its tip
    let up = 0.5 + 0.5 * mark.uv.y;
    a = exp(-3.0 * mark.uv.x * mark.uv.x) * (1.0 - 0.6 * up) * (1.0 - smoothstep(0.9, 1.0, up));
  } else if (mark.kind < 1.5) {
    let d = dot(mark.uv, mark.uv);
    a = exp(-d * 4.0) * step(d, 1.0);
  } else {
    // the plate, with the slit in it
    let x = 1.0 + 1.07 * mark.uv.x;
    a = exp(-3.0 * mark.uv.y * mark.uv.y) * smoothstep(0.012, 0.03, abs(x))
      * (1.0 - smoothstep(0.96, 1.0, abs(mark.uv.x)));
  }
  return vec4f(mark.colour * a, 1.0);
}

// ---- the light that has gathered, onto the page ------------------------------

@group(1) @binding(0) var gathered: texture_2d<f32>;

@vertex
fn showVertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

@fragment
fn showFragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
  // Where ions cross or crowd together their light adds up, towards white
  // and not past it.
  let lit = 1.0 - exp(-textureLoad(gathered, vec2i(at.xy), 0).rgb);
  let page = vec3f(0.0667); // the page's #111
  return vec4f(page + (1.0 - page) * lit, 1.0);
}
`;

// ---- the beams a compound sends through the magnet ------------------------------

// Position of a frequency on the analyser's band axis, 0..1.
function bandOf(hz) {
  return Math.min(1, Math.max(0, Math.log(hz / LOW_HZ) / Math.log(SPAN)));
}

// The peaks the station voices: at most MAX_BEAMS, strongest first, none
// more than 40 dB below the strongest. Same rule as piece.scd.
function voicedPeaks(compound) {
  const freqs = (compound && compound.frequencies) || [];
  const amps = (compound && compound.amplitudes) || [];
  let peaks = freqs.map((f, i) => ({ f, a: amps[i] })).filter((p) => p.f > 0 && p.a >= 0);
  const top = Math.max(0, ...peaks.map((p) => p.a));
  if (!peaks.length || top <= 0) return null;
  peaks = peaks.filter((p) => p.a >= top * PEAK_FLOOR);
  if (peaks.length > MAX_BEAMS) {
    peaks = peaks.sort((p, q) => q.a - p.a).slice(0, MAX_BEAMS);
  }
  return peaks.sort((p, q) => p.f - q.f).map((p) => ({ f: p.f, a: p.a / top }));
}

// With no compound: four plain beams, dimly.
function idlePeaks() {
  return [100, 200, 400, 800].map((f) => ({ f, a: 1, idle: true }));
}

function describeBeams(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const idle = !!peaks[0].idle;
  return {
    idle,
    // A compound of few peaks has room for beams that open wide; one of
    // many has to keep them narrow, or they would all be one.
    spread: Math.min(0.15, Math.max(0.06, 0.3 / Math.sqrt(peaks.length))),
    beams: peaks.map((p, k) => {
      // the lowest peak on the narrowest circle, the highest on the
      // widest; a lone peak between them
      const x = span > 0 ? (logs[k] - lo) / span : 0.5;
      const radius = NARROWEST + (1 - NARROWEST) * x;
      const strength = Math.sqrt(p.a);
      return {
        radius,
        time: ROUND * radius,
        hue: x,
        band: bandOf(p.f),
        strength,
        gain: idle ? 0.4 : 0.4 + 0.6 * strength,
        // of the ions: a wide circle is a longer way to fill
        share: (idle ? 1 : strength + 0.08) * (0.4 + 0.6 * radius),
      };
    }),
  };
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

  // Fewer ions on small or low-powered devices; ?particles=N overrides.
  const asked = Number(new URLSearchParams(location.search).get('particles'));
  const modest = Math.min(window.innerWidth, window.innerHeight) < 700
    || (navigator.hardwareConcurrency || 4) <= 4;
  const count = asked > 0 ? Math.min(Math.floor(asked), 400000) : (modest ? 50000 : 110000);

  // Anything the GPU will not do is asked about once everything is set up,
  // so that the page can turn to another visual instead of an empty one.
  device.pushErrorScope('validation');

  const uniformData = new Float32Array(16);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const beamData = new Float32Array(MAX_BEAMS * 8);
  const beamBuffer = device.createBuffer({
    size: beamData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // What was sent into each beam over the last few seconds, as a ring.
  const sent = new Float32Array(MAX_BEAMS * SLOTS);
  const sentBuffer = device.createBuffer({
    size: sent.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const assignBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  }

  const sharedLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const showLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
  });
  // The light is added up in a picture of its own, which can hold more
  // than white, and brought onto the page from there.
  const GATHERED = 'rgba16float';
  const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const gatherLayout = device.createPipelineLayout({ bindGroupLayouts: [sharedLayout] });
  const ionPipeline = device.createRenderPipeline({
    layout: gatherLayout,
    vertex: { module, entryPoint: 'ionVertex' },
    fragment: {
      module,
      entryPoint: 'ionFragment',
      targets: [{ format: GATHERED, blend: { color: additive, alpha: additive } }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const markPipeline = device.createRenderPipeline({
    layout: gatherLayout,
    vertex: { module, entryPoint: 'markVertex' },
    fragment: {
      module,
      entryPoint: 'markFragment',
      targets: [{ format: GATHERED, blend: { color: additive, alpha: additive } }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const showPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, showLayout] }),
    vertex: { module, entryPoint: 'showVertex' },
    fragment: { module, entryPoint: 'showFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sharedGroup = device.createBindGroup({
    layout: sharedLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: beamBuffer } },
      { binding: 2, resource: { buffer: sentBuffer } },
      { binding: 3, resource: { buffer: assignBuffer } },
    ],
  });

  // ---- the beams follow the compound ----

  let shown = null; // what is in the magnet
  let waiting = null; // what goes in once the magnet is empty
  let shownKey = null;
  let shut = 0; // seconds the slit stays shut for yet
  const phase = new Float64Array(MAX_BEAMS);
  const bar = new Float32Array(MAX_BEAMS);

  function load(described) {
    shown = described;
    sent.fill(0);
    bar.fill(0);
    for (let k = 0; k < MAX_BEAMS; k++) phase[k] = Math.random();

    // Hand out ions in proportion to each beam's share. Walking the shares
    // with the golden ratio spreads every beam evenly along the buffer, so
    // drawing only the first part of it (see "active" below) thins every
    // beam instead of dropping some.
    const total = described.beams.reduce((sum, b) => sum + b.share, 0);
    const upTo = [];
    described.beams.reduce((sum, b) => {
      upTo.push((sum + b.share) / total);
      return sum + b.share;
    }, 0);
    const assignData = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const at = ((i + 0.5) * 0.6180339887498949) % 1;
      let beam = 0;
      while (beam < upTo.length - 1 && at > upTo[beam]) beam++;
      assignData[i] = beam;
    }
    device.queue.writeBuffer(assignBuffer, 0, assignData);
  }

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key === shownKey) return;
    shownKey = key;
    const described = describeBeams(compound);
    if (!shown) {
      load(described);
      return;
    }
    // The slit is shut until the last ion of the old compound has landed
    // and its lines have left the plate. A compound that arrives meanwhile
    // takes the waiting one's place.
    if (!waiting) shut = Math.max(...shown.beams.map((b) => b.time)) + 2.2;
    waiting = described;
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

  // ---- what is sent, and what lands ----

  let written = null; // the last step of the ring that has been written

  // How much was sent into a beam some seconds ago.
  function sentThen(k, slot, ago) {
    let s = (slot - ago * SLOT_RATE) % SLOTS;
    if (s < 0) s += SLOTS;
    const i = Math.floor(s) % SLOTS;
    const j = (i + 1) % SLOTS;
    return sent[k * SLOTS + i] + (sent[k * SLOTS + j] - sent[k * SLOTS + i]) * (s - Math.floor(s));
  }

  // What is sent is remembered by the clock, so the ions keep to the clock
  // too, however slowly the frames come: "passed" is the time since the
  // last frame, where "dt" is never more than a quick frame's worth.
  function send(time, dt, passed) {
    if (waiting) {
      shut -= passed;
      if (shut <= 0) {
        load(waiting);
        waiting = null;
      }
    }
    const open = waiting ? 0 : 1;
    const now = time * SLOT_RATE;
    const step = Math.floor(now);
    // Now, and the step after it, which an ion that has only just left is
    // read against. After a pause the whole ring is what is sent now.
    const from = written === null ? step : Math.max(written + 1, step + 1 - SLOTS);
    shown.beams.forEach((b, k) => {
      const sending = open * (0.3 + 1.5 * bandEnergy(b.band) + 0.7 * kick);
      for (let s = from; s <= step + 1; s++) sent[k * SLOTS + (s % SLOTS)] = sending;
      phase[k] = (phase[k] + passed / b.time) % 1;
      const lands = sentThen(k, now, b.time);
      // A line stands on the plate for as long as something lands there.
      bar[k] += ((lands > 0.02 ? 1 : 0) - bar[k]) * Math.min(1, dt * 1.6);
      beamData.set([
        b.radius, b.time, phase[k], b.hue,
        b.gain, bar[k] * (0.12 + 0.88 * b.strength), lands, 0,
      ], k * 8);
    });
    written = step + 1;
    device.queue.writeBuffer(beamBuffer, 0, beamData);
    device.queue.writeBuffer(sentBuffer, 0, sent);
    return now % SLOTS;
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let gathered = null; // the picture the light is added up in
  let showGroup = null;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the number of ions drawn comes down until they are
  // not. A slow GPU gets thinner beams, not a backlog.
  let busy = false;
  let active = count;
  let slowness = 0; // smoothed seconds per frame
  const fewest = Math.min(count, 4000);
  let shine = 0;

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const largest = device.limits.maxTextureDimension2D;
    const w = Math.min(largest, Math.max(1, Math.floor(canvas.clientWidth * ratio)));
    const h = Math.min(largest, Math.max(1, Math.floor(canvas.clientHeight * ratio)));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
      if (gathered) gathered.destroy();
      gathered = device.createTexture({
        size: [w, h],
        format: GATHERED,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      showGroup = device.createBindGroup({
        layout: showLayout,
        entries: [{ binding: 0, resource: gathered.createView() }],
      });
    }
    return ratio;
  }

  // Where the instrument stands on the canvas. A wide window has the plate
  // along its foot and the beams swing up and over to the right. A window
  // held upright has the plate up its right-hand side, clear of the words,
  // and the beams swing out to the left and upward. Returns the slit, the
  // two directions and the size of a radius, in pixels from the top left.
  function stand(ratio) {
    const css = (n) => n * ratio;
    const reach = 1.13; // the widest beam's furthest from the plate
    if (width >= height) {
      const bars = 0.26;
      const top = css(84);
      const foot = css(36);
      const unit = Math.min((0.9 * width) / 2.14, (height - top - foot) / (reach + bars));
      const plate = top + (height - top - foot - (reach + bars) * unit) / 2 + reach * unit;
      let left = (width - 2.14 * unit) / 2;
      // In a low window the plate comes down beside the words at the foot
      // of the page, and the instrument stands to the right of them if
      // there is room.
      if (plate > height - css(110)) {
        left = Math.max(left, Math.min(css(372), width - 2.14 * unit - css(12)));
      }
      return { slit: [left + 0.07 * unit, plate], along: [unit, 0], away: [0, -unit], unit, bars };
    }
    const bars = 0.2;
    const side = css(10);
    const top = css(150);
    // On a phone the words at the foot of the page are five lines tall,
    // and the slit, the brightest place, would lie on top of them.
    const foot = css(width <= css(640) ? 160 : 84);
    const unit = Math.min((width - 2 * side) / (reach + bars), (height - top - foot) / 2.14);
    const plate = width - side - bars * unit - (width - 2 * side - (reach + bars) * unit) / 2;
    const slit = height - foot - (height - top - foot - 2.14 * unit) / 2 - 0.07 * unit;
    return { slit: [plate, slit], along: [0, -unit], away: [-unit, 0], unit, bars };
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
    const ratio = fit();
    listen(time, dt);
    const slot = send(time, dt, Math.min(Math.max(real, 0), 1));
    shine += ((shown.idle ? 0.6 : 1) - shine) * Math.min(1, dt * 0.8);

    const at = stand(ratio);
    const toClip = (v) => [(2 * v[0]) / width, (-2 * v[1]) / height];
    const long = Math.min(11, Math.max(4.5, 0.02 * at.unit));
    const wide = Math.min(2.6, Math.max(1.3, 0.0045 * at.unit));
    // The fewer ions, the smaller they are drawn or the further apart they
    // lie, the brighter each has to be for the beams to be as bright.
    const glow = 4.5 * shine * (at.unit * at.unit) / (active * long * wide);
    uniformData.set([
      (2 * at.slit[0]) / width - 1, 1 - (2 * at.slit[1]) / height,
      ...toClip(at.along),
      ...toClip(at.away),
      2 / width, 2 / height,
      slot, shown.spread, glow, long,
      wide, shown.beams.length, at.bars, 0.09 * shine,
    ], 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const gather = encoder.beginRenderPass({
      colorAttachments: [{
        view: gathered.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    gather.setBindGroup(0, sharedGroup);
    gather.setPipeline(ionPipeline);
    gather.draw(6, active);
    gather.setPipeline(markPipeline);
    gather.draw(6, 2 * MAX_BEAMS + 1);
    gather.end();

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
