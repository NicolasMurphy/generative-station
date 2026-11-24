// "aurora": the compound as northern lights (WebGPU).
//
// An aurora is thin air lit from above, and a curtain of it is made of
// rays: each stands where the air was struck and reaches up as far as it
// was struck hard. Here the curtain is the compound's mass spectrum, hung
// across the sky from its lowest peak to its highest. Every voiced peak is
// a ray: where it stands along the curtain follows its frequency, and how
// bright it is and how far up it reaches follow its intensity. It is the
// same drawing as the cover a lock screen shows, the peaks from low to
// high and each as tall as it is strong, but hung in the air and seen from
// underneath.
//
// The curtain is a sheet, as thin as a real one, and it waves slowly, now
// nearer and now further away. Seen from the ground a wave is a fold:
// where the sheet turns along the line of sight its light piles up, the
// rays there stand close together, and they draw apart again where the
// sheet turns to face the eye. A hem of light runs along its lower edge.
//
// The rays are warm for the low peaks, through green, to blue for the high:
// the same order of colours as in the other visuals.
//
// Where the page can hear the stream, a ray brightens and reaches higher
// while there is energy around its peak, the curtain waves faster in loud
// passages, and a kick lights the hem. Where it cannot (iOS gives a page no
// sound to look at for a live stream) a slow swell of its own does the
// same, as in "bloom". A new compound's rays grow in where the old ones
// fade.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const ALONG = 1024; // places along the curtain that are told to the GPU
const COLUMNS = 768; // strips the sheet is drawn in, side by side
const SAMPLES = 4; // to a pixel, or the edge of a fold would be jagged

const SHADER = /* wgsl */ `
struct Uniforms {
  view: vec2f,     // the canvas, in pixels
  wave: f32,       // how far the curtain's waving has got, within one round of all its waves
  half: f32,       // half the curtain's length
  glow: f32,       // the whole sky
  kick: f32,
  lean: f32,       // how much nearer one end of the curtain is than the other
  focal: f32,      // how much of the sky the window takes in: more, the smaller this is
};

@group(0) @binding(0) var<uniform> u: Uniforms;

const PITCH = 0.66;   // the eye looks up, this far from level
const AWAY = 3.0;     // from the eye to the middle of the curtain, over the ground
const HEM = 0.75;     // how high its lower edge hangs
const TALL = 6.0;     // the reach of the tallest ray
const PAST = 0.07;    // the curtain goes on this far past its last peaks, thinning

// ---- the curtain, into a picture of its light --------------------------------

// Along the curtain: how bright the rays are (r), how far up they reach (g)
// and the veil between them (b).
@group(1) @binding(0) var curtain: texture_2d<f32>;
@group(1) @binding(1) var along: sampler;

// How far from the eye the sheet hangs at a place along it, and how fast
// that changes along it: slow waves that run along the curtain, one bending
// the next.
fn sheet(x: f32) -> vec2f {
  let t = u.wave;
  let bend = 0.8 * x - 0.5 * t;
  let a = 1.7 * x + 0.9 * t + 1.2 * sin(bend);
  let b = 4.3 * x - 1.3 * t + 2.0;
  let c = 9.1 * x + 2.1 * t;
  return vec2f(
    AWAY + u.lean * x / u.half + 0.7 * sin(a) + 0.3 * sin(b) + 0.1 * sin(c),
    u.lean / u.half + 0.7 * cos(a) * (1.7 + 0.96 * cos(bend)) + 1.29 * cos(b) + 0.91 * cos(c));
}

// The lower edge is not quite level either.
fn hem(x: f32) -> f32 {
  return HEM + 0.06 * sin(2.3 * x - 0.7 * u.wave) + 0.03 * sin(5.1 * x + 1.1 * u.wave);
}

struct Sheet {
  @builtin(position) pos: vec4f,
  @location(0) at: f32,     // along the curtain: 0 at its lowest peak's end, 1 at its highest's
  @location(1) up: f32,     // above the hem
  @location(2) place: vec3f,
  @location(3) turn: f32,   // how fast the sheet draws away, along itself
};

@vertex
fn drawVertex(@builtin(vertex_index) vi: u32) -> Sheet {
  // The sheet is one strip: two corners to a column, at the hem and at the top.
  let top = f32(vi & 1u);
  let at = -PAST + (1.0 + 2.0 * PAST) * f32(vi >> 1u) / ${COLUMNS}.0;
  let x = (2.0 * at - 1.0) * u.half;
  let hangs = sheet(x);
  let p = vec3f(x, hem(x) + top * TALL, hangs.x);
  // The eye is on the ground and looks up.
  let c = cos(PITCH);
  let s = sin(PITCH);
  let seen = vec3f(p.x, p.y * c - p.z * s, p.z * c + p.y * s);
  let least = min(u.view.x, u.view.y);
  var out: Sheet;
  out.pos = vec4f(seen.xy * u.focal * least / u.view, 0.5 * seen.z, seen.z);
  out.at = at;
  out.up = top * TALL;
  out.place = p;
  out.turn = hangs.y;
  return out;
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

@fragment
fn drawFragment(strip: Sheet) -> @location(0) vec4f {
  let at = strip.at;
  let up = strip.up;
  let here = textureSample(curtain, along, vec2f(at, 0.5));
  let ends = smoothstep(-PAST, 0.03, at) * (1.0 - smoothstep(0.97, 1.0 + PAST, at));
  // Sharp below, where the air is too thick to be lit, and fading upward.
  let lower = smoothstep(0.0, 0.07, up);
  let upper = 1.0 - smoothstep(0.7 * TALL, TALL, up);
  let rays = here.r * exp(-up / (0.2 + 2.8 * here.g)) * upper;
  let veil = here.b * (0.3 * exp(-up / 1.1) + (1.3 + 2.0 * u.kick) * exp(-up / 0.12));
  // The light is whiter at the hem, where it is strongest.
  let colour = mix(palette(at + 0.14 * (1.0 - exp(-up / 1.5))), vec3f(1.0), 0.3 * exp(-up / 0.2));
  // A sheet seen at a slant is looked through for longer, so it is
  // brighter there: brightest where it turns along the line of sight.
  let sight = normalize(strip.place);
  let slant = max(abs(sight.z - strip.turn * sight.x), 0.2);
  return vec4f(colour * ((rays + veil) * ends * lower * 1.8 * u.glow / slant), 1.0);
}

// ---- the light that has gathered, onto the page ------------------------------

@group(1) @binding(0) var gathered: texture_multisampled_2d<f32>;

@vertex
fn showVertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

@fragment
fn showFragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
  // Where folds lie behind one another the light adds up, towards white
  // and not past it. That is worked out for each of a pixel's samples
  // before they are put together: the edge of a fold is far brighter than
  // white, and put together first it would stay white, and jagged.
  var lit = vec3f(0.0);
  for (var k = 0; k < ${SAMPLES}; k++) {
    lit += 1.0 - exp(-textureLoad(gathered, vec2i(at.xy), k).rgb);
  }
  lit /= ${SAMPLES}.0;
  let page = vec3f(0.0667); // the page's #111
  return vec4f(page + (1.0 - page) * lit, 1.0);
}
`;

