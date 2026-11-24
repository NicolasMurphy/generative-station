// "pool": the compound as sunlight on the floor of a pool (WebGPU).
//
// Light that falls through moving water is bent by it: under a crest the
// rays lean together and under a trough they lean apart, so the floor of a
// pool is covered in a net of bright lines that never keeps still. Here the
// water carries a ripple for every voiced peak of the compound's mass
// spectrum. The higher the peak, the finer its ripple, and the stronger
// the peak, the more its ripple bends the light. A ripple crosses the pool
// from several sides at once, as ripples on open water do, from more of
// them the stronger its peak. The net on the floor is what all the ripples
// do to the light together: wide where a compound's low peaks are strong,
// fine where its high ones are, and plain or tangled as the compound has
// few peaks or many.
//
// Nothing is drawn but the light itself. The sheet of light that enters the
// water is followed down, piece by piece, to where it lands, and is as
// bright there as it has been gathered: spread over more floor than it came
// through of surface it is dimmer, squeezed onto less it is brighter, and
// where the sheet folds over on itself the folds add up. The light is
// tinted by the ripples that are gathering it at that place, warm for the
// low peaks through green to blue for the high: the same order of colours
// as in the other visuals.
//
// Where the page can hear the stream, a ripple rises while there is energy
// around its peak, so the net is soft in quiet passages and drawn sharp in
// loud ones, the water moves faster the louder the stream is, and a kick
// tightens the whole net for a moment. Where it cannot (iOS gives a page no
// sound to look at for a live stream) a slow swell of its own does the
// same, as in "bloom". A new compound stills the water, and its ripples
// rise from the calm.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;
const SAMPLES = 4; // to a pixel, or the bright lines would be jagged

// Lengths are in floor units: the shorter side of the window is two.
const LONGEST = 1.0; // the ripple of a compound's lowest peak, crest to crest
const SHORTEST = 0.24; // and of its highest
const BEND = 0.95; // how strongly all the ripples together bend the light
const MARGIN = 0.3; // light from this far outside the window can land in it
const PIECE_PIXELS = 4.5; // the pieces the light is followed in: this many pixels across,
const PIECE_LEAST = 0.009; // and in floor units no smaller than this
const PIECE_MOST = 0.024; // nor larger, or the finest ripple would not fit in them
const MOST_SIDES = 6; // a strong peak's ripple crosses the pool from this many sides
const MAX_WAVES = 48; // all the ripples of all the peaks, at most

const SHADER = /* wgsl */ `
struct Wave {
  source: vec2f,   // where it comes from, well outside the window
  number: f32,     // crests to a floor unit, times two pi
  phase: f32,      // how far it has travelled, within one crest
  colour: vec3f,
  bend: f32,       // how much it bends the light
};

struct Uniforms {
  view: vec2f,     // the canvas, in pixels
  reach: vec2f,    // half the sheet of light that is followed down, in floor units
  cells: vec2f,    // the pieces it is followed in, across and down
  count: f32,      // ripples, counting each side a peak's ripple comes from
  glow: f32,
  waves: array<Wave, ${MAX_WAVES}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// ---- the light, followed down to the floor -----------------------------------

struct Piece {
  @builtin(position) pos: vec4f,
  @location(0) colour: vec3f,
  @location(1) spread: f32,  // the floor this light is spread over, to the surface it came through
};

@vertex
fn drawVertex(@builtin(vertex_index) vi: u32) -> Piece {
  // The corners of the sheet's pieces are counted along its rows.
  let across = u32(u.cells.x) + 1u;
  let corner = vec2f(f32(vi % across), f32(vi / across));
  let p = (2.0 * corner / u.cells - 1.0) * u.reach;

  // The slope of the water here, which is the way the light is bent; how
  // fast that slope changes from place to place, which is how much the light
  // is gathered or spread; and the colour of the ripples that gather it.
  var lean = vec2f(0.0);
  var xx = 0.0;
  var xy = 0.0;
  var yy = 0.0;
  var tint = vec3f(0.0);
  var share = 0.0;
  let count = u32(u.count);
  for (var k = 0u; k < count; k++) {
    let wave = u.waves[k];
    let off = p - wave.source;
    let far = length(off);
    let way = off / far;
    let at = wave.number * far - wave.phase;
    let slope = wave.bend / wave.number;
    let along = -wave.bend * sin(at);       // across the crests
    let beside = slope * cos(at) / far;     // along them: the crests are rings
    lean += slope * cos(at) * way;
    xx += along * way.x * way.x + beside * way.y * way.y;
    xy += (along - beside) * way.x * way.y;
    yy += along * way.y * way.y + beside * way.x * way.x;
    // Light is gathered under a crest.
    let crest = wave.bend * max(sin(at), 0.0);
    let weight = crest * crest * crest * crest * 40.0 + 0.0005;
    tint += weight * wave.colour;
    share += weight;
  }
  let lands = p + lean;

  // The window shows the floor: two units along its shorter side.
  let least = min(u.view.x, u.view.y);
  var out: Piece;
  out.pos = vec4f(lands * least / u.view, 0.0, 1.0);
  out.colour = tint / share;
  out.spread = (1.0 + xx) * (1.0 + yy) - xy * xy;
  return out;
}

@fragment
fn drawFragment(piece: Piece) -> @location(0) vec4f {
  // Light is as bright as it has been gathered: spread over half the
  // floor it came through of surface, it is twice as bright. Where the
  // sheet folds over, it is spread over none, and as bright as can be drawn.
  let gathered = 1.0 / max(abs(piece.spread), 1.0 / 60.0);
  return vec4f(piece.colour * gathered, 1.0);
}

// ---- the light that has landed, onto the page -------------------------------

@group(1) @binding(0) var landed: texture_multisampled_2d<f32>;

@vertex
fn showVertex(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

@fragment
fn showFragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
  // Still water lights the floor evenly and dimly. Gathered light is far
  // brighter than that, towards white and not past it. This is worked out
  // for each of a pixel's samples before they are put together: a line of
  // the net is far brighter than white, and put together first it would
  // stay white, and jagged.
  var lit = vec3f(0.0);
  for (var k = 0; k < ${SAMPLES}; k++) {
    let light = textureLoad(landed, vec2i(at.xy), k).rgb;
    lit += 1.0 - exp(-0.16 * u.glow * pow(light, vec3f(1.7)));
  }
  lit /= ${SAMPLES}.0;
  let page = vec3f(0.0667); // the page's #111
  return vec4f(page + (1.0 - page) * lit, 1.0);
}
`;

