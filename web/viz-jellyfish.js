// "jellyfish": the compound as jellyfish rising through dark water (WebGPU).
//
// A jellyfish swims by closing its bell. The bell draws in and lengthens,
// the water it held is pushed out behind, and the animal is carried forward
// by about its own width; then the bell opens again, slowly, while it
// glides, and its arms and tentacles, which were pulled out straight behind
// it, slacken and curl. A large one does this once in several seconds and a
// small one every second or two. In water with no light of its own it is
// seen by the light it gives: the thin wall of the bell, brightest where it
// is looked at edge on, the canals that run down it, the organs under the
// crown, and the rim.
//
// Here every voiced peak of the compound's mass spectrum is a kind of
// jellyfish: large and slow for the lowest peaks to small and quick for the
// highest, in the peak's colour (warm for the low peaks through green to
// blue for the high, the same order as in the other visuals), and more of
// them the stronger the peak. They rise through the picture, each on its
// own way, the further ones smaller, dimmer and less sharp, and one that
// has left at the top comes in again from below.
//
// Where the page can hear the stream, a kind swims a stroke when a note
// sounds around its peak's pitch, strokes more often while there is energy
// there and is lit more brightly, and a kick passes through all of them as
// a flicker. Where it cannot (iOS gives a page no sound to look at for a
// live stream) a slow swell of its own does the same, as in "bloom". A new
// compound's jellyfish take the place of the old, which fade into the
// water.
//
// Nothing is simulated on a grid and there are no textures: where each
// animal is and how far its bell is closed is worked out for a few dozen of
// them, and what one looks like is worked out where it is drawn.
//
// start(canvas, analyser, { getCompound, onLost }) draws until the returned
// stop() is called. It throws where WebGPU is not available.

const BANDS = 8; // log-spaced analyser bands, LOW_HZ .. LOW_HZ * SPAN
const LOW_HZ = 40;
const SPAN = 400;
const MAX_PEAKS = 32; // the station voices at most this many peaks too
const PEAK_FLOOR = 0.01;

// Lengths are in water units: the shorter side of the window is two.
const MAX_JELLIES = 48;
const LARGEST = 0.26; // the bell of the lowest peak's kind, from crown to rim,
const SMALLEST = 0.115; // and of the highest's
const SLOWEST = 5.2; // seconds between the strokes of the largest,
const QUICKEST = 1.9; // and of the smallest
const CLOSING = 0.2; // the share of a stroke in which the bell closes,
const OPEN_BY = 0.78; // and by which it is open again
const CARRIED = 1.25; // how far a stroke carries an animal, in bells
const HEARS = Math.pow(2, 1 / 3); // how far from its peak a kind hears, as a ratio
const LEAVING = 2.5; // seconds the old ones take to fade when a compound comes

// What is drawn of one animal, in bells from the middle of its bell's rim,
// lies in two boxes: one around the bell and the water it lights, and under
// it one around what trails behind, which leans the way that is swept.
const ABOVE = 1.5;
const WAIST = 0.85; // where the one box ends and the other begins
const BELOW = 5.1;
const BELL_WIDE = 1.45; // half the width of the upper box,
const TRAIL_WIDE = 1.25; // and of the lower
const SPREAD = 1.02; // how far from its middle what trails ever is

