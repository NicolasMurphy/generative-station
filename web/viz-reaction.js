// "reaction": Gray-Scott reaction-diffusion, drawn as contour lines (WebGPU).
//
// The compound sets the two parameters: the spectrum's centroid (low vs
// high) sets the feed rate, its spread sets the kill rate. So different
// compounds grow spots, stripes or unstable patterns. Parameters vary
// slowly across the dish so the pattern never settles, and patches are
// occasionally cleared and regrow. The low, mid and high peak groups each
// tint a drifting region of the dish, sized by their strength.
//
// Audio: energy near a group's peaks brightens its region, loudness speeds
// up the simulation, kicks flash the dish. Without audio (e.g. iOS) a slow
// internal swell stands in.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. Throws if WebGPU is unavailable.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const MAX_DROPS = 8; // at work in the dish at one time

const SHADER = /* wgsl */ `
struct Uniforms {
  grid: vec2f,     // cells across and down
  view: vec2f,     // the canvas, in pixels
  cell: f32,       // pixels to a cell
  time: f32,
  feed: f32,
  kill: f32,
  wander: vec4f,   // how far feed and kill stray across the dish, and where the straying has got to
  parts: vec4f,    // where the low part gives way to the middle (from, to) and the middle to the high
  shine: vec4f,    // xyz: how bright each part's lines are just now; w: the whole dish
  dropCount: f32,
  drops: array<vec4f, ${MAX_DROPS}>, // x, y, radius (in cells), and 0 to seed or 1 to clear
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// A cell holds the food (x) and the feeder (y).
@group(1) @binding(0) var<storage, read> before: array<vec2f>;
@group(1) @binding(1) var<storage, read_write> after: array<vec2f>;
@group(1) @binding(2) var<storage, read> shown: array<vec2f>;

// The dish has no edge: what leaves one side comes back on the other.
// This brings back a place up to one whole dish outside it.
fn wrap(at: i32, size: i32) -> i32 {
  return select(select(at, at + size, at < 0), at - size, at >= size);
}

// ---- simulation ------------------------------------------------------------

@compute @workgroup_size(8, 8)
fn react(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.grid.x) || id.y >= u32(u.grid.y)) {
    return;
  }
  let w = i32(u.grid.x);
  let h = i32(u.grid.y);
  let x = i32(id.x);
  let left = wrap(x - 1, w);
  let right = wrap(x + 1, w);
  let row = i32(id.y) * w;
  let above = wrap(i32(id.y) - 1, h) * w;
  let below = wrap(i32(id.y) + 1, h) * w;
  let c = before[row + x];
  // Both substances spread into the cells around, the food twice as fast.
  let around = 0.2 * (before[row + left] + before[row + right] + before[above + x] + before[below + x])
    + 0.05 * (before[above + left] + before[above + right] + before[below + left] + before[below + right]);
  let spread = around - c;

  // Feed and kill stray from the compound's by whole turns of sine over the
  // dish, so the straying has no edge either.
  let p = 6.2831853 * (vec2f(id.xy) / u.grid + u.wander.zw);
  let feed = u.feed + u.wander.x * sin(p.x + 1.3 * sin(p.y));
  let kill = u.kill + u.wander.y * sin(p.y - 1.1 * sin(p.x));

  // The feeder turns food into more feeder where two of it meet.
  let eaten = c.x * c.y * c.y;
  var next = vec2f(
    c.x + spread.x - eaten + feed * (1.0 - c.x),
    c.y + 0.5 * spread.y + eaten - (feed + kill) * c.y);

  let count = u32(u.dropCount);
  for (var k = 0u; k < count; k++) {
    let d = u.drops[k];
    var off = abs(vec2f(id.xy) - d.xy);
    off = min(off, u.grid - off);
    let near = 1.0 - dot(off, off) / (d.z * d.z);
    if (near > 0.0) {
      if (d.w > 0.5) {
        next.y *= 1.0 - 0.06 * near; // cleared, a little every step
      } else if (next.y < 0.02) {
        next = vec2f(0.5, 0.25); // seeded, where the dish is bare
      }
    }
  }
  after[row + x] = clamp(next, vec2f(0.0), vec2f(1.0));
}

// ---- drawing ---------------------------------------------------------------

@vertex
fn drawVertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

// The dish at a point between cells.
fn look(g: vec2f) -> vec2f {
  let f = floor(g - 0.5);
  let t = g - 0.5 - f;
  let w = i32(u.grid.x);
  let h = i32(u.grid.y);
  let left = wrap(i32(f.x), w);
  let right = wrap(left + 1, w);
  let upper = wrap(i32(f.y), h) * w;
  let lower = wrap(i32(f.y) + 1, h) * w;
  return mix(
    mix(shown[upper + left], shown[upper + right], t.x),
    mix(shown[lower + left], shown[lower + right], t.x),
    t.y);
}

// A contour line at one height of the feeder: as wide on the screen
// whatever the slope it crosses.
fn contour(feeder: f32, height: f32, steep: f32, wide: f32) -> f32 {
  return 1.0 - smoothstep(0.45 * wide, wide, abs(feeder - height) / steep);
}

@fragment
fn drawFragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let g = (pos.xy - 0.5 * u.view) / u.cell + 0.5 * u.grid;
  let c = look(g);
  let feeder = c.y;
  let slope = 0.5 * vec2f(
    look(g + vec2f(1.0, 0.0)).y - look(g - vec2f(1.0, 0.0)).y,
    look(g + vec2f(0.0, 1.0)).y - look(g - vec2f(0.0, 1.0)).y);
  let steep = length(slope) + 0.0005;

  // Which part of the dish this is: a slow wave that crosses it, bent and
  // turning, runs from the low part (0) through the middle to the high (1).
  let q = (pos.xy - 0.5 * u.view) / min(u.view.x, u.view.y);
  let turn = 0.021 * u.time;
  let wave = 0.55 * dot(q, vec2f(cos(turn), sin(turn)))
    + 0.28 * sin(3.1 * q.y + 0.13 * u.time) + 0.28 * sin(2.7 * q.x - 0.11 * u.time)
    + 0.017 * u.time;
  let place = abs(fract(wave) * 2.0 - 1.0);
  let isLow = 1.0 - smoothstep(u.parts.x, u.parts.y, place);
  let isHigh = smoothstep(u.parts.z, u.parts.w, place);
  let isMid = 1.0 - isLow - isHigh;

  // Warm for the low peaks, green for the middle, blue for the high: the
  // same order as the other visuals, a little paler for being lines.
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  var tint = isLow * low + isMid * mid + isHigh * high;
  tint = mix(tint, vec3f(dot(tint, vec3f(0.33))), 0.25);
  // The page's words lie over the top and the bottom of the dish, so it is
  // dimmer there.
  let fromEdge = min(pos.y, u.view.y - pos.y) / u.view.y;
  let clear = u.shine.w * mix(0.3, 1.0, smoothstep(0.0, 0.22, fromEdge));
  let bright = clear * dot(vec3f(isLow, isMid, isHigh), u.shine.xyz);

  let lines = contour(feeder, 0.09, steep, 0.6)
    + 0.5 * contour(feeder, 0.19, steep, 0.5)
    + 0.3 * contour(feeder, 0.29, steep, 0.5);
  let body = smoothstep(0.07, 0.24, feeder);
  let halo = (1.0 - c.x) * (1.0 - c.x); // the food it has eaten around itself
  let color = tint * (bright * 0.85 * min(lines, 1.0) + clear * (0.07 * body + 0.05 * halo));

  return vec4f(vec3f(0.0667) + color, 1.0); // on the page's #111
}
`;

