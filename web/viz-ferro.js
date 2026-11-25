// "ferro": the compound as a dish of ferrofluid over magnets (WebGPU).
//
// A ferrofluid is an oil so full of iron that a magnet can hold it. Over a
// weak magnet it only gathers into a low mound. Over one that is strong
// enough the flat surface gives way and the fluid stands up in spikes,
// every spike as far from its neighbours as the next, because that spacing
// is settled between the weight of the fluid and its skin and not by the
// magnet. The magnet decides only where the spikes stand and how tall.
//
// Here every voiced peak of the compound is a magnet under the dish: low
// peaks at the left to high peaks at the right, a wider magnet the
// stronger the peak. The fluid is black and shows nothing of itself, only
// what it mirrors: a lamp overhead, which the tips find, two tall lamps
// on the near side, which the flanks find, and round the dish a glow in
// the colour of the peak beneath, warm for the low peaks through green to
// blue for the high as in the other visuals, which the edges of the
// spikes find. So a crown of spikes is one peak, and its colour says
// which.
//
// The dish is seen from the front and above, all of it where the screen
// is wide. Where the screen is tall that would be a sliver across the
// middle, so there the dish is as deep as the screen has room for, its
// sides are out of sight, and the magnets keep to the part that is seen.
//
// Where the page can hear the stream, a magnet is driven harder while
// there is energy around its peak, and the fluid, which has weight,
// follows a moment later and overshoots: a peak that is only a mound in a
// quiet passage puts out spikes when its pitch sounds, and a kick lifts
// every crown at once. Where the page cannot hear (iOS gives a page no
// sound to look at for a live stream) the magnets swell slowly by
// themselves, as in "bloom". A new compound lets the fluid fall flat, and
// its magnets take it up again.
//
// Nothing is simulated on a grid: the surface is worked out where it is
// drawn, on a mesh laid so that every spike's tip is one of its corners.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_MAGNETS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

// The dish has a radius of 1.
const LAMBDA = 0.11; // from one spike to the next
const STEPS = 12; // mesh steps from one spike to the next
const SHARP = 5.2; // how fast a spike falls away from its tip
const TIP = 0.13; // how round the tip is
const CRITICAL = 0.36; // the field at which the flat surface gives way
const RIM_OUT = 1.05; // the outside of the dish's glass rim

// A spike is the sum of what its own place and the places round it put
// there. What that comes to at a tip, and in the hollow between three
// spikes, is worked out once so that the shader can count from the hollow.
function spikeSum(x, y) {
  let sum = 0;
  for (let j = -3; j <= 3; j++) {
    for (let i = -3; i <= 3; i++) {
      const sx = i + 0.5 * j;
      const sy = j * 0.8660254;
      const q = Math.sqrt((x - sx) * (x - sx) + (y - sy) * (y - sy) + TIP * TIP);
      sum += Math.exp(-SHARP * (q - TIP));
    }
  }
  return sum;
}
const HOLLOW = spikeSum(0.5, 0.2886751);
const CREST = spikeSum(0, 0) - HOLLOW;

const SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  eye: vec3f,
  count: f32,
  // two to a magnet: (x, y, 1 / radius squared, field) and (hue, -, -, -)
  magnets: array<vec4f, ${2 * MAX_MAGNETS}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

const LAMBDA = ${LAMBDA};
const SHARP = ${SHARP};
const TIP = ${TIP};
const HOLLOW = ${HOLLOW};
const CREST = ${CREST};
const CRITICAL = ${CRITICAL};
const RIM_OUT = ${RIM_OUT};
const RIM_MID = ${(0.994 + RIM_OUT) / 2};
const RIM_HALF = ${(RIM_OUT - 0.994) / 2};
const RIM_TOP = 0.045;
const TALL = 0.25;    // a spike's height for each unit of field above critical
const MOUND = 0.03;  // the fluid a magnet gathers before it stands up
const LEAN = 0.07;    // how far the spikes follow the field outwards
const MENISCUS = 0.014;

// Warm for the lowest peaks, through green, to blue for the highest: the
// same order as in the other visuals.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

