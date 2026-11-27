// "bloom": GPU particle rings (WebGPU).
//
// Each voiced peak is a ring: frequency sets radius and colour, strength
// sets particle count, and audio energy near the peak makes it swell. With
// no compound the particles spread out evenly.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. Throws if WebGPU is unavailable; the page then falls
// back to "rings".

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_RINGS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

const SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  dt: f32,
  ringCount: f32,
  aspect: f32,
  size: f32,
  level: f32,
  kick: f32,
  glow: f32,
  bands: array<vec4f, 2>,
};

struct Particle {
  pos: vec3f,
  seed: f32,
  vel: vec3f,
  seed2: f32,
};

struct Ring {
  radius: f32,
  tiltX: f32,
  tiltZ: f32,
  band: f32,
  speed: f32,
  thickness: f32,
  hue: f32,
  gain: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> assign: array<u32>;
@group(0) @binding(2) var<storage, read> rings: array<Ring>;

fn hash(x: f32) -> f32 {
  return fract(sin(x * 127.1 + 0.3) * 43758.5453);
}

// Energy of the stream around a ring's pitch: 0 is the lowest band, 1 the highest.
fn bandEnergy(b: f32) -> f32 {
  let x = clamp(b, 0.0, 1.0) * 7.0;
  let i = u32(floor(x));
  let j = min(i + 1u, 7u);
  let lo = u.bands[i / 4u][i % 4u];
  let hi = u.bands[j / 4u][j % 4u];
  return mix(lo, hi, fract(x));
}

fn rotX(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

fn rotZ(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

// Two octaves of ABC flow: a swirling field with no sources or sinks, so it
// stirs the particles without bunching them up.
fn flow(p: vec3f, t: f32) -> vec3f {
  let a = p * 1.7 + vec3f(0.0, t * 0.11, t * 0.07);
  let b = p * 3.9 + vec3f(t * 0.13, 0.0, -t * 0.09);
  return vec3f(sin(a.z) + cos(a.y), sin(a.x) + cos(a.z), sin(a.y) + cos(a.x))
    + 0.5 * vec3f(sin(b.z) + cos(b.y), sin(b.x) + cos(b.z), sin(b.y) + cos(b.x));
}

// ---- simulation ------------------------------------------------------------

@group(1) @binding(0) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&particles)) {
    return;
  }
  var p = particles[i];
  let r = rings[assign[i]];
  let e = bandEnergy(r.band);

  // Where this particle wants to be: a point travelling round its ring,
  // inside a tube that widens with the ring's band.
  let angle = p.seed * 6.2831853 + u.time * r.speed * (0.55 + 0.9 * hash(p.seed2));
  let tube = r.thickness * (1.0 + 2.5 * e);
  let off = vec2f(hash(p.seed * 3.1 + 0.17) - 0.5, hash(p.seed2 * 5.3 + 0.71) - 0.5) * 2.0 * tube;
  var goal = vec3f(cos(angle) * (r.radius + off.x), off.y, sin(angle) * (r.radius + off.x));
  goal = rotZ(rotX(goal, r.tiltX), r.tiltZ) * (1.0 + 0.10 * e + 0.05 * u.level);

  var acc = (goal - p.pos) * 3.0;
  acc += flow(p.pos, u.time) * (0.10 + 0.9 * e + 0.25 * u.level);
  acc += (p.pos / max(length(p.pos), 0.001)) * u.kick * 5.0;

  p.vel = (p.vel + acc * u.dt) * exp(-2.2 * u.dt);
  p.pos += p.vel * u.dt;
  particles[i] = p;
}

// ---- drawing ---------------------------------------------------------------

@group(1) @binding(1) var<storage, read> drawn: array<Particle>;

struct Sprite {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};

// Warm for the lowest peaks, through green, to blue for the highest: the
// same order as the bars of the rings visual.
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
  let p = drawn[ii];
  let r = rings[assign[ii]];
  let e = bandEnergy(r.band);
  let corner = corners[vi];
  let clip = u.viewProj * vec4f(p.pos, 1.0);
  let size = u.size * (0.6 + 0.8 * hash(p.seed2 * 9.7)) * (1.0 + 1.2 * e);

  var out: Sprite;
  out.pos = clip + vec4f(corner * size * vec2f(1.0 / u.aspect, 1.0), 0.0, 0.0);
  out.uv = corner;
  out.color = palette(r.hue) * r.gain * u.glow
    * (0.4 + 1.3 * e + 0.5 * min(length(p.vel), 1.5));
  return out;
}

