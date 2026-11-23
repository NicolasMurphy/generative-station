// "trace": the compound as the line a pen draws (WebGPU).
//
// A harmonograph is a pen hung from pendulums: each swings at its own rate,
// the pen goes where all of them together take it, and the line it leaves
// is a figure of how their rates stand to one another. Here every voiced
// peak of the current compound's mass spectrum is a pendulum. A peak's
// frequency sets how many times it swings while the pen goes once round, a
// higher peak more often, and its intensity sets how far it swings.
//
// The swings are whole numbers to a round, so one round of the pen all but
// closes. But a peak is never exactly on its whole number, and by as much
// as it is off, its pendulum runs ahead or falls behind from one round to
// the next. So each round is drawn a little way from the last, the rounds
// lie beside one another like the grain in wood, and the figure turns
// slowly into another and never comes back. The line fades as it ages, so
// what is seen is the last few dozen rounds, a few minutes of the pen.
//
// The line is warm where it sweeps wide and blue where it turns tightly,
// which is where the low and the high peaks have the pen: the same order
// of colours as in the other visuals. It is brightest where the pen is
// slowest, as a moving light is.
//
// Where the page can hear the stream, a pendulum swings wider while there
// is energy around its peak, so the whole figure swells with the sound,
// and a kick lights the line. Where it cannot (iOS gives a page no sound
// to look at for a live stream) a slow swell of its own does the same, as
// in "bloom". A new compound lifts the pen: the old figure fades and the
// new one is drawn, quickly at first.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const MOST_SWINGS = 24; // of the fastest pendulum, in one round of the pen
const ROUND = 2 * Math.PI;
const ROOM = 0.8; // of half the window's shorter side, for most of the figure
const FOV = (50 * Math.PI) / 180;