// The pattern the spikes stand in: 0 in the hollow between three of them,
// 1 at a tip, and which way is up it (x, y of the slope).
fn spikes(p: vec2f) -> vec3f {
  let row = p.y / (LAMBDA * 0.8660254);
  let near = round(vec2f(p.x / LAMBDA - 0.5 * row, row));
  var sum = 0.0;
  var slope = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = near + vec2f(f32(i), f32(j));
      let d = p / LAMBDA - vec2f(c.x + 0.5 * c.y, c.y * 0.8660254);
      let q = sqrt(dot(d, d) + TIP * TIP);
      let f = exp(-SHARP * (q - TIP));
      sum += f;
      slope -= SHARP * f * d / (q * LAMBDA);
    }
  }
  return vec3f((sum - HOLLOW) / CREST, slope / CREST);
}

// How tall the spikes stand in a field, and how fast that grows with it.
// The surface gives way smoothly, not at a line.
fn stand(field: f32) -> vec2f {
  let x = field - CRITICAL;
  let root = sqrt(x * x + 0.0006);
  let over = 0.5 * (x + root);
  let dOver = 0.5 * (1.0 + x / root);
  let soft = 1.0 + 0.28 * over;
  return vec2f(TALL * over / soft, TALL * dOver / (soft * soft));
}

// The dish's rim is a bead of glass, and the fluid climbs a little way up
// the inside of it: how high each stands at a distance from the middle.
fn bead(r: f32) -> f32 {
  let across = (r - RIM_MID) / RIM_HALF;
  return RIM_TOP * sqrt(max(0.0, 1.0 - across * across));
}

fn climb(r: f32) -> f32 {
  return MENISCUS * exp((min(r, 1.0) - 1.0) / 0.03);
}

// Which way the spikes lean: along the field, outwards from a magnet.
fn lean(grad: vec2f) -> vec2f {
  let g = length(grad) * LEAN;
  return -grad * LEAN / sqrt(1.0 + g * g / 0.2);
}

struct Surface {
  @builtin(position) pos: vec4f,
  @location(0) place: vec2f,  // where in the dish, before the spikes lean
  @location(1) world: vec3f,
  @location(2) field: vec3f,  // the field and its slope
  @location(3) tint: vec3f,   // the colour of the peak beneath
};

@vertex
fn surfaceVertex(@location(0) p: vec2f) -> Surface {
  var out: Surface;
  let r = length(p);
  var field = 0.0;
  var grad = vec2f(0.0);
  var tint = vec3f(0.0);
  var weight = 0.0001;
  let n = u32(u.count);
  for (var k = 0u; k < n; k++) {
    let m = u.magnets[2u * k];
    let d = p - m.xy;
    let g = exp(-dot(d, d) * m.z);
    field += m.w * g;
    grad -= 2.0 * m.w * g * m.z * d;
    let w = (m.w + 0.04) * g;
    tint += w * palette(u.magnets[2u * k + 1u].x);
    weight += w;
  }
  // No magnet reaches the wall of the dish.
  let inside = 1.0 - smoothstep(0.84, 0.985, r);
  let t = clamp((r - 0.84) / 0.145, 0.0, 1.0);
  let dInside = -6.0 * t * (1.0 - t) / 0.145;
  grad = grad * inside + field * dInside * p / max(r, 0.001);
  field *= inside;

  let s = spikes(p);
  let a = stand(field);
  let spike = a.x * s.x;
  let z = max(MOUND * field + spike + climb(r), bead(r));
  let aside = lean(grad) * spike;
  out.place = p;
  out.world = vec3f(p + aside, z);
  out.field = vec3f(field, grad);
  out.tint = tint / weight;
  out.pos = u.viewProj * vec4f(out.world, 1.0);
  return out;
}

const KEY = vec3f(-0.1487, -0.1983, 0.9688); // the lamp overhead, a little to this side

// A tall lamp standing beside the dish: how much of it lies in a direction.
fn standing(d: vec3f, towards: vec2f, half: f32, foot: f32, head: f32) -> f32 {
  let level = normalize(d.xy + vec2f(0.00001, 0.0));
  let off = acos(clamp(dot(level, towards), -1.0, 1.0));
  return (1.0 - smoothstep(0.6 * half, half, off)) * smoothstep(foot, foot + 0.08, d.z) * (1.0 - smoothstep(head - 0.12, head, d.z));
}