@fragment
fn drawFragment(sprite: Sprite) -> @location(0) vec4f {
  let d = dot(sprite.uv, sprite.uv);
  let a = exp(-d * 3.5) * step(d, 1.0);
  return vec4f(sprite.color * a, a);
}
`;

// ---- small matrix helpers (column-major, WebGPU clip space) -------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ];
}

function lookAt(eye, center) {
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

// ---- rings from a compound ---------------------------------------------------

// Position of a frequency on the analyser's band axis, 0..1.
function bandOf(hz) {
  return Math.min(1, Math.max(0, Math.log(hz / LOW_HZ) / Math.log(SPAN)));
}

// The peaks the station voices: at most MAX_RINGS, strongest first, none
// more than 40 dB below the strongest. Same rule as piece.scd.
function voicedPeaks(compound) {
  const freqs = (compound && compound.frequencies) || [];
  const amps = (compound && compound.amplitudes) || [];
  let peaks = freqs.map((f, i) => ({ f, a: amps[i] })).filter((p) => p.f > 0 && p.a >= 0);
  const top = Math.max(0, ...peaks.map((p) => p.a));
  if (!peaks.length || top <= 0) return null;
  peaks = peaks.filter((p) => p.a >= top * PEAK_FLOOR);
  if (peaks.length > MAX_RINGS) {
    peaks = peaks.sort((p, q) => q.a - p.a).slice(0, MAX_RINGS);
  }
  return peaks.sort((p, q) => p.f - q.f).map((p) => ({ f: p.f, a: p.a / top }));
}

// With no compound: twelve loose rings spread evenly over the audible range.
function idlePeaks() {
  return Array.from({ length: 12 }, (_, k) => ({ f: 80 * Math.pow(75, k / 11), a: 1, idle: true }));
}

function describeRings(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  // A compound with only a few peaks gets fuller rings, so the same number
  // of particles is not crowded into a few thin lines.
  const fuller = Math.min(2, Math.max(1, Math.sqrt(12 / peaks.length)));
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  return peaks.map((p, k) => {
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    const radius = 0.55 + 1.35 * x;
    const strength = Math.sqrt(p.a);
    return {
      radius,
      tiltX: 1.15 * Math.sin(k * 2.399963 + 0.5),
      tiltZ: 1.15 * Math.cos(k * 3.236068 + 1.1),
      band: bandOf(p.f),
      speed: (k % 2 ? -1 : 1) * 0.35 / Math.sqrt(radius),
      thickness: p.idle ? 0.16 : (0.03 + 0.05 * strength) * fuller,
      hue: x,
      gain: p.idle ? 0.7 : 0.45 + 0.55 * strength,
      share: p.idle ? 1 : strength + 0.08, // of the particles
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

  // Fewer particles on small or low-powered devices; ?particles=N overrides.
  const asked = Number(new URLSearchParams(location.search).get('particles'));
  const modest = Math.min(window.innerWidth, window.innerHeight) < 700
    || (navigator.hardwareConcurrency || 4) <= 4;
  const count = asked > 0 ? Math.min(Math.floor(asked), 400000) : (modest ? 60000 : 140000);

  // Particles start scattered in a ball and are pulled into place.
  const particleData = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const r = 1.6 * Math.cbrt(Math.random());
    const theta = Math.random() * Math.PI * 2;
    const z = Math.random() * 2 - 1;
    const s = Math.sqrt(1 - z * z);
    particleData.set([r * s * Math.cos(theta), r * z, r * s * Math.sin(theta), Math.random(), 0, 0, 0, Math.random()], i * 8);
  }
  const particleBuffer = device.createBuffer({
    size: particleData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(particleBuffer, 0, particleData);

  const assignBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const ringBuffer = device.createBuffer({
    size: MAX_RINGS * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new Float32Array(32);
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
      { binding: 2, resource: { buffer: ringBuffer } },
    ],
  });
  const simulateGroup = device.createBindGroup({
    layout: simulateLayout,
    entries: [{ binding: 0, resource: { buffer: particleBuffer } }],
  });
  const drawGroup = device.createBindGroup({
    layout: drawLayout,
    entries: [{ binding: 1, resource: { buffer: particleBuffer } }],
  });

  // ---- rings follow the compound ----

  let ringCount = 0;
  let shownKey = null;

  function applyCompound(compound) {
    const described = describeRings(compound);
    ringCount = described.length;
    const ringData = new Float32Array(MAX_RINGS * 8);
    described.forEach((r, k) => {
      ringData.set([r.radius, r.tiltX, r.tiltZ, r.band, r.speed, r.thickness, r.hue, r.gain], k * 8);
    });
    device.queue.writeBuffer(ringBuffer, 0, ringData);

    // Hand out particles in proportion to each ring's share. Walking the
    // shares with the golden ratio spreads every ring evenly along the
    // buffer, so drawing only the first part of it (see "active" below)
    // thins every ring instead of dropping some.
    const total = described.reduce((sum, r) => sum + r.share, 0);
    const upTo = [];
    described.reduce((sum, r) => {
      upTo.push((sum + r.share) / total);
      return sum + r.share;
    }, 0);
    const assignData = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const at = ((i + 0.5) * 0.6180339887498949) % 1;
      let ring = 0;
      while (ring < upTo.length - 1 && at > upTo[ring]) ring++;
      assignData[i] = ring;
    }
    device.queue.writeBuffer(assignBuffer, 0, assignData);
  }

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
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
      // player gives silence): keep the cloud breathing by itself.
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

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the number of particles simulated and drawn comes
  // down until they are not. A slow GPU gets a thinner cloud, not a backlog.
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

    // The camera drifts round the cloud, as it did round the rings.
    const orbit = time * 0.09;
    const lift = Math.sin(time * 0.055) * 0.65;
    const eye = [
      Math.sin(orbit) * 5.2 * Math.cos(lift), Math.sin(lift) * 5.2, Math.cos(orbit) * 5.2 * Math.cos(lift),
    ];
    const aspect = width / height;
    uniformData.set(multiply(perspective((50 * Math.PI) / 180, aspect, 0.1, 100), lookAt(eye, [0, 0, 0])), 0);
    uniformData[16] = time;
    uniformData[17] = dt;
    uniformData[18] = ringCount;
    uniformData[19] = aspect;
    uniformData[20] = 0.022; // sprite size
    uniformData[21] = level;
    uniformData[22] = kick;
    uniformData[23] = 0.4 * Math.sqrt(60000 / active); // per-particle glow: fewer particles, each brighter
    uniformData.set(bands, 24);
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