// ---- the reaction a compound sets off ------------------------------------------

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

// With no compound: three plain peaks, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 1, idle: true }, { f: 640, a: 1, idle: true }];
}

function describeReaction(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const mean = logs.reduce((sum, l) => sum + l, 0) / logs.length;

  // The low, middle and high thirds of the compound are a part of the dish
  // each. A lone peak, or peaks all at one pitch, are the middle.
  const parts = [0, 1, 2].map(() => ({ share: 0, band: 0, weight: 0 }));
  peaks.forEach((p, k) => {
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    const part = parts[Math.min(2, Math.floor(x * 3))];
    const strength = Math.sqrt(p.a);
    part.share += strength + 0.08;
    part.band += bandOf(p.f) * strength;
    part.weight += strength;
  });
  parts.forEach((part) => {
    part.band = part.weight > 0 ? part.band / part.weight : 0.5;
  });

  // Where the compound sits between 80 Hz and 4 kHz sets the feed. The
  // kill starts where a reaction with that feed can first hold a pattern
  // and rises with the octaves the peaks cover (up to four): close peaks
  // grow stripes and mazes, peaks far apart grow spots. A fast-fed
  // reaction cannot take as much kill, so there it rises less.
  const centre = Math.min(1, Math.max(0, (mean - Math.log(80)) / Math.log(50)));
  const width = Math.min(1, span / Math.LN2 / 4);
  const feed = 0.021 + 0.029 * centre;
  const room = 0.003 - 0.002 * Math.max(0, (feed - 0.042) / 0.008);
  const kill = Math.sqrt(feed) / 2 - feed + room * width;
  return { parts, feed, kill, idle: !!peaks[0].idle };
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

  const uniformData = new Float32Array(24 + MAX_DROPS * 4);
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
  const reactLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const drawLayout = device.createBindGroupLayout({
    entries: [{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
  });

  const reactPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, reactLayout] }),
    compute: { module, entryPoint: 'react' },
  });
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, drawLayout] }),
    vertex: { module, entryPoint: 'drawVertex' },
    fragment: { module, entryPoint: 'drawFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sharedGroup = device.createBindGroup({
    layout: sharedLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // ---- the reaction follows the compound ----

  let reaction = describeReaction(null);
  let shownKey = null;
  let shower = 0; // seeds still owed to a new compound

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      // What is growing may not live through the change, so the new
      // reaction is seeded wherever the dish is left bare.
      if (shownKey !== null) shower = 40;
      shownKey = key;
      reaction = describeReaction(compound);
    }
  }
  followCompound();
  const followTimer = setInterval(followCompound, 1000);

  // ---- the dish ----

  // A cell is two and a half CSS pixels, more on a large window so the dish
  // never has more cells than a phone's GPU steps through with ease.
  function dishFor(cssWidth, cssHeight) {
    const shrink = Math.max(2.5, Math.sqrt((cssWidth * cssHeight) / 200000));
    return {
      w: Math.max(48, Math.round(cssWidth / shrink)),
      h: Math.max(48, Math.round(cssHeight / shrink)),
    };
  }

  let dish = null;

  function buildDish(w, h) {
    if (dish) dish.buffers.forEach((b) => b.destroy());
    const cells = new Float32Array(w * h * 2);
    for (let i = 0; i < w * h; i++) cells[i * 2] = 1; // all food, no feeder
    // Seeded here and there, and the pattern grows out from the seeds.
    const seeds = Math.max(8, Math.round((w * h) / 700));
    for (let s = 0; s < seeds; s++) {
      const cx = Math.floor(Math.random() * w);
      const cy = Math.floor(Math.random() * h);
      const r = 2 + Math.floor(Math.random() * 3);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const i = (((cy + dy) % h + h) % h) * w + ((cx + dx) % w + w) % w;
          cells[i * 2] = 0.5;
          cells[i * 2 + 1] = 0.25;
        }
      }
    }
    const buffers = [0, 1].map(() => device.createBuffer({
      size: cells.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(buffers[0], 0, cells);
    dish = {
      w,
      h,
      buffers,
      now: 0, // which of the two buffers holds the dish as it is now
      // a step reads one buffer and writes the other
      step: [0, 1].map((from) => device.createBindGroup({
        layout: reactLayout,
        entries: [
          { binding: 0, resource: { buffer: buffers[from] } },
          { binding: 1, resource: { buffer: buffers[1 - from] } },
        ],
      })),
      draw: buffers.map((buffer) => device.createBindGroup({
        layout: drawLayout,
        entries: [{ binding: 2, resource: { buffer } }],
      })),
      drops: [], // { x, y, r, clear, until }
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

  // Energy of the stream around a part's peaks: 0 is the lowest band, 1 the highest.
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
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the reaction is stepped fewer times in each until
  // they are not. A slow GPU gets a slower reaction, not a backlog.
  let busy = false;
  let most = 12; // steps in one frame
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let owed = 0;
  let slowness = 0; // smoothed seconds per frame
  let feed = reaction.feed;
  let kill = reaction.kill;
  let glow = 0;

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
      if (slowness > 0.045 && most > 1) {
        most = Math.max(1, Math.floor(most * 0.7));
        slowness = 0.03;
      } else if (slowness > 0.045 && sharp > 1) {
        sharp = 1; // still slow at one step a frame: a coarser picture too
        slowness = 0.03;
      } else if (slowness < 0.02 && most < 12) {
        most += 1;
      }
    }
    fit();
    listen(time, dt);

    // Feed and kill glide to the compound's, so a new compound's pattern
    // grows out of the old one's.
    const glide = Math.min(1, dt * 0.5);
    feed += (reaction.feed - feed) * glide;
    kill += (reaction.kill - kill) * glide;
    glow += ((reaction.idle ? 0.55 : 1) - glow) * Math.min(1, dt * 0.8);

    // Each part's size follows its peaks' strength, and the stream's
    // energy around them.
    const energy = reaction.parts.map((part) => bandEnergy(part.band));
    const sizes = reaction.parts.map((part, k) => part.share * (0.5 + 2 * energy[k]));
    const whole = sizes[0] + sizes[1] + sizes[2];
    const lowEnds = sizes[0] / whole;
    const highStarts = 1 - sizes[2] / whole;
    // One part shades into the next over a third of the way across; a
    // part with no peaks is given no room at all.
    const edge = (at, there) => (there ? [at - 0.17, at + 0.17] : [at - 0.001, at]);

    // Drops: a new compound is seeded in a shower, and every second or so
    // a patch is cleared, more often in loud passages and in a larger dish.
    dish.drops = dish.drops.filter((d) => d.until > time);
    const drop = (clear) => {
      if (dish.drops.length >= MAX_DROPS) return;
      dish.drops.push({
        x: Math.random() * dish.w,
        y: Math.random() * dish.h,
        r: clear ? 3 + 6 * Math.random() : 2.5 + 2 * Math.random(),
        clear,
        until: time + (clear ? 0.5 : 0),
      });
    };
    for (let s = 0; s < 3 && shower > 0; s++, shower--) drop(false);
    if (Math.random() < dt * 0.7 * (dish.w * dish.h / 50000) * (0.5 + 2 * level)) drop(true);
    if (Math.random() < dt * 0.5) drop(false);
    dish.drops.forEach((d, k) => {
      uniformData.set([d.x, d.y, d.r, d.clear ? 1 : 0], 24 + k * 4);
    });

    owed = Math.min(most, owed + dt * (260 + 520 * level));
    const steps = Math.floor(owed);
    owed -= steps;

    uniformData.set([
      dish.w, dish.h, width, height,
      Math.max(width / dish.w, height / dish.h), time, feed, kill,
      0.003, 0.001, time * 0.02, time * 0.013,
      ...edge(lowEnds, sizes[0] > 0), ...edge(highStarts, sizes[2] > 0),
      0.55 + 1.5 * energy[0], 0.55 + 1.5 * energy[1], 0.55 + 1.5 * energy[2], glow * (1 + 0.5 * kick),
      dish.drops.length,
    ], 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    if (steps > 0) {
      const compute = encoder.beginComputePass();
      compute.setPipeline(reactPipeline);
      compute.setBindGroup(0, sharedGroup);
      for (let s = 0; s < steps; s++) {
        compute.setBindGroup(1, dish.step[dish.now]);
        compute.dispatchWorkgroups(Math.ceil(dish.w / 8), Math.ceil(dish.h / 8));
        dish.now = 1 - dish.now;
      }
      compute.end();
    }

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