// What the fluid mirrors in a given direction: it has no colour of its own.
fn room(d: vec3f, tint: vec3f) -> vec3f {
  let above = smoothstep(-0.06, 0.08, d.z);
  // a soft lamp overhead, which the tips and the feet of the spikes find
  let key = 5.0 * smoothstep(0.94, 0.985, dot(d, KEY));
  // two tall lamps on the near side, which their flanks find
  let left = 3.0 * standing(d, vec2f(-0.6, -0.8), 0.26, 0.06, 0.85);
  let right = 2.2 * standing(d, vec2f(0.8, -0.6), 0.11, 0.1, 0.75);
  // a pale wall beyond the dish, which the flat of the fluid finds
  let wall = 0.22 * smoothstep(-0.2, 0.6, d.y) * smoothstep(0.25, 0.5, d.z) * (1.0 - smoothstep(0.6, 0.9, d.z));
  // the glow round the dish, in the colour of the peak beneath
  let low = (d.z - 0.1) / 0.22;
  let glow = 2.8 * exp(-low * low);
  let dim = 0.03 + 0.05 * max(d.z, 0.0);
  return above * (vec3f(key + left + right + wall + dim) + tint * glow) + (1.0 - above) * tint * 0.06;
}

@fragment
fn surfaceFragment(in: Surface) -> @location(0) vec4f {
  let r = length(in.place);
  if (r > RIM_OUT) {
    discard;
  }
  let view = normalize(u.eye - in.world);
  var normal = vec3f(0.0, 0.0, 1.0);
  var mirror = 0.13; // how much is mirrored looking straight at it
  var open = 1.0;    // how much of the room this place can see
  var own = vec3f(0.006, 0.006, 0.008);
  if (bead(r) <= climb(r)) {
    let field = in.field.x;
    let grad = in.field.yz;
    let s = spikes(in.place);
    let a = stand(field);
    let wall = climb(r) / 0.03 * step(r, 1.0);
    let slope = (MOUND + a.y * s.x) * grad + a.x * s.yz + wall * in.place / max(r, 0.001);
    let up = vec3f(-slope, 1.0);
    // the spikes lean, and what they mirror leans with them
    normal = normalize(vec3f(up.xy, up.z - dot(lean(grad), up.xy)));
    // Deep between tall spikes little of the room is left to mirror.
    let deep = (1.0 - clamp(s.x, 0.0, 1.0)) * smoothstep(0.0, 0.7 * LAMBDA, a.x);
    open = 1.0 - 0.8 * deep;
  } else {
    let across = clamp((r - RIM_MID) / RIM_HALF, -1.0, 1.0);
    let outward = in.place / r;
    normal = normalize(vec3f(outward * across * RIM_TOP, sqrt(1.0 - across * across) * RIM_HALF + 0.0001));
    mirror = 0.16;
    own = vec3f(0.03, 0.032, 0.036);
  }
  let facing = max(dot(normal, view), 0.0);
  let bounced = reflect(-view, normal);
  let fresnel = mirror + (1.0 - mirror) * pow(1.0 - facing, 5.0);
  // A ray that leaves a hollow sideways meets the next spike, not the room.
  let clear = mix(1.0, smoothstep(0.05, 0.6, bounced.z), 1.0 - open);
  let light = room(bounced, in.tint) * fresnel * open * clear + own;
  return vec4f(vec3f(1.0) - exp(-light * 2.6), 1.0);
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

// The dish lies flat and z is up.
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
  const x = norm(cross([0, 0, 1], z));
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

// ---- the mesh ------------------------------------------------------------------

// A sheet of small triangles over the dish and its rim, laid on the same
// rows as the spikes so that every tip is a corner of it: a tip that fell
// between corners would be drawn blunt, and differently blunt from the
// next.
function buildMesh() {
  const step = LAMBDA / STEPS;
  const rowStep = step * 0.8660254;
  const reach = RIM_OUT + 2 * step;
  const rows = Math.ceil(reach / rowStep);
  const cols = Math.ceil(reach / step) + 1;
  const index = new Map();
  const points = [];
  const at = (i, j) => [(i + 0.5 * j) * step, j * rowStep];
  const corner = (i, j) => {
    const [x, y] = at(i, j);
    if (x * x + y * y > reach * reach) return -1;
    const key = (i + 8192) * 16384 + (j + 8192);
    let k = index.get(key);
    if (k === undefined) {
      k = points.length / 2;
      index.set(key, k);
      points.push(x, y);
    }
    return k;
  };
  const triangles = [];
  for (let j = -rows; j < rows; j++) {
    // Row j is pushed half a step along for every row up, so the columns
    // that cover the dish move the other way.
    const from = Math.floor(-cols - 0.5 * j) - 1;
    const to = Math.ceil(cols - 0.5 * j) + 1;
    for (let i = from; i < to; i++) {
      const a = corner(i, j);
      const b = corner(i + 1, j);
      const c = corner(i, j + 1);
      const d = corner(i + 1, j + 1);
      if (a >= 0 && b >= 0 && c >= 0) triangles.push(a, b, c);
      if (b >= 0 && d >= 0 && c >= 0) triangles.push(b, d, c);
    }
  }
  return { points: new Float32Array(points), triangles: new Uint32Array(triangles) };
}

// ---- magnets from a compound -----------------------------------------------------

// Position of a frequency on the analyser's band axis, 0..1.
function bandOf(hz) {
  return Math.min(1, Math.max(0, Math.log(hz / LOW_HZ) / Math.log(SPAN)));
}

// The peaks the station voices: at most MAX_MAGNETS, strongest first, none
// more than 40 dB below the strongest. Same rule as piece.scd.
function voicedPeaks(compound) {
  const freqs = (compound && compound.frequencies) || [];
  const amps = (compound && compound.amplitudes) || [];
  let peaks = freqs.map((f, i) => ({ f, a: amps[i] })).filter((p) => p.f > 0 && p.a >= 0);
  const top = Math.max(0, ...peaks.map((p) => p.a));
  if (!peaks.length || top <= 0) return null;
  peaks = peaks.filter((p) => p.a >= top * PEAK_FLOOR);
  if (peaks.length > MAX_MAGNETS) {
    peaks = peaks.sort((p, q) => q.a - p.a).slice(0, MAX_MAGNETS);
  }
  return peaks.sort((p, q) => p.f - q.f).map((p) => ({ f: p.f, a: p.a / top }));
}

// With no compound: twelve magnets alike, spread over the audible range.
function idlePeaks() {
  return Array.from({ length: 12 }, (_, k) => ({ f: 80 * Math.pow(75, k / 11), a: 1, idle: true }));
}

// The nearest place a spike stands.
function onSpike(x, y) {
  const row = Math.round(y / (LAMBDA * 0.8660254));
  const col = Math.round(x / LAMBDA - 0.5 * row);
  return [(col + 0.5 * row) * LAMBDA, row * LAMBDA * 0.8660254];
}

function describeMagnets(compound, tall) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const strength = peaks.map((p) => (p.idle ? 0.7 : Math.sqrt(p.a)));
  // A wider magnet the stronger the peak, and all of them together a fixed
  // part of the dish, so that one peak is a great crown and thirty-two are
  // small ones with room between.
  const wide = strength.map((s) => 0.55 + 0.75 * s);
  const area = wide.reduce((sum, w) => sum + w * w, 0);
  const unit = 0.8 * Math.sqrt((tall ? 0.36 : 0.44) / area);
  // On a tall screen the dish is wider than the screen, and the magnets
  // keep to the part of it that is seen.
  const wide0 = tall ? 0.36 : 0.65;
  const deep0 = tall ? 0.7 : 0.62;
  const sides = tall ? 0.6 : 2;
  const magnets = peaks.map((p, k) => {
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    const radius = Math.min(0.36, Math.max(1.05 * LAMBDA, unit * wide[k]));
    // Low peaks at the left to high at the right, as a spectrum is drawn,
    // and up and down the dish by turns that never repeat.
    const along = (x - 0.5) * 2 * wide0;
    const across = deep0 * (2 * ((k * 0.6180339887 + 0.31) % 1) - 1) * Math.sqrt(Math.max(0, 1 - along * along / 0.81));
    return {
      home: [along, span > 0 || peaks.length > 1 ? across : 0],
      at: [along, span > 0 || peaks.length > 1 ? across : 0],
      radius,
      hue: x,
      band: bandOf(p.f),
      strength: 0.5 + 0.6 * strength[k],
    };
  });
  // Magnets that would lie on one another are pushed apart, and none
  // leaves the dish.
  for (let round = 0; round < 240; round++) {
    for (let a = 0; a < magnets.length; a++) {
      for (let b = a + 1; b < magnets.length; b++) {
        const p = magnets[a];
        const q = magnets[b];
        let dx = q.at[0] - p.at[0];
        let dy = q.at[1] - p.at[1];
        let d = Math.hypot(dx, dy);
        const want = 1.15 * (p.radius + q.radius);
        if (d >= want) continue;
        if (d < 1e-4) {
          dx = Math.cos(a * 2.4 + b);
          dy = Math.sin(a * 2.4 + b);
          d = 1;
        }
        const push = 0.5 * (want - d) / d;
        p.at[0] -= dx * push; p.at[1] -= dy * push;
        q.at[0] += dx * push; q.at[1] += dy * push;
      }
    }
    for (const m of magnets) {
      m.at[0] += 0.02 * (m.home[0] - m.at[0]);
      m.at[1] += 0.02 * (m.home[1] - m.at[1]);
      const side = Math.max(0, sides - 0.9 * m.radius);
      m.at[0] = Math.min(side, Math.max(-side, m.at[0]));
      const far = Math.max(0, 0.86 - 1.1 * m.radius);
      const d = Math.hypot(m.at[0], m.at[1]);
      if (d > far) {
        m.at[0] *= far / (d || 1);
        m.at[1] *= far / (d || 1);
      }
    }
  }
  // A magnet sits under a spike, so that its crown is even all round.
  for (const m of magnets) m.at = onSpike(m.at[0], m.at[1]);
  return magnets;
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

  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  }

  const mesh = buildMesh();
  const pointBuffer = device.createBuffer({
    size: mesh.points.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(pointBuffer, 0, mesh.points);
  const triangleBuffer = device.createBuffer({
    size: mesh.triangles.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(triangleBuffer, 0, mesh.triangles);

  const uniformData = new Float32Array(20 + 8 * MAX_MAGNETS);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Edges this sharp against black need more than one sample to a pixel.
  const SAMPLES = 4;
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'surfaceVertex',
      buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
    },
    fragment: { module, entryPoint: 'surfaceFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: SAMPLES },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // ---- magnets follow the compound ----

  let magnets = [];
  let waiting = null; // the magnets that come once the fluid has fallen flat
  let shownKey = null;
  let fallingFor = 0;
  const isTall = () => canvas.clientWidth < 0.8 * canvas.clientHeight;

  function followCompound() {
    const compound = getCompound();
    // A screen that is turned is a different part of the dish to fill.
    const key = (isTall() ? 'tall|' : 'wide|') + (compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '');
    if (key === shownKey) return;
    const first = shownKey === null;
    shownKey = key;
    const described = describeMagnets(compound, isTall()).map((m) => ({ ...m, field: 0, speed: 0 }));
    if (first) magnets = described;
    else {
      waiting = described;
      fallingFor = 0;
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
      // player gives silence): the magnets swell by themselves.
      for (let b = 0; b < BANDS; b++) {
        fresh[b] = 0.24 + 0.2 * Math.sin(time * (0.23 + 0.07 * b) + b * 1.9);
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

  // Energy of the stream around a magnet's pitch: 0 is the lowest band, 1 the highest.
  function bandEnergy(b) {
    const x = Math.min(1, Math.max(0, b)) * (BANDS - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, BANDS - 1);
    return bands[i] + (bands[j] - bands[i]) * (x - i);
  }

  // The fluid has weight: it follows its magnet a moment late, goes past
  // and comes back, which is what makes it look wet.
  function drive(dt) {
    if (waiting) {
      fallingFor += dt;
      if (fallingFor > 1.6 || magnets.every((m) => m.field < 0.03)) {
        magnets = waiting;
        waiting = null;
      }
    }
    for (const m of magnets) {
      const want = waiting
        ? 0
        : m.strength * (0.5 + 1.5 * bandEnergy(m.band) + 0.25 * level) + 0.45 * kick;
      let left = dt;
      while (left > 0) {
        const h = Math.min(left, 0.008);
        left -= h;
        m.speed += (260 * (want - m.field) - 11 * m.speed) * h;
        m.field = Math.max(0, m.field + m.speed * h);
      }
    }
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let colour = null; // what is drawn into, several samples to a pixel
  let depth = null;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the picture is drawn with fewer pixels until they
  // are not. A slow GPU gets a softer picture, not a backlog.
  let busy = false;
  let fine = 1; // the part of the full number of pixels each way
  const held = new URLSearchParams(location.search).has('fine'); // ?fine keeps it at 1
  let slowness = 0; // smoothed seconds per frame

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5) * fine;
    const w = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (w === width && h === height && colour) return;
    width = canvas.width = w;
    height = canvas.height = h;
    if (colour) colour.destroy();
    if (depth) depth.destroy();
    colour = device.createTexture({
      size: [w, h], format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    depth = device.createTexture({
      size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
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
    if (real > 0 && !held) {
      slowness += (Math.min(real, 0.5) - slowness) * 0.1;
      if (slowness > 0.045 && fine > 0.5) {
        fine = Math.max(0.5, fine * 0.8);
        slowness = 0.03;
      } else if (slowness < 0.02 && fine < 1) {
        fine = Math.min(1, fine * 1.1);
        slowness = 0.03;
      }
    }
    fit();
    listen(time, dt);
    drive(dt);

    // Seen from the front and above, from higher where the screen is tall
    // so that the dish, which is as wide as the screen there, is not a
    // sliver. The eye sways a little from side to side, and with it
    // everything the fluid mirrors.
    const aspect = width / height;
    const tall = Math.min(1, Math.max(0, (1.1 - aspect) / 0.5));
    const rise = (32 + 10 * tall + 3 * Math.sin(time * 0.043)) * Math.PI / 180;
    const turn = (0.42 - 0.2 * tall) * Math.sin(time * 0.057);
    const fov = (36 * Math.PI) / 180;
    const half = Math.tan(fov / 2);
    const reach = RIM_OUT + 0.03;
    // All of the dish where the screen is wide. Where it is tall that would
    // be a sliver across the middle, so there the dish is as deep as the
    // screen has room for and its sides are out of sight.
    const away = Math.max(
      (reach - 0.34 * tall) / (0.97 * half * aspect),
      (reach * Math.sin(rise) + 0.3 * Math.cos(rise)) / (0.8 * half),
    );
    const eye = [
      Math.sin(turn) * Math.cos(rise) * away,
      -Math.cos(turn) * Math.cos(rise) * away,
      Math.sin(rise) * away,
    ];
    uniformData.set(multiply(perspective(fov, aspect, 0.1, 100), lookAt(eye, [0, 0, 0.04])), 0);
    uniformData.set(eye, 16);
    uniformData[19] = magnets.length;
    magnets.forEach((m, k) => {
      const at = 20 + 8 * k;
      uniformData[at] = m.at[0];
      uniformData[at + 1] = m.at[1];
      uniformData[at + 2] = 1 / (m.radius * m.radius);
      uniformData[at + 3] = m.field;
      uniformData[at + 4] = m.hue;
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colour.createView(),
        resolveTarget: context.getCurrentTexture().createView(),
        clearValue: { r: 0.0667, g: 0.0667, b: 0.0667, a: 1 }, // the page's #111
        loadOp: 'clear',
        storeOp: 'discard',
      }],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, pointBuffer);
    pass.setIndexBuffer(triangleBuffer, 'uint32');
    pass.drawIndexed(mesh.triangles.length);
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