const SHADER = /* wgsl */ `
struct Jelly {
  a: vec4f,  // where it is (x, y), the size of its bell, which way it heads
  b: vec4f,  // how far the bell is closed, its peak's place from the lowest
             // (0) to the highest (1), how brightly it is lit, how far off it is
  c: vec4f,  // a number of its own, how its tentacles are swept aside, how
             // much of it is there yet, how fast it is going
};

struct Uniforms {
  view: vec2f,   // the canvas, in pixels
  pixel: f32,    // water units to a pixel
  time: f32,
  drift: vec2f,  // how far the water has carried what floats in it
  flare: f32,
  glow: f32,
  count: f32,
  level: f32,
  spare0: f32,
  spare1: f32,
  jellies: array<Jelly, ${MAX_JELLIES}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

fn hash2(p: vec2f) -> vec2f {
  var q = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

// Warm for the lowest peaks, through green, to blue for the highest.
fn palette(h: f32) -> vec3f {
  let t = clamp(h, 0.0, 1.0);
  let low = vec3f(1.0, 0.28, 0.12);
  let mid = vec3f(0.22, 1.0, 0.4);
  let high = vec3f(0.18, 0.4, 1.0);
  return select(mix(mid, high, (t - 0.5) * 2.0), mix(low, mid, t * 2.0), t < 0.5);
}

// ---- the water ----------------------------------------------------------------

@vertex
fn cover(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // one triangle that covers the canvas
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vi], 0.0, 1.0);
}

// What floats in the water: a speck to some of the squares of a grid, each
// stirring a little about its place.
fn specks(p: vec2f, square: f32, own: f32, soft: f32) -> f32 {
  let g = p / square;
  let id = floor(g);
  let h = hash2(id + own);
  let k = hash2(id * 1.7 + own + 9.1);
  if (k.x > 0.5) {
    return 0.0;
  }
  let stir = vec2f(sin(u.time * 0.31 + h.x * 40.0), cos(u.time * 0.23 + h.y * 40.0));
  let at = 0.25 + 0.5 * h + 0.07 * stir;
  let d = length(g - id - at) * square;
  let size = 0.003 + 0.005 * k.y;
  return (1.0 - smoothstep(0.3 * size, size + soft, d)) * (0.35 + 0.65 * k.y);
}

@fragment
fn waterFragment(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let down = at.y / u.view.y; // 0 at the top of the picture, 1 at its foot
  let p = (at.xy - 0.5 * u.view) * u.pixel;

  // Lighter and greener toward the top, where the day is, and all but black
  // below.
  var water = mix(vec3f(0.016, 0.052, 0.078), vec3f(0.012, 0.015, 0.027), smoothstep(0.0, 0.9, down));

  // The day comes down in a few broad shafts, which sway, and does not
  // reach far.
  let across = p.x + 0.42 * p.y;
  let shafts = sin(across * 2.1 + u.time * 0.07) + sin(across * 3.7 - u.time * 0.05 + 1.3)
    + sin(across * 6.3 + u.time * 0.09 + 4.0);
  let shaft = max(0.0, shafts) / 3.0;
  water += vec3f(0.035, 0.085, 0.1) * shaft * shaft * pow(max(0.0, 1.0 - 1.25 * down), 2.0)
    * (0.6 + 0.8 * u.level);

  // The nearer a speck the larger it is and the faster it goes by.
  var snow = 0.55 * specks(p + 0.5 * u.drift, 0.19, 3.0, u.pixel);
  snow += 0.8 * specks(p + u.drift, 0.31, 17.0, 1.5 * u.pixel);
  water += vec3f(0.3, 0.42, 0.46) * snow * (0.22 + 0.25 * u.flare) * u.glow;
  // So dark a wash would show as bands on a screen that has only so many
  // darks to show it with; a grain too fine to see breaks them up.
  water += (hash2(at.xy).x - 0.5) / 255.0;
  return vec4f(water, 1.0);
}

// ---- one jellyfish ---------------------------------------------------------------

struct Body {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) which: u32,
};

// How far aside something is swept that hangs this far under the rim:
// further the further down, but not without end.
fn asideAt(swept: f32, down: f32) -> f32 {
  return swept * down * down / (1.0 + 0.3 * down);
}

@vertex
fn jellyVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Body {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let j = u.jellies[ii];
  let c = corners[vi % 6u];
  var local = vec2f(c.x * ${BELL_WIDE}, mix(-${WAIST}, ${ABOVE}, c.y));
  if (vi >= 6u) {
    // the lower box: what trails is swept in a curve, which lies between
    // the box's leaning sides with a little to spare
    let down = mix(${BELOW}, ${WAIST}, c.y);
    local = vec2f(asideAt(j.c.y, down) + c.x * ${TRAIL_WIDE}, -down);
  }
  let up = vec2f(sin(j.a.w), cos(j.a.w));
  let right = vec2f(up.y, -up.x);
  let world = j.a.xy + j.a.z * (local.x * right + local.y * up);
  var body: Body;
  body.position = vec4f(world / (0.5 * u.view * u.pixel), 0.0, 1.0);
  body.local = local;
  body.which = ii;
  return body;
}

@fragment
fn jellyFragment(body: Body) -> @location(0) vec4f {
  let j = u.jellies[body.which];
  let closed = j.b.x;
  let far = j.b.w;
  let own = j.c.x;
  let swept = j.c.y;
  let there = j.c.z;
  let going = j.c.w;
  let x = body.local.x;
  let y = body.local.y;
  // A pixel, in bells; and how sharply this one is seen.
  let grain = u.pixel / j.a.z;
  let soft = grain * (1.0 + 5.0 * far);
  let aside = asideAt(swept, max(0.0, -y));
  if (y < -${WAIST} && abs(x - aside) > ${SPREAD}) {
    // nothing of it reaches here
    discard;
  }

  // The bell from the side: a dome over its rim, and under the rim a skirt
  // that flares while the bell is open and is drawn in as it closes.
  let wide = mix(1.0, 0.66, closed);
  let tall = mix(0.8, 1.08, closed);
  let skirt = 0.3;
  let below = clamp(-y / skirt, 0.0, 1.0);
  var half = wide * (1.0 + 0.1 * (1.0 - closed) * below - (0.08 + 0.34 * closed) * below * below);
  if (y > 0.0) {
    half = wide * sqrt(max(0.0, 1.0 - (y / tall) * (y / tall)));
  }
  // How far around the bell this place is, from one side to the other.
  let around = asin(clamp(x / max(half, 0.0001), -1.0, 1.0));
  let hem = -skirt * (1.0 + 0.09 * cos(around * 14.0 + own));

  // How far inside the bell's outline, and how nearly its wall faces us.
  var within = min(half - abs(x), y - hem);
  var facing = sqrt(max(0.0, 1.0 - (x / max(half, 0.0001)) * (x / max(half, 0.0001))));
  if (y > 0.0) {
    let e = 1.0 - (x / wide) * (x / wide) - (y / tall) * (y / tall);
    within = e / max(0.2, length(vec2f(2.0 * x / (wide * wide), 2.0 * y / (tall * tall))));
    facing = sqrt(max(0.0, e));
  }
  let bell = smoothstep(0.0, 1.5 * soft, within);
  // The water around a lit thing is lit by it, a little, and not far.
  let near = max(0.0, 1.0 + min(0.0, within) / 0.3);
  let halo = near * near * near * (1.0 - bell) * smoothstep(-${WAIST}, -0.35, y);

  var wall = 0.0;
  var heart = 0.0;
  if (bell > 0.0) {
    // A thin wall is brightest where it is seen edge on.
    let edge = pow(1.0 - facing, 2.0);
    // The canals that run from the crown to the rim.
    let canal = abs(fract(around * 8.0 / 3.14159265 + 0.5) - 0.5) * 2.0;
    let fine = 0.16 + 6.0 * soft;
    let lines = (1.0 - smoothstep(0.0, fine, canal)) * (0.3 + 0.7 * (1.0 - clamp(y / tall, 0.0, 1.0)));
    // The rim itself, which is thick.
    let over = (y - hem) / (0.05 + soft);
    let lip = exp(-over * over);
    wall = 0.06 + 0.9 * edge + 0.2 * lines + 0.55 * lip;
    // What light there is comes from above.
    wall *= 0.72 + 0.4 * clamp(y / tall, 0.0, 1.0);

    // The organs under the crown, four of them, which are what is lit.
    let hx = x / (0.56 * wide);
    let hy = (y - 0.3 * tall) / (0.25 * tall);
    let lobes = 0.55 + 0.45 * cos(4.0 * asin(clamp(0.85 * hx, -1.0, 1.0)) + own);
    heart = exp(-(1.3 * hx * hx + hy * hy)) * lobes;
  }

  // Under the bell. Everything that hangs there is swept the other way
  // when the animal turns, and waves less the faster it is pulled along.
  var arms = 0.0;
  var threads = 0.0;
  if (y < 0.3) {
    let slack = 1.0 - 0.6 * going;
    // The arms, from the middle: broad, frilled ribbons.
    for (var i = 0; i < 3; i++) {
      let n = f32(i);
      let turn = own * 7.0 + n * 2.4;
      let t = 0.25 - y;
      let reach = 1.5 + 0.5 * fract(own * 3.7 + n * 0.37);
      let along = t / reach;
      let hangs = (n - 1.0) * 0.2 * wide * (1.0 - 0.5 * along) + 0.6 * aside;
      if (t <= 0.0 || along >= 1.0 || abs(x - hangs) > 0.32 + soft) {
        continue;
      }
      let middle = hangs
        + (0.05 + 0.1 * slack) * along * sin(3.1 * t - 1.1 * u.time + turn);
      let broad = 0.1 * pow(1.0 - along, 1.2) * (1.0 + 0.35 * sin(11.0 * t + turn * 3.0 - 1.7 * u.time));
      let off = abs(x - middle);
      let ribbon = 1.0 - smoothstep(broad - soft, broad + soft, off);
      // a ribbon is brightest along its edges, where it is folded
      arms = max(arms, ribbon * (0.35 + 0.65 * pow(clamp(off / max(broad, 0.001), 0.0, 1.0), 2.0))
        * (1.0 - along) * smoothstep(0.0, 0.25, t));
    }
    // The tentacles, from the rim: threads.
    let thin = max(0.009, 0.65 * grain);
    for (var i = 0; i < 9; i++) {
      let n = f32(i);
      let turn = own * 13.0 + n * 1.7;
      let about = (n - 4.0) / 4.0 * 1.3; // where around the rim it hangs
      let t = -skirt - y;
      let reach = (3.1 + 1.6 * fract(own * 5.3 + n * 0.61)) * (0.86 + 0.14 * going);
      let along = t / reach;
      if (t <= 0.0 || along >= 1.0) {
        continue;
      }
      let root = wide * (1.0 - 0.3 * closed) * sin(about);
      let hangs = root * (1.0 - 0.3 * along) + aside;
      if (abs(x - hangs) > 0.3 + soft) {
        continue; // it never waves this far from where it hangs
      }
      let middle = hangs
        + (0.07 + 0.16 * slack) * along * sin(2.5 * t - 1.5 * u.time + turn)
        + 0.035 * along * sin(6.1 * t - 2.3 * u.time + turn * 2.0);
      let off = abs(x - middle);
      // The ones that hang from the sides of the rim are a little fainter,
      // and so is one that is not seen sharply.
      let thread = (1.0 - smoothstep(0.3 * thin, thin + soft, off)) * pow(1.0 - along, 1.2)
        * (0.5 + 0.5 * cos(about)) * smoothstep(0.0, 0.12, t) * sqrt(thin / (thin + soft));
      threads = max(threads, thread);
    }
  }

  let lamp = j.b.z;
  let colour = palette(j.b.y);
  let pale = mix(colour, vec3f(1.0, 0.97, 0.9), 0.5);
  var light = colour * wall * bell * (0.5 + 0.34 * lamp)
    + colour * halo * (0.035 + 0.075 * lamp)
    + pale * heart * bell * (0.12 + 0.7 * lamp)
    + mix(colour, pale, 0.35) * arms * (0.2 + 0.2 * lamp)
    + mix(colour, pale, 0.2) * threads * (0.3 + 0.24 * lamp);
  // Water takes the colour out of what is far off, and most of the light.
  let grey = dot3(light);
  light = mix(light, grey * vec3f(0.45, 0.75, 1.0), 0.55 * far) * (1.0 - 0.62 * far);
  light *= there * u.glow * (1.0 + 0.4 * u.flare);
  // What is behind an animal is seen through it, dimly.
  let hides = there * (0.42 * bell * (0.35 + 0.65 * (1.0 - facing)) + 0.3 * arms);
  return vec4f(vec3f(1.0) - exp(-1.9 * light), clamp(hides, 0.0, 1.0));
}

fn dot3(c: vec3f) -> f32 {
  return dot(c, vec3f(0.3, 0.55, 0.15));
}
`;