const SHADER = /* wgsl */ `
struct Pendulum {
  // swings to a round, where its swing has got to at the pen, how far it
  // swings just now, and how round its swing is (a line at 0, a circle at
  // 1, the other way round below 0)
  a: vec4f,
  // which way its swing lies (cosine and sine), and how far it swings
  // towards the eye, in step with the swing and a quarter ahead of it
  b: vec4f,
};

struct Uniforms {
  viewProj: mat4x4f,
  view: vec2f,     // the canvas, in pixels
  count: f32,      // points along the line
  span: f32,       // how far back the line goes, in radians of the pen's round
  peakCount: f32,
  width: f32,      // half the line's width with its glow, in pixels
  core: f32,       // the line itself, in pixels
  scale: f32,
  lowTurn: f32,    // the slowest and the fastest turning there is
  highTurn: f32,
  light: f32,
  aged: f32,       // how much of the whole span the line has been given so far
  pendulums: array<Pendulum, ${MAX_PEAKS}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// Warm for the lowest, through green, to blue for the highest: the same
// order as in the other visuals.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

struct Stroke {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) color: vec3f,
};

@vertex
fn drawVertex(@builtin(vertex_index) vi: u32) -> Stroke {
  // The line is one long strip: two corners to a point, one on each side.
  let side = f32(vi & 1u) * 2.0 - 1.0;
  let along = f32(vi >> 1u) / (u.count - 1.0); // 0 at the oldest end, 1 at the pen
  let back = (along - 1.0) * u.span;

  // Where the pen was, how fast it was going and how it was turning: the
  // pendulums' swings added up, and their first and second rates of change.
  var p = vec3f(0.0);
  var v = vec3f(0.0);
  var a = vec3f(0.0);
  let n = u32(u.peakCount);
  for (var k = 0u; k < n; k++) {
    let q = u.pendulums[k];
    let rate = q.a.x;
    let at = q.a.y + rate * back;
    let c = cos(at);
    let s = sin(at);
    // an ellipse, turned to lie its own way
    let e = vec2f(c, q.a.w * s);
    let de = vec2f(-s, q.a.w * c);
    let here = vec3f(q.b.x * e.x - q.b.y * e.y, q.b.y * e.x + q.b.x * e.y, q.b.z * s + q.b.w * c);
    let going = vec3f(q.b.x * de.x - q.b.y * de.y, q.b.y * de.x + q.b.x * de.y, q.b.z * c - q.b.w * s);
    p += q.a.z * here;
    v += q.a.z * rate * going;
    a -= q.a.z * rate * rate * here;
  }
  p *= u.scale;
  v *= u.scale;
  a *= u.scale;

  let speed = max(length(v), 1e-5);
  // how fast the line is turning: radians of its direction to a radian of the round
  let turning = length(cross(v, a)) / (speed * speed);

  let clip = u.viewProj * vec4f(p, 1.0);
  let ahead = u.viewProj * vec4f(p + v / speed * 0.01, 1.0);
  var dir = (ahead.xy / ahead.w - clip.xy / clip.w) * u.view;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / max(len, 1e-6), len > 1e-6);
  let normal = vec2f(-dir.y, dir.x);

  var out: Stroke;
  out.pos = vec4f(clip.xy + normal * side * u.width * 2.0 / u.view * clip.w, clip.z, clip.w);
  out.across = side;

  // The line fades towards its older end, and has not been given all of
  // its length while a figure is new.
  let age = (1.0 - along) / max(u.aged, 1e-4);
  let fade = (1.0 - smoothstep(0.55, 1.0, age)) * (0.3 + 0.7 * (1.0 - min(age, 1.0)));
  let pen = exp(-(1.0 - along) * u.count / 18.0);
  // Brightest where the pen is slowest.
  let slow = clamp(pow(u.lowTurn * 1.5 / speed * u.scale, 0.6), 0.35, 1.7);
  let hue = log(max(turning, u.lowTurn) / u.lowTurn) / log(u.highTurn / u.lowTurn);
  let near = 1.0 + 0.35 * p.z;
  out.color = (palette(hue) * fade * slow + vec3f(1.0, 0.95, 0.85) * pen * 2.5) * u.light * near;
  return out;
}

@fragment
fn drawFragment(stroke: Stroke) -> @location(0) vec4f {
  let d = abs(stroke.across) * u.width; // pixels from the middle of the line
  let line = exp(-(d * d) / (u.core * u.core));
  let glow = 0.16 * exp(-(d * d) / (0.16 * u.width * u.width));
  return vec4f(stroke.color * (line + glow), 1.0);
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
  let c = textureLoad(gathered, vec2i(at.xy), 0).rgb;
  // Where many lines cross the light adds up, towards white and not past it.
  let lit = 1.0 - exp(-c);
  let page = vec3f(0.0667); // the page's #111
  return vec4f(page + (1.0 - page) * lit, 1.0);
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

function lookAt(eye, center, up) {
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm(cross(up, z));
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

// ---- pendulums from a compound -------------------------------------------------

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

// With no compound: three pendulums, a plain figure that turns slowly.
function idlePeaks() {
  return [{ f: 200, a: 1 }, { f: 304, a: 0.6 }, { f: 507, a: 0.3 }];
}

function describePendulums(compound) {
  const voiced = voicedPeaks(compound);
  const peaks = voiced || idlePeaks();
  const lowest = peaks[0].f;
  const widest = peaks[peaks.length - 1].f / lowest;
  // The lowest peak swings a few times to a round where there is room for
  // it, so that peaks which lie close together still differ by whole
  // swings. Where the peaks lie further apart than the fastest pendulum
  // may swing, the distances between them are drawn in.
  const least = Math.max(1, Math.min(4, Math.floor(MOST_SWINGS / widest)));
  const squeeze = widest * least > MOST_SWINGS
    ? Math.log(MOST_SWINGS / least) / Math.log(widest)
    : 1;
  const pendulums = peaks.map((p, k) => {
    const exact = least * Math.pow(p.f / lowest, squeeze);
    const swings = Math.max(1, Math.round(exact));
    return {
      swings,
      off: exact - swings, // how far the peak is from its whole number
      // A wide swing for a strong peak, and a narrower one the faster the
      // pendulum, as a pendulum of the same energy has.
      reach: Math.sqrt(p.a) / Math.pow(swings / least, 0.7),
      band: bandOf(p.f),
      lies: k * 2.399963 + 0.4,
      round: Math.sin(k * 1.9 + 0.9),
      deep: 0.55 * Math.cos(k * 1.3 + 0.2),
      lead: k * 2.1,
      start: k * 4.1,
    };
  });
  return { pendulums, least, idle: !voiced };
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

  // A shorter line on small or low-powered devices.
  const modest = Math.min(window.innerWidth, window.innerHeight) < 700
    || (navigator.hardwareConcurrency || 4) <= 4;
  const ROUNDS = modest ? 28 : 40; // of the pen, before the line has faded
  const TO_A_ROUND = modest ? 360 : 420; // points

  const uniformData = new Float32Array(28 + MAX_PEAKS * 8);
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
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const showLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }],
  });
  // The line is drawn into a picture that can hold more light than a
  // screen shows, and that picture is then brought onto the page.
  const GATHERED = 'rgba16float';
  const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout] }),
    vertex: { module, entryPoint: 'drawVertex' },
    fragment: {
      module,
      entryPoint: 'drawFragment',
      targets: [{ format: GATHERED, blend: { color: additive, alpha: additive } }],
    },
    primitive: { topology: 'triangle-strip' },
  });
  const showPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, showLayout] }),
    vertex: { module, entryPoint: 'showVertex' },
    fragment: { module, entryPoint: 'showFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sharedGroup = device.createBindGroup({
    layout: sharedLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // ---- the pendulums follow the compound ----

  let figure = null; // the pendulums now drawing
  let waiting = null; // a new compound's, until the old figure has faded
  let shownKey = null;
  let pen = 0; // how far the pen has gone round, in radians, on this figure
  let since = 0; // seconds this figure has been drawn for
  let light = 0;

  function takeUp(described) {
    figure = described;
    pen = 0;
    since = 0;
    // The widest the figure gets, so that it fits the window: walked once
    // round, with every pendulum where it starts and where it will be.
    const radii = [];
    for (let lap = 0; lap < 6; lap++) {
      for (let i = 0; i < 720; i++) {
        const turn = (i / 720) * ROUND;
        let x = 0;
        let y = 0;
        for (const q of figure.pendulums) {
          const at = q.start + q.swings * turn + q.off * lap * 1.3;
          const c = Math.cos(at);
          const s = q.round * Math.sin(at);
          x += q.reach * (Math.cos(q.lies) * c - Math.sin(q.lies) * s);
          y += q.reach * (Math.sin(q.lies) * c + Math.cos(q.lies) * s);
        }
        radii.push(Math.hypot(x, y));
      }
    }
    radii.sort((p, q) => p - q);
    // Most of the figure is given the same room whatever its shape, and a
    // lobe that reaches far out of the rest is still kept in the window.
    const most = radii[Math.floor(radii.length * 0.9)];
    figure.scale = 1 / Math.max(most, 0.85 * radii[radii.length - 1], 1e-3);
    // A pendulum runs ahead of its whole number, or behind it, by a small
    // part of what its peak is off by. How small is the same for all of a
    // compound's pendulums, and chosen so that a round is drawn close
    // beside the last and not on top of it: a few pixels away.
    const least = Math.min(canvas.clientWidth, canvas.clientHeight) || 600;
    const apart = Math.hypot(...figure.pendulums.map((q) => q.reach * figure.scale * q.off * ROUND));
    const wanted = Math.min(5, Math.max(2.6, least / 170)) / (least / 2 * ROOM);
    figure.drift = Math.min(0.15, Math.max(0.005, wanted / Math.max(apart, 1e-6)));
    const swings = figure.pendulums.map((q) => q.swings);
    figure.lowTurn = Math.max(1, Math.min(...swings));
    figure.highTurn = Math.max(figure.lowTurn * 2, Math.max(...swings) * 1.5);
  }

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      shownKey = key;
      const described = describePendulums(compound);
      if (figure) waiting = described; // the pen is lifted first
      else takeUp(described);
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

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let gathered = null; // the picture the line is drawn into
  let showGroup = null;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the line is drawn shorter until they are not. A
  // slow GPU gets fewer rounds of the pen, not a backlog.
  let busy = false;
  let rounds = ROUNDS;
  let slowness = 0; // smoothed seconds per frame

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
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
      if (slowness > 0.045 && rounds > 6) {
        rounds = Math.max(6, Math.floor(rounds * 0.8));
        slowness = 0.03;
      } else if (slowness < 0.02 && rounds < ROUNDS) {
        rounds += 1;
      }
    }
    const ratio = fit();
    listen(time, dt);

    // A new compound: the old figure fades, and the pen starts again.
    if (waiting) {
      light -= dt / 0.7;
      if (light <= 0) {
        light = 0;
        takeUp(waiting);
        waiting = null;
      }
    } else {
      light = Math.min(1, light + dt / 1.0);
    }

    // The pen goes once round in four seconds, a little faster in loud
    // passages, and much faster while a figure is new, so that there is
    // soon something of it to see.
    since += dt;
    pen += dt * (ROUND / 4) * (0.85 + 0.6 * level) * (1 + 9 * Math.exp(-since / 5));
    const span = rounds * ROUND;
    const aged = Math.min(1, pen / span);

    // The eye sways in front of the figure, and the figure turns slowly
    // where it lies.
    const sway = 0.5 * Math.sin(time * 0.05);
    const nod = 0.42 * Math.sin(time * 0.037 + 1.0);
    const aspect = width / height;
    const far = 1 / (ROOM * Math.tan(FOV / 2) * Math.min(1, aspect));
    const eye = [
      Math.sin(sway) * Math.cos(nod) * far, Math.sin(nod) * far, Math.cos(sway) * Math.cos(nod) * far,
    ];
    const roll = time * 0.012;
    uniformData.set(multiply(
      perspective(FOV, aspect, 0.1, 100),
      lookAt(eye, [0, 0, 0], [Math.sin(roll), Math.cos(roll), 0]),
    ), 0);
    const points = rounds * TO_A_ROUND;
    uniformData.set([
      width, height, points, span,
      figure.pendulums.length, (5 + 3 * kick) * ratio, 0.85 * ratio, figure.scale,
      figure.lowTurn, figure.highTurn,
      light * (figure.idle ? 0.45 : 0.7) * (0.75 + 0.9 * level + 0.4 * kick), aged,
    ], 16);
    figure.pendulums.forEach((q, k) => {
      const rate = q.swings + figure.drift * q.off;
      // It swings wider while the stream has energy around its peak.
      const reach = q.reach * (0.8 + 0.7 * bandEnergy(q.band));
      uniformData.set([
        rate, (q.start + rate * pen) % ROUND, reach, q.round,
        Math.cos(q.lies), Math.sin(q.lies), q.deep * Math.cos(q.lead), q.deep * Math.sin(q.lead),
      ], 28 + k * 8);
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const draw = encoder.beginRenderPass({
      colorAttachments: [{
        view: gathered.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    draw.setPipeline(drawPipeline);
    draw.setBindGroup(0, sharedGroup);
    draw.draw(2 * points);
    draw.end();

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
  requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      clearInterval(followTimer);
      device.destroy();
    },
  };
}
