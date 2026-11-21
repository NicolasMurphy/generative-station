// "rings": eight rings of spectrum bars drawn with three.js (WebGL). The
// station's first visual, and the fallback where WebGPU is not available.
//
// start(canvas, analyser) draws until the returned stop() is called.
export async function start(canvas, analyser) {
  const THREE = await import('three');
  let running = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.z = 4;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const ringCount = 8;
  const barsPerRing = 24;
  const ringRadius = 1.4;
  const ringDepth = 0.35;
  const maxBarHeight = 1.3;
  const baseScale = 0.95;
  const tubeRadius = 0.3;

  const thetaCos = new Float32Array(barsPerRing);
  const thetaSin = new Float32Array(barsPerRing);
  for (let i = 0; i < barsPerRing; i++) {
    const angle = (i / barsPerRing) * Math.PI * 2;
    thetaCos[i] = Math.cos(angle);
    thetaSin[i] = Math.sin(angle);
  }

  const group = new THREE.Group();
  group.scale.setScalar(baseScale);
  scene.add(group);

  const rings = [];
  const ringGroups = [];
  const ringValues = [];

  const upY = new THREE.Vector3(0, 1, 0);
  const outward = new THREE.Vector3();

  // One box shared by all 192 bars; each bar only differs in its material
  // and transform.
  const barGeometry = new THREE.BoxGeometry(0.07, 1, 0.07);
  barGeometry.translate(0, 0.5, 0);

  for (let r = 0; r < ringCount; r++) {
    const ringGroup = new THREE.Group();
    ringGroup.position.z = -r * ringDepth;
    group.add(ringGroup);
    ringGroups.push(ringGroup);

    const ringBars = [];
    const fade = 1 - (r / ringCount) * 0.65;

    for (let i = 0; i < barsPerRing; i++) {
      const t = i / (barsPerRing - 1);
      const color = new THREE.Color();
      if (t < 0.5) color.setRGB(1 - t * 2, t * 2, 0);
      else color.setRGB(0, 1 - (t - 0.5) * 2, (t - 0.5) * 2);
      const bar = new THREE.Mesh(
        barGeometry,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.5 * fade,
        }),
      );

      bar.scale.y = 0.001;
      ringGroup.add(bar);
      ringBars.push(bar);
    }
    rings.push(ringBars);
    ringValues.push(new Float32Array(barsPerRing));
  }

  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const minBin = 2;
  const maxBin = Math.min(freqData.length, 850);
  const linearCount = 10;
  const linearEnd = minBin + linearCount;
  const barBinStart = new Int32Array(barsPerRing + 1);
  for (let i = 0; i <= linearCount; i++) {
    barBinStart[i] = minBin + i;
  }
  const logMin = Math.log(linearEnd);
  const logMax = Math.log(maxBin);
  for (let i = linearCount + 1; i <= barsPerRing; i++) {
    const t = (i - linearCount) / (barsPerRing - linearCount);
    const ideal = Math.floor(Math.exp(logMin + (logMax - logMin) * t));
    barBinStart[i] = Math.max(barBinStart[i - 1] + 1, ideal);
  }

  const targetValues = new Float32Array(barsPerRing);

  const fadeScene = new THREE.Scene();
  const fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fadeQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
      depthTest: false,
    }),
  );
  fadeScene.add(fadeQuad);
  renderer.autoClear = false;

  let shiftAccum = 0;

  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    analyser.getByteFrequencyData(freqData);

    for (let i = 0; i < barsPerRing; i++) {
      const b0 = barBinStart[i];
      const b1 = barBinStart[i + 1];
      let sum = 0;
      for (let j = b0; j < b1; j++) sum += freqData[j];
      const avg = sum / (b1 - b0) / 255;
      targetValues[i] = Math.log(avg + 1) / Math.log(2);
    }

    const ring0 = ringValues[0];
    for (let i = 0; i < barsPerRing; i++) {
      if (targetValues[i] > ring0[i]) ring0[i] = targetValues[i];
      else ring0[i] += (targetValues[i] - ring0[i]) * 0.1;
    }

    shiftAccum++;
    if (shiftAccum >= 5) {
      shiftAccum = 0;
      for (let r = ringCount - 1; r > 0; r--) {
        const dst = ringValues[r];
        const src = ringValues[r - 1];
        for (let i = 0; i < barsPerRing; i++) dst[i] = src[i];
      }
    }

    const tNow = performance.now();

    for (let r = 0; r < ringCount; r++) {
      const vals = ringValues[r];
      const ringBars = rings[r];
      const phiDir = r % 2 === 0 ? 1 : -1;
      const phi = tNow * (0.00035 + r * 0.00006) * phiDir;
      const cosPh = Math.cos(phi);
      const sinPh = Math.sin(phi);
      const Rcp = ringRadius + tubeRadius * cosPh;
      const zr = tubeRadius * sinPh;
      for (let i = 0; i < barsPerRing; i++) {
        const cosTh = thetaCos[i];
        const sinTh = thetaSin[i];
        ringBars[i].position.set(Rcp * cosTh, Rcp * sinTh, zr);
        outward.set(cosPh * cosTh, cosPh * sinTh, sinPh);
        ringBars[i].quaternion.setFromUnitVectors(upY, outward);
        ringBars[i].scale.y = Math.max(0.001, vals[i] * maxBarHeight);
      }
    }

    for (let r = 0; r < ringCount; r++) {
      const dirSign = r % 2 === 0 ? 1 : -1;
      ringGroups[r].rotation.z = tNow * (0.00006 + r * 0.000045) * dirSign;
    }

    const orbitAngle = tNow * 0.00009;
    const elevation = Math.sin(tNow * 0.000055) * 0.65;
    const orbitRadius = 5;
    const tunnelCenterZ = -((ringCount - 1) * ringDepth) / 2;
    const cosEl = Math.cos(elevation);
    camera.position.x = Math.sin(orbitAngle) * orbitRadius * cosEl;
    camera.position.z = tunnelCenterZ + Math.cos(orbitAngle) * orbitRadius * cosEl;
    camera.position.y = Math.sin(elevation) * orbitRadius;
    camera.lookAt(0, 0, tunnelCenterZ);

    renderer.clearDepth();
    renderer.render(fadeScene, fadeCamera);
    renderer.render(scene, camera);
  }
  animate();

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', onResize);

  return {
    stop() {
      running = false;
      window.removeEventListener('resize', onResize);
      renderer.dispose();
    },
  };
}