// ---- the jellyfish a compound has ------------------------------------------------

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

// With no compound: three plain kinds, dimly.
function idlePeaks() {
  return [{ f: 160, a: 1, idle: true }, { f: 320, a: 1, idle: true }, { f: 640, a: 1, idle: true }];
}

// What each peak's jellyfish are like, and how many of them it has.
function describeShoal(compound) {
  const peaks = voicedPeaks(compound) || idlePeaks();
  const logs = peaks.map((p) => Math.log(p.f));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo;
  const strengths = peaks.map((p) => Math.sqrt(p.a));
  const whole = strengths.reduce((sum, s) => sum + s, 0);
  // A compound of few peaks has fewer animals than one of many.
  const wanted = Math.min(MAX_JELLIES, Math.round(10 + 1.2 * peaks.length));
  const counts = strengths.map((s) => Math.max(1, Math.round((wanted * s) / whole)));
  for (;;) {
    const most = Math.max(...counts);
    if (counts.reduce((sum, n) => sum + n, 0) <= MAX_JELLIES || most <= 1) break;
    counts[counts.indexOf(most)] -= 1;
  }
  const kinds = peaks.map((p, k) => {
    // the lowest peak has the largest and slowest, the highest the smallest
    // and quickest; a lone peak ones in between
    const x = span > 0 ? (logs[k] - lo) / span : 0.5;
    return {
      hue: x,
      size: LARGEST * Math.pow(SMALLEST / LARGEST, x),
      period: SLOWEST * Math.pow(QUICKEST / SLOWEST, x),
      band: bandOf(p.f),
      low: p.f / HEARS, // what it listens to: a third of an octave
      high: p.f * HEARS, // either side of its peak
      count: counts[k],
      energy: 0, // of the stream around its peak, now,
      usual: -1, // and of late (not known yet)
      above: false, // there is more to hear there than of late,
      note: false, // and a note has only just begun
    };
  });
  return { idle: !!peaks[0].idle, kinds };
}