// ---- the rays a compound hangs in the curtain ----------------------------------

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

// With no compound: three plain rays, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 1, idle: true }, { f: 640, a: 1, idle: true }];
}

function describeRays(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  // A ray is as wide as there is room for: a compound of few peaks hangs
  // broad rays, one of many hangs narrow ones.
  const wide = Math.min(0.016, Math.max(0.006, 0.17 / peaks.length));
  return {
    idle: !!peaks[0].idle,
    rays: peaks.map((p, k) => ({
      // the lowest peak a little in from one end of the curtain, the
      // highest a little in from the other; a lone peak in the middle
      at: 0.07 + 0.86 * (span > 0 ? (logs[k] - lo) / span : 0.5),
      strength: Math.sqrt(p.a),
      band: bandOf(p.f),
      wide,
    })),
  };
}

// The veil between the rays is finely rayed too. These are its rays: the
// same every time, as a curtain's weave is.
const WEAVE = new Float32Array(512);
for (let i = 0, seed = 7; i < WEAVE.length; i++) {
  seed = (seed * 16807) % 2147483647;
  WEAVE[i] = seed / 2147483647;
}
function weave(x) {
  const i = Math.floor(x);
  const t = x - i;
  const a = WEAVE[((i % 512) + 512) % 512];
  const b = WEAVE[(((i + 1) % 512) + 512) % 512];
  return a + (b - a) * t * t * (3 - 2 * t);
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

  const uniformData = new Float32Array(8);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Anything the GPU will not do is asked about once everything is set up,
  // so that the page can turn to another visual instead of an empty one.
  device.pushErrorScope('validation');

  // The curtain is told to the GPU at full length and at every halving of
  // it: where the sheet is seen at a slant, many places along it fall on one
  // pixel, and the pixel is given what they come to together.
  const curtainData = [];
  for (let n = ALONG; n >= 1; n /= 2) curtainData.push(new Uint8Array(n * 4));
  const curtainTexture = device.createTexture({
    size: [ALONG, 1],
    mipLevelCount: curtainData.length,
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  }

  const sharedLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const curtainLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const showLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'unfilterable-float', multisampled: true },
    }],
  });
  // The sheet's light is added up in a picture of its own, which can hold
  // more than white, and brought onto the page from there.
  const GATHERED = 'rgba16float';
  const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, curtainLayout] }),
    vertex: { module, entryPoint: 'drawVertex' },
    fragment: {
      module,
      entryPoint: 'drawFragment',
      targets: [{ format: GATHERED, blend: { color: additive, alpha: additive } }],
    },
    primitive: { topology: 'triangle-strip' },
    multisample: { count: SAMPLES },
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
  const curtainGroup = device.createBindGroup({
    layout: curtainLayout,
    entries: [
      { binding: 0, resource: curtainTexture.createView() },
      { binding: 1, resource: sampler },
    ],
  });

  // ---- the curtain follows the compound ----

  let hung = describeRays(null);
  let shownKey = null;
  // What was hanging when the compound changed, and how far the change
  // has got: the old rays fade while the new ones grow in.
  const bright = new Float32Array(ALONG);
  const reach = new Float32Array(ALONG);
  const oldBright = new Float32Array(ALONG);
  const oldReach = new Float32Array(ALONG);
  let changed = 1;

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      if (shownKey !== null) {
        oldBright.set(bright);
        oldReach.set(reach);
        changed = 0;
      }
      shownKey = key;
      hung = describeRays(compound);
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

  // ---- the curtain as it hangs just now ----

  let drift = 0; // how far the veil's shimmer has run along the curtain

  function hang(dt) {
    bright.fill(0);
    reach.fill(0);
    for (const ray of hung.rays) {
      const energy = bandEnergy(ray.band);
      const lit = ray.strength * (0.5 + 1.7 * energy);
      const up = Math.min(1, Math.pow(ray.strength, 0.8) * (0.6 + 1.1 * energy));
      const middle = ray.at * (ALONG - 1);
      const sigma = ray.wide * ALONG;
      const from = Math.max(0, Math.floor(middle - 3.5 * sigma));
      const to = Math.min(ALONG - 1, Math.ceil(middle + 3.5 * sigma));
      for (let i = from; i <= to; i++) {
        const d = (i - middle) / sigma;
        const g = Math.exp(-0.5 * d * d);
        bright[i] += lit * g;
        // a ray is as tall across most of its width, and tapers at its sides
        reach[i] = Math.max(reach[i], up * Math.sqrt(g));
      }
    }
    changed = Math.min(1, changed + dt / 4);
    const mix = changed * changed * (3 - 2 * changed);
    const full = curtainData[0];
    for (let i = 0; i < ALONG; i++) {
      if (mix < 1) {
        bright[i] = oldBright[i] + (bright[i] - oldBright[i]) * mix;
        reach[i] = oldReach[i] + (reach[i] - oldReach[i]) * mix;
      }
      // The veil: fine rays of its own, which shimmer along the curtain.
      const x = i / ALONG;
      const fine = 0.55 * weave(x * 150 + drift) + 0.45 * weave(x * 47 - 0.6 * drift + 100);
      full[i * 4] = Math.round(255 * Math.min(1, 0.62 * bright[i]));
      full[i * 4 + 1] = Math.round(255 * Math.min(1, reach[i]));
      full[i * 4 + 2] = Math.round(255 * (0.25 + 0.75 * fine * fine));
      full[i * 4 + 3] = 255;
    }
    curtainData.forEach((data, level) => {
      if (level > 0) {
        const finer = curtainData[level - 1];
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < 4; c++) data[i + c] = (finer[2 * i + c] + finer[2 * i + 4 + c] + 1) >> 1;
        }
      }
      device.queue.writeTexture({ texture: curtainTexture, mipLevel: level }, data, {}, [data.length / 4, 1]);
    });
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let gathered = null; // the picture the sheet is drawn into
  let showGroup = null;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the picture is drawn coarser until they are not. A
  // slow GPU gets a softer curtain, not a backlog.
  let busy = false;
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let slowness = 0; // smoothed seconds per frame
  let wave = Math.random() * 100;
  let glow = 0;

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, sharp);
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
        sampleCount: SAMPLES,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      showGroup = device.createBindGroup({
        layout: showLayout,
        entries: [{ binding: 0, resource: gathered.createView() }],
      });
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
      if (slowness > 0.045 && sharp > 0.75) {
        sharp = sharp > 1 ? 1 : 0.75;
        slowness = 0.03;
      }
    }
    fit();
    listen(time, dt);

    wave += dt * (0.1 + 0.35 * level);
    drift += dt * (0.5 + 2.5 * level);
    glow += ((hung.idle ? 0.5 : 1) - glow) * Math.min(1, dt * 0.8);
    hang(dt);

    // A window held upright is given less of the sky, so that the curtain
    // fills it; a wide one more, so that the hem stays clear of the words
    // at the foot of the page. The curtain is as long as the window is
    // wide, where it hangs.
    const aspect = width / height;
    const focal = 1.7 - 0.4 * Math.min(1, Math.max(0, (aspect - 0.6) / 0.4));
    const half = 0.92 * 3.0 * Math.max(1, aspect) / focal;
    uniformData.set([
      width, height, wave, half,
      glow, kick, 0.3 * Math.sin(0.37 * wave), focal,
    ], 0);
    // Every wave of the sheet comes round a whole number of times in
    // twenty pi, so the GPU is told where the waving is within that and
    // keeps its footing however long the page stays open.
    uniformData[2] = wave % (20 * Math.PI);
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
    draw.setBindGroup(1, curtainGroup);
    draw.draw(2 * (COLUMNS + 1));
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