// ---- the ripples a compound sends across the pool ---------------------------------

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

// With no compound: three plain ripples, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 1, idle: true }, { f: 640, a: 1, idle: true }];
}

// Warm for the lowest, through green, to blue for the highest: the same
// order as in the other visuals.
function palette(h) {
  const t = Math.min(1, Math.max(0, h));
  const low = [1.0, 0.28, 0.12];
  const mid = [0.22, 1.0, 0.4];
  const high = [0.18, 0.4, 1.0];
  const [a, b, x] = t < 0.5 ? [low, mid, t * 2] : [mid, high, (t - 0.5) * 2];
  return a.map((v, i) => v + (b[i] - v) * x);
}

function describeWaves(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const strengths = peaks.map((p) => Math.sqrt(p.a));
  // A peak's ripple crosses the pool from several sides at once, as the
  // ripples of open water do: from more sides the stronger the peak, and
  // from fewer where there are so many peaks that the GPU could not follow
  // them all.
  let most = MOST_SIDES;
  let sides = [];
  do {
    sides = strengths.map((s) => Math.max(1, Math.min(most, Math.round(MOST_SIDES * s))));
    most -= 1;
  } while (most > 0 && sides.reduce((sum, n) => sum + n, 0) > MAX_WAVES);
  // The ripples share out the bending of the light by their peaks'
  // strength, so that a compound of many peaks does not throw a brighter
  // net than a compound of few, only a finer one.
  const whole = Math.sqrt(strengths.reduce((sum, s) => sum + s * s, 0));
  const waves = [];
  peaks.forEach((p, k) => {
    // the lowest peak has the longest ripple, the highest the shortest; a
    // lone peak one in between
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    const length = LONGEST * Math.pow(SHORTEST / LONGEST, x);
    const n = sides[k];
    for (let j = 0; j < n && waves.length < MAX_WAVES; j++) {
      // Numbers that are the same every time for this peak and this side,
      // and unlike its neighbours'.
      const a = fraction(k * 12.9898 + j * 78.233);
      const b = fraction(k * 39.3468 + j * 11.135);
      const c = fraction(k * 73.156 + j * 52.235);
      const number = (2 * Math.PI) / (length * (0.86 + 0.28 * a));
      waves.push({
        number,
        // The sides are spread round the pool, each peak's set turned a
        // golden angle on from the last one's, so that no two run alike.
        angle: 0.9 + k * 2.39996 + (j + 0.5 * (b - 0.5)) * ((2 * Math.PI) / n),
        distance: 1.5 + 1.2 * c,
        // Short ripples run slower than long ones, as they do on water.
        speed: 0.3 * Math.sqrt(number),
        phase: 2 * Math.PI * fraction(a + b + c),
        bend: (BEND * strengths[k]) / whole / Math.sqrt(n),
        colour: palette(x),
        band: bandOf(p.f),
      });
    }
  });
  return { idle: !!peaks[0].idle, waves };
}