// The animals of a shoal, the furthest first, which is the order they are
// drawn in. Each is put somewhere in the picture, or under it.
function gather(shoal, reachX, reachY) {
  const jellies = [];
  shoal.kinds.forEach((kind, k) => {
    for (let n = 0; n < kind.count; n++) {
      const far = Math.random();
      const size = kind.size * (1 - 0.45 * far) * (0.85 + 0.3 * Math.random());
      const jelly = {
        kind: k,
        far,
        size,
        period: kind.period * (0.85 + 0.3 * Math.random()),
        own: Math.random() * 100,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        heading: 0,
        bound: 0, // the heading it is turning to,
        rebound: 0, // and when it next chooses another
        clock: Math.random(), // how far through a stroke it is, 0 to 1
        closed: 0,
        swept: 0,
        going: 0,
        there: 0,
        wait: 2.5 * Math.random(), // seconds until it begins to be seen
      };
      place(jelly, reachX, reachY, true);
      jellies.push(jelly);
    }
  });
  return jellies.sort((a, b) => b.far - a.far).slice(0, MAX_JELLIES);
}

function place(jelly, reachX, reachY, anywhere) {
  const side = Math.max(0.2, reachX - 0.6 * jelly.size);
  jelly.x = (2 * Math.random() - 1) * side;
  // Anywhere from the top of the picture to as far under it as an animal
  // is long; or, for one that has left at the top, just under it.
  jelly.y = anywhere
    ? reachY - Math.random() * (2 * reachY + BELOW * jelly.size)
    : -reachY - jelly.size * (ABOVE + 0.2 + 2 * Math.random());
  jelly.heading = 0.5 * (Math.random() - 0.5);
  jelly.bound = jelly.heading;
  jelly.vx = 0;
  jelly.vy = 0;
  jelly.swept = 0;
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

  const HEAD = 12; // numbers before the animals
  const EACH = 12; // numbers to an animal
  const uniformData = new Float32Array(HEAD + EACH * MAX_JELLIES);
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

  const layout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    }],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const waterPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'cover' },
    fragment: { module, entryPoint: 'waterFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  // An animal adds its light to what is behind it, and hides a little of it.
  const jellyPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'jellyVertex' },
    fragment: {
      module,
      entryPoint: 'jellyFragment',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const group = device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // ---- the shoal follows the compound ----

  let shoal = describeShoal(null);
  let next = null; // the shoal of a compound that has come, while the old one fades
  let shownKey = null;

  function followCompound() {
    const compound = getCompound();
    const key = compound
      ? [compound.name, compound.accession, compound.n_peaks, compound.frequencies && compound.frequencies[0]].join('|')
      : '';
    if (key !== shownKey) {
      if (shownKey === null) shoal = describeShoal(compound);
      else next = describeShoal(compound);
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
  let standIn = false; // nothing is heard, and a swell stands in for the stream

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
    standIn = silentFor > 2;
    if (standIn) {
      // No analyser data (iOS gives none for a live stream, and a paused
      // player gives silence): a slow swell takes the stream's place.
      for (let b = 0; b < BANDS; b++) {
        fresh[b] = 0.24 + 0.17 * Math.sin(time * (0.19 + 0.06 * b) + b * 1.9);
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

  // How loud the loudest thing to be heard between two pitches is, 0 to 1.
  // Not how much there is to hear there in all: a note is a narrow thing,
  // and would count for less the wider the stretch that is listened to,
  // which is wider the higher the peak.
  const ACROSS = 5; // analyser bins a note is taken to be wide
  function heardBetween(low, high) {
    const from = Math.min(spectrum.length - ACROSS, Math.max(1, Math.round((low / nyquist) * spectrum.length)));
    const to = Math.min(spectrum.length, Math.max(from + ACROSS, Math.round((high / nyquist) * spectrum.length)));
    let sum = 0;
    let most = 0;
    for (let i = from; i < to; i++) {
      sum += spectrum[i];
      if (i - from >= ACROSS) sum -= spectrum[i - ACROSS];
      if (i - from >= ACROSS - 1 && sum > most) most = sum;
    }
    return most / ACROSS / 255;
  }

  // Energy of the swell around a peak: 0 is the lowest band, 1 the highest.
  function bandEnergy(b) {
    const x = Math.min(1, Math.max(0, b)) * (BANDS - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, BANDS - 1);
    return bands[i] + (bands[j] - bands[i]) * (x - i);
  }

  // ---- the animals ----

  let jellies = [];
  let leaving = 0; // how far the old shoal has faded, when a new one has come
  let drift = [0, 0];

  // How far the bell is closed at each point of a stroke: closed quickly,
  // opened slowly, and then left open for a while.
  const ease = (x) => x * x * (3 - 2 * x);
  function bellAt(clock) {
    if (clock < CLOSING) return ease(clock / CLOSING);
    if (clock < OPEN_BY) return 1 - ease((clock - CLOSING) / (OPEN_BY - CLOSING));
    return 0;
  }

  function swim(jelly, dt, reachX, reachY) {
    const kind = shoal.kinds[jelly.kind];
    // A stroke begins when the last is over, sooner the more there is to
    // hear around its peak; and a note there begins one at once, if the
    // bell has opened again from the last.
    const before = jelly.clock;
    jelly.clock += (dt / jelly.period) * (0.75 + 1.3 * kind.energy);
    if (jelly.clock >= 1 || (kind.note && jelly.clock > 0.6)) jelly.clock = 0;
    jelly.closed = bellAt(jelly.clock);

    // Water holds a large animal back for longer than a small one, and the
    // push of a stroke is what carries it a bell and a quarter against that.
    const hold = 3.4 / jelly.period;
    if (jelly.clock < CLOSING && jelly.clock >= before) {
      const push = CARRIED * jelly.size * hold * (Math.PI / 2) * Math.sin((Math.PI * jelly.clock) / CLOSING);
      const share = (jelly.clock - before) / CLOSING;
      jelly.vx += push * share * Math.sin(jelly.heading);
      jelly.vy += push * share * Math.cos(jelly.heading);
    }
    const kept = Math.exp(-dt * hold);
    jelly.vx *= kept;
    jelly.vy = jelly.vy * kept - 0.06 * jelly.size * dt; // it sinks a little, between strokes
    jelly.x += jelly.vx * dt;
    jelly.y += jelly.vy * dt;
    jelly.going = Math.min(1, Math.hypot(jelly.vx, jelly.vy) / (CARRIED * jelly.size * hold));

    // It heads upward, more or less, changes its mind now and then, and
    // turns back from the sides of the picture.
    jelly.rebound -= dt;
    if (jelly.rebound <= 0) {
      jelly.rebound = 5 + 9 * Math.random();
      jelly.bound = 0.9 * (Math.random() - 0.5);
    }
    const side = Math.max(0.2, reachX - 0.5 * jelly.size);
    let bound = jelly.bound;
    if (Math.abs(jelly.x) > 0.7 * side) bound = -Math.sign(jelly.x) * 0.45;
    const turned = (bound - jelly.heading) * Math.min(1, dt * 0.35);
    jelly.heading += turned;
    // What trails behind it is left behind by a turn, and by a drift
    // sideways, and comes after slowly.
    const across = jelly.vx * Math.cos(jelly.heading) - jelly.vy * Math.sin(jelly.heading);
    const lag = Math.max(-0.1, Math.min(0.1, -0.09 * across / jelly.size - 0.9 * turned / dt));
    jelly.swept += (lag - jelly.swept) * Math.min(1, dt * 1.2);

    if (jelly.wait > 0) jelly.wait -= dt;
    else jelly.there = Math.min(1, jelly.there + dt / 3);

    // One that has gone out at the top, all of it, comes in again below.
    if (jelly.y - BELOW * jelly.size > reachY) place(jelly, reachX, reachY, false);
  }

  // ---- frame loop ----

  let last = 0;
  let width = 0;
  let height = 0;
  let reachX = 1; // half the window, in water units
  let reachY = 1;
  // A frame is only started once the GPU has finished the previous one, and
  // if frames stay slow the picture is drawn coarser until they are not.
  let busy = false;
  let sharp = 1.5; // canvas pixels to a CSS pixel, at most
  let slowness = 0; // smoothed seconds per frame
  let glow = 0;

  function fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, sharp);
    const largest = device.limits.maxTextureDimension2D;
    const w = Math.min(largest, Math.max(1, Math.floor(canvas.clientWidth * ratio)));
    const h = Math.min(largest, Math.max(1, Math.floor(canvas.clientHeight * ratio)));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
      const least = Math.min(w, h);
      // A window that changes its shape, as a phone's does when it is
      // turned, keeps its animals, each as far across it and up it as it was.
      for (const jelly of jellies) {
        jelly.x *= w / least / reachX;
        jelly.y *= h / least / reachY;
      }
      reachX = w / least;
      reachY = h / least;
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

    // A note has begun around a peak when there is suddenly more to hear
    // there than there has been. Each kind listens around its own peak, more
    // closely than the bands do, so that two kinds whose peaks are not far
    // apart do not always move as one. The swell that stands in for a
    // stream has no notes in it.
    for (const kind of shoal.kinds) {
      let energy = bandEnergy(kind.band);
      if (!standIn) {
        const fresh = heardBetween(kind.low, kind.high);
        const rate = fresh > kind.energy ? 18 : 3; // quick to rise, slow to fall
        energy = kind.energy + (fresh - kind.energy) * Math.min(1, dt * rate);
      }
      if (standIn || kind.usual < 0) kind.usual = energy;
      const above = energy - kind.usual > 0.07;
      kind.note = above && !kind.above;
      kind.above = above;
      kind.energy = energy;
      kind.usual += (energy - kind.usual) * Math.min(1, dt * 1.6);
    }

    // The old shoal fades into the water, and the new one is there instead.
    if (next) {
      leaving = Math.min(1, leaving + dt / LEAVING);
      if (leaving >= 1) {
        shoal = next;
        next = null;
        leaving = 0;
        jellies = gather(shoal, reachX, reachY);
      }
    }
    for (const jelly of jellies) swim(jelly, dt, reachX, reachY);
    glow += ((shoal.idle ? 0.5 : 1) - glow) * Math.min(1, dt * 0.8);
    // What floats in the water sinks, and is carried a little faster by a
    // louder stream.
    drift[0] += dt * 0.006 * Math.sin(time * 0.05);
    drift[1] -= dt * (0.012 + 0.03 * level);

    uniformData.set([width, height, 2 / Math.min(width, height), time % 3600,
      drift[0], drift[1], kick, glow, jellies.length, level, 0, 0], 0);
    jellies.forEach((jelly, k) => {
      const kind = shoal.kinds[jelly.kind];
      const at = HEAD + EACH * k;
      uniformData[at] = jelly.x;
      uniformData[at + 1] = jelly.y;
      uniformData[at + 2] = jelly.size;
      uniformData[at + 3] = jelly.heading;
      uniformData[at + 4] = jelly.closed;
      uniformData[at + 5] = kind.hue;
      // Lit by what there is to hear around its peak, and by its own stroke.
      uniformData[at + 6] = 0.3 + kind.energy + 0.35 * jelly.closed;
      uniformData[at + 7] = jelly.far;
      uniformData[at + 8] = jelly.own;
      uniformData[at + 9] = jelly.swept;
      uniformData[at + 10] = jelly.there * (1 - leaving);
      uniformData[at + 11] = jelly.going;
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

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
    pass.setPipeline(waterPipeline);
    pass.draw(3);
    if (jellies.length) {
      pass.setPipeline(jellyPipeline);
      pass.draw(12, jellies.length);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    const done = () => { busy = false; };
    device.queue.onSubmittedWorkDone().then(done, done);
  }
  fit();
  jellies = gather(shoal, reachX, reachY);
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