function fraction(x) {
  const y = Math.sin(x) * 43758.5453;
  return y - Math.floor(y);
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

  const uniformData = new Float32Array(8 + 8 * MAX_WAVES);
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
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const showLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'unfilterable-float', multisampled: true },
    }],
  });
  // The light is added up in a picture of its own, which can hold more
  // than white, and brought onto the page from there.
  const LANDED = 'rgba16float';
  const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sharedLayout] }),
    vertex: { module, entryPoint: 'drawVertex' },
    fragment: {
      module,
      entryPoint: 'drawFragment',
      targets: [{ format: LANDED, blend: { color: additive, alpha: additive } }],
    },
    // Where the sheet has folded over, its pieces are seen from behind.
    primitive: { topology: 'triangle-list', cullMode: 'none' },
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

  // ---- the water follows the compound ----

  let water = describeWaves(null);
  let next = null; // the ripples of a compound that has come, while the old ones die down
  let shownKey = null;
  let rise = 0; // how far the ripples have risen from still water

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      if (shownKey === null) water = describeWaves(compound);
      else next = describeWaves(compound);
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
  let landed = null; // the picture the light is added up in
  let showGroup = null;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the picture is drawn coarser until they are not. A
  // slow GPU gets a softer net, not a backlog.
  let busy = false;
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let slowness = 0; // smoothed seconds per frame
  let run = Math.random() * 1000; // how long the water has been moving, in its own time
  let glow = 0;

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, sharp);
    const largest = device.limits.maxTextureDimension2D;
    const w = Math.min(largest, Math.max(1, Math.floor(canvas.clientWidth * ratio)));
    const h = Math.min(largest, Math.max(1, Math.floor(canvas.clientHeight * ratio)));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
      if (landed) landed.destroy();
      landed = device.createTexture({
        size: [w, h],
        format: LANDED,
        sampleCount: SAMPLES,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      showGroup = device.createBindGroup({
        layout: showLayout,
        entries: [{ binding: 0, resource: landed.createView() }],
      });
    }
  }

  // The sheet of light that is followed down reaches a little past the
  // window. It is followed in pieces a few pixels of a phone's screen
  // across: small enough for the finest ripple to bend, and for a line of
  // the net to run smoothly. A piece is two triangles, and the GPU is told
  // which corners each has, so that it works out where a corner's light
  // lands once and not for every triangle that meets there.
  let reachX = 1;
  let reachY = 1;
  let cols = 0;
  let rows = 0;
  let corners = null;

  function lay() {
    const least = Math.min(width, height);
    reachX = width / least + MARGIN;
    reachY = height / least + MARGIN;
    const across = Math.min(canvas.clientWidth, canvas.clientHeight) || least;
    const piece = Math.min(PIECE_MOST, Math.max(PIECE_LEAST, PIECE_PIXELS * 2 / across)) * (1.5 / sharp);
    const c = Math.ceil((2 * reachX) / piece);
    const r = Math.ceil((2 * reachY) / piece);
    if (c === cols && r === rows) return;
    cols = c;
    rows = r;
    const list = new Uint32Array(6 * cols * rows);
    let i = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const a = y * (cols + 1) + x;
        const b = a + cols + 1;
        list[i++] = a; list[i++] = a + 1; list[i++] = b;
        list[i++] = a + 1; list[i++] = b + 1; list[i++] = b;
      }
    }
    if (corners) corners.destroy();
    corners = device.createBuffer({ size: list.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(corners, 0, list);
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

    // A new compound: the water stills, and then its ripples rise.
    const passed = Math.min(0.25, Math.max(0.001, real)); // a slow GPU is not kept waiting
    if (next) {
      rise -= passed / 1.5;
      if (rise <= 0) {
        rise = 0;
        water = next;
        next = null;
      }
    } else {
      rise = Math.min(1, rise + passed / 3);
    }
    const risen = rise * rise * (3 - 2 * rise);
    run += dt * (0.4 + 1.1 * level);
    glow += ((water.idle ? 0.5 : 1) - glow) * Math.min(1, dt * 0.8);

    lay();
    // The ripples come from beyond the corners of the window.
    const corner = Math.hypot(width, height) / Math.min(width, height);

    uniformData.set([width, height, reachX, reachY, cols, rows, water.waves.length, glow], 0);
    water.waves.forEach((wave, k) => {
      const at = 8 + 8 * k;
      const far = wave.distance * corner;
      uniformData[at] = Math.cos(wave.angle) * far;
      uniformData[at + 1] = Math.sin(wave.angle) * far;
      uniformData[at + 2] = wave.number;
      // The GPU is told where the ripple is within one crest, and keeps its
      // footing however long the page stays open.
      uniformData[at + 3] = (wave.phase + wave.speed * run) % (2 * Math.PI);
      uniformData.set(wave.colour, at + 4);
      uniformData[at + 7] = wave.bend * risen * (0.55 + 1.3 * bandEnergy(wave.band)) * (1 + 0.25 * kick);
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const draw = encoder.beginRenderPass({
      colorAttachments: [{
        view: landed.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    draw.setPipeline(drawPipeline);
    draw.setBindGroup(0, sharedGroup);
    draw.setIndexBuffer(corners, 'uint32');
    draw.drawIndexed(6 * cols * rows);
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
  lay();
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
