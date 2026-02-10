// main.js
// Single-file main, preserves your scene/planes layout and adds:
// - stitched-LCR-final.mp4 video (one wide video split into three video textures)
// - 5p1.m4a (6-channel AAC): channels L,R,C,LFE,SL,SR -> spatialized via WebAudio ChannelSplitter + PannerNodes
// - Debug overlay (shows planesFound, mediaReady, playing, video/audio time, cine.glb loaded, current fragment)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

let camera, scene, renderer, controls;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let velocity = new THREE.Vector3();
let direction = new THREE.Vector3();
let terrain;
let raycaster = new THREE.Raycaster();

// --- DEBUG STATE ---
let debugModelLoaded = false;
let debugCurrentFragment = 0;  // 0 = none selected

const clock = new THREE.Clock();

/* -----------------------------
   Configuration / filenames
   ----------------------------- */
const STITCHED_VIDEO = 'stitched-LCR-final.mp4';
const MULTI_AUDIO = '5p1.m4a'; // single 6-channel AAC: L, R, C, LFE, SL, SR (in that order)

const AUDIO_POSITIONS = {
  L:  new THREE.Vector3(12, 7, 5),
  R:  new THREE.Vector3(-12, 7, 5),
  C:  new THREE.Vector3(0.2, 7.4, 5.0),
  LFE:new THREE.Vector3(0.2, 3.0, 5.0), // LFE will be lowpassed & mixed (non-positional)
  SL: new THREE.Vector3(14, 9, -12),
  SR: new THREE.Vector3(-14, 9, -12)
};

// chapter times (seconds)
const CHAPTERS = [
  0,
  32,        // 0:00:32
  7*60+4,    // 0:07:04
  17*60+19,  // 0:17:19
  28*60+17,  // 0:28:17
  32*60+29,  // 0:32:29
  44*60+9,   // 0:44:09
  54*60+17   // 0:54:17
];

/* -----------------------------
   State variables
   ----------------------------- */
let planesFound = false;
let foundPlanes = { center: null, left: null, right: null };

let videoElem = null;
let videoTextures = { left: null, center: null, right: null };

let listener = null;
let mediaElementSource = null;
let splitter = null;
let pannerNodes = {};   // per channel panner node (L,R,C,SL,SR)
let gainNodes = {};     // per channel gain node
let lfeNode = null;     // lowpass for LFE
let audioElem = null;   // the single HTMLAudioElement for 5p1.m4a

let mediaReady = false;
let playing = false;
let firstAttachDone = false;

/* -----------------------------
   Debug overlay
   ----------------------------- */
let debugDiv = null;
function createDebugOverlay() {
  if (debugDiv) return;
  debugDiv = document.createElement('div');
  debugDiv.style.position = 'fixed';
  debugDiv.style.left = '20px';
  debugDiv.style.top = '20px';
  debugDiv.style.padding = '8px 10px';
  debugDiv.style.background = 'rgba(0,0,0,0.6)';
  debugDiv.style.color = '#fff';
  debugDiv.style.fontFamily = 'monospace';
  debugDiv.style.fontSize = '12px';
  debugDiv.style.borderRadius = '6px';
  debugDiv.style.zIndex = '99999';
  debugDiv.style.pointerEvents = 'none';
  document.body.appendChild(debugDiv);
}
function updateDebugOverlay() {
  if (!debugDiv) return;
  const vTime = (videoElem && !isNaN(videoElem.currentTime)) ? videoElem.currentTime.toFixed(3) : '—';
  const aTime = (audioElem && !isNaN(audioElem.currentTime)) ? audioElem.currentTime.toFixed(3) : '—';
  debugDiv.innerHTML =
    `planesFound: <b>${planesFound}</b><br>` +
    `mediaReady: <b>${mediaReady}</b> playing: <b>${playing}</b><br>` +
    `video: <b>${vTime}s</b> audio: <b>${aTime}s</b><br>` +
    `cine.glb loaded: <b>${debugModelLoaded}</b><br>` +
    `current fragment: <b>${debugCurrentFragment}</b>`;
}

/* -----------------------------
   Init / animate (your original scene + planes)
   ----------------------------- */

init();
animate();

function init() {

    // === SCENE ===
    scene = new THREE.Scene();

    // create debug overlay as early as possible
    createDebugOverlay();

    // === EQUIRECTANGULAR BACKGROUND ===
    const bgTexture = new THREE.TextureLoader().load('bgeq.jpg', () => {
        bgTexture.mapping = THREE.EquirectangularReflectionMapping;
  bgTexture.colorSpace = THREE.SRGBColorSpace;

        scene.background = bgTexture;
        scene.environment = bgTexture;
    });

    // === CAMERA ===
    camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 5000);
    camera.position.set(0, 2, 0);

    // === RENDERER ===
renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);

renderer.outputColorSpace = THREE.SRGBColorSpace;

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

    // === LOAD SCENE MODEL ===
    const loader = new GLTFLoader();
    loader.load(
        'https://acousticheritagecollective.org/narrowbackroads3d/cine.glb',
        (gltf) => {
            terrain = gltf.scene;
            terrain.traverse((child) => {
                if (child.isMesh) child.receiveShadow = true;
            });
            scene.add(terrain);
            console.log('cine.glb added to scene.');
            debugModelLoaded = true;
        },
        undefined,
        (err) => {
            console.error('Error loading cine.glb', err);
        }
    );

    // ============================================================
    // ==============   SCREENX 3-PANELED CINEMA   ================
    // ============================================================

    const screenWidth = 21;   // your required geometry size
    const screenHeight = 12;

    // Center screen position (your values)
    const cx = -0.2;
    const cy = 7.4;
    const cz = 5;

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load('cover.jpg', (texture) => {

        // === CENTER PLANE ===
        const centerGeo = new THREE.PlaneGeometry(screenWidth, screenHeight);
        const centerMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const centerPlane = new THREE.Mesh(centerGeo, centerMat);
        centerPlane.position.set(cx, cy, cz);
        centerPlane.rotation.y = Math.PI; // face the audience
        scene.add(centerPlane);

        // === ANGLES ===
        const angle = THREE.MathUtils.degToRad(77);

        // horizontal offset so the inner edges touch the center plane
        const offset = screenWidth * 0.5;  

        // === LEFT PLANE ===
        const leftPlane = new THREE.Mesh(centerGeo, centerMat.clone());
        leftPlane.position.set(cx + offset + 3, cy, cz - offset);
        leftPlane.rotation.y = Math.PI + angle;
        scene.add(leftPlane);

        // === RIGHT PLANE ===
        const rightPlane = new THREE.Mesh(centerGeo, centerMat.clone());
        rightPlane.position.set(cx - offset - 3, cy, cz - offset);
        rightPlane.rotation.y = Math.PI - angle;
        scene.add(rightPlane);

        console.log('cover planes added.');
    });

    // === CONTROLS ===
    controls = new PointerLockControls(camera, document.body);
    scene.add(controls.getObject());

    document.body.addEventListener('click', () => {
        if (!controls.isLocked) controls.lock();
    });

    // === MOVEMENT KEYS ===
    const onKeyDown = (event) => {
        switch (event.code) {
            case 'KeyW':
            case 'ArrowUp': moveForward = true; break;
            case 'KeyA':
            case 'ArrowLeft': moveLeft = true; break;
            case 'KeyS':
            case 'ArrowDown': moveBackward = true; break;
            case 'KeyD':
            case 'ArrowRight': moveRight = true; break;
        }
    };

    const onKeyUp = (event) => {
        switch (event.code) {
            case 'KeyW':
            case 'ArrowUp': moveForward = false; break;
            case 'KeyA':
            case 'ArrowLeft': moveLeft = false; break;
            case 'KeyS':
            case 'ArrowDown': moveBackward = false; break;
            case 'KeyD':
            case 'ArrowRight': moveRight = false; break;
        }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onWindowResize);

    // === LOGO ===
    const logo = document.createElement('img');
    logo.src = 'Logo.png';
    logo.style.position = 'fixed';
    logo.style.top = '20px';
    logo.style.right = '20px';
    logo.style.opacity = '0.9';
    logo.style.zIndex = '10';
    logo.style.pointerEvents = 'none';
    logo.style.width = '140px';
    document.body.appendChild(logo);

    // start polling for planes & set up media once found
    waitForPlanesAndSetup();
}

/* -----------------------------
   Window resize / animate
   ----------------------------- */

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const speed = 20.0;

  velocity.x -= velocity.x * 10.0 * delta;
  velocity.z -= velocity.z * 10.0 * delta;

  direction.z = Number(moveForward) - Number(moveBackward);
  direction.x = Number(moveRight) - Number(moveLeft);
  direction.normalize();

  if (moveForward || moveBackward) velocity.z -= direction.z * speed * delta;
  if (moveLeft || moveRight) velocity.x -= direction.x * speed * delta;

  controls.moveRight(-velocity.x * delta);
  controls.moveForward(-velocity.z * delta);

  // === FOLLOW TERRAIN ===
  if (terrain) {
      raycaster.set(camera.position, new THREE.Vector3(0, -1, 0));
      const intersects = raycaster.intersectObject(terrain, true);
      if (intersects.length > 0) {
          const targetY = intersects[0].point.y + 2.3;
          const currentY = controls.getObject().position.y;
          controls.getObject().position.y += (targetY - currentY) * 0.1;
      }
  }

  // Update panner positions each frame to match AUDIO_POSITIONS
  if (pannerNodes && Object.keys(pannerNodes).length) {
    ['L','R','C','SL','SR'].forEach((k) => {
      const node = pannerNodes[k];
      const pos = AUDIO_POSITIONS[k];
      if (!node || !pos) return;
      try {
        if (node.positionX) {
          node.positionX.setValueAtTime(pos.x, listener.context.currentTime);
          node.positionY.setValueAtTime(pos.y, listener.context.currentTime);
          node.positionZ.setValueAtTime(pos.z, listener.context.currentTime);
        } else if (typeof node.setPosition === 'function') {
          node.setPosition(pos.x, pos.y, pos.z);
        }
      } catch (e) {
        // ignore; older browsers may not support AudioParam setValueAtTime
        if (typeof node.setPosition === 'function') node.setPosition(pos.x, pos.y, pos.z);
      }
    });
  }

  // update debug overlay each frame
  updateDebugOverlay();

  renderer.render(scene, camera);
}

/* -----------------------------
   Plane detection & media setup
   ----------------------------- */

function findPlaneNear(pos, tolerance = 0.8) {
  for (let i = 0; i < scene.children.length; i++) {
    const c = scene.children[i];
    if (! (c && c.isMesh && c.geometry && c.geometry.type && c.geometry.type.includes('Plane')) ) continue;
    const d = c.position.distanceTo(pos);
    if (d <= tolerance) return c;
  }
  return null;
}

function waitForPlanesAndSetup() {
  (function poll() {
    const cx = -0.2, cy = 7.4, cz = 5;
    const screenWidth = 21;
    const offset = screenWidth * 0.5;

    const expectedCenterPos = new THREE.Vector3(cx, cy, cz);
    const expectedLeftPos   = new THREE.Vector3(cx + offset + 3, cy, cz - offset);
    const expectedRightPos  = new THREE.Vector3(cx - offset - 3, cy, cz - offset);

    const c = findPlaneNear(expectedCenterPos, 0.9);
    const l = findPlaneNear(expectedLeftPos, 1.6);
    const r = findPlaneNear(expectedRightPos, 1.6);

    if (c && l && r) {
      foundPlanes.center = c;
      foundPlanes.left = l;
      foundPlanes.right = r;
      planesFound = true;
      console.log('Found center/left/right planes:', c.position, l.position, r.position);
      // attach video textures + setup audio
      setupAllMediaFlow();
      return;
    }
    requestAnimationFrame(poll);
  })();
}

/* -----------------------------
   Create video element and textures (single stitched video)
   ----------------------------- */
function createAndPrepareVideo() {
  if (videoElem) return;
  videoElem = document.createElement('video');
  videoElem.src = STITCHED_VIDEO;
  videoElem.crossOrigin = 'anonymous';
  videoElem.muted = true; // we use separate audio file for sound
  videoElem.playsInline = true;
  videoElem.preload = 'auto';
  videoElem.style.display = 'none';
  document.body.appendChild(videoElem);

  const baseTex = new THREE.VideoTexture(videoElem);
  baseTex.minFilter = THREE.LinearFilter;
  baseTex.magFilter = THREE.LinearFilter;
  baseTex.format = THREE.RGBAFormat;
  baseTex.generateMipmaps = false;

  // left/center/right thirds
  const texL = baseTex.clone();
  texL.repeat.set(1 / 3, 1);
  texL.offset.set(0, 0);

  const texC = baseTex.clone();
  texC.repeat.set(1 / 3, 1);
  texC.offset.set(1 / 3, 0);

  const texR = baseTex.clone();
  texR.repeat.set(1 / 3, 1);
  texR.offset.set(2 / 3, 0);

  videoTextures.left = texL;
  videoTextures.center = texC;
  videoTextures.right = texR;

  console.log('Video element and 3 video textures created (muted video).');

  // Small safety: if video stalls often, try setting preload='auto' and small playbackRate tweak later
}

/* -----------------------------
   Audio — single multichannel file -> ChannelSplitter -> Panners
   ----------------------------- */

function ensureListener() {
  if (listener) return;
  listener = new THREE.AudioListener();
  if (camera) camera.add(listener);
  else console.warn('Camera is not available to attach listener yet.');
}

function setupMultichannelAudio() {
  ensureListener();

  if (audioElem) return; // already created

  audioElem = document.createElement('audio');
  audioElem.src = MULTI_AUDIO;
  audioElem.crossOrigin = 'anonymous';
  audioElem.preload = 'auto';
  audioElem.loop = false;
  audioElem.muted = false;
  audioElem.style.display = 'none';
  document.body.appendChild(audioElem);

  const ctx = listener.context;

  // Create MediaElementSource and ChannelSplitter(6)
  try {
    mediaElementSource = ctx.createMediaElementSource(audioElem);
  } catch (e) {
    console.error('Failed to create mediaElementSource:', e);
    return;
  }

  splitter = ctx.createChannelSplitter(6);

  mediaElementSource.connect(splitter);

  // Channel order expected in file: 0:L, 1:R, 2:C, 3:LFE, 4:SL, 5:SR
  const channelKeys = ['L','R','C','LFE','SL','SR'];

  channelKeys.forEach((k, idx) => {
    const g = ctx.createGain();
    g.gain.value = 1.0;
    gainNodes[k] = g;

    if (k === 'LFE') {
      // LFE: lowpass and connect to destination (non-positional)
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 120;
      lfeNode = lowpass;
      try {
        splitter.connect(g, idx);
        g.connect(lowpass);
        lowpass.connect(ctx.destination);
      } catch (err) {
        console.warn('Failed to wire LFE chain:', err);
      }
      return;
    }

    // create panner node for spatialisation
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 6;
    panner.maxDistance = 100;
    panner.rolloffFactor = 1.6;

    // set initial position from AUDIO_POSITIONS if available
    if (AUDIO_POSITIONS[k]) {
      try {
        if (panner.positionX) {
          panner.positionX.value = AUDIO_POSITIONS[k].x;
          panner.positionY.value = AUDIO_POSITIONS[k].y;
          panner.positionZ.value = AUDIO_POSITIONS[k].z;
        } else if (typeof panner.setPosition === 'function') {
          panner.setPosition(AUDIO_POSITIONS[k].x, AUDIO_POSITIONS[k].y, AUDIO_POSITIONS[k].z);
        }
      } catch (e) { /* ignore */ }
    }

    try {
      splitter.connect(g, idx);
      g.connect(panner);
      panner.connect(ctx.destination);
    } catch (err) {
      console.warn('Failed to connect splitter->gain->panner for', k, err);
    }

    pannerNodes[k] = panner;
  });

  console.log('Multichannel audio pipeline created (splitter + panners).');
}

/* -----------------------------
   Attach video textures to meshes
   ----------------------------- */
function attachVideoTexturesToPlanes() {
  if (!planesFound) return;
  try {
    if (foundPlanes.center && videoTextures.center) {
      foundPlanes.center.material.map = videoTextures.center;
      foundPlanes.center.material.needsUpdate = true;
    }
    if (foundPlanes.left && videoTextures.left) {
      foundPlanes.left.material.map = videoTextures.left;
      foundPlanes.left.material.needsUpdate = true;
    }
    if (foundPlanes.right && videoTextures.right) {
      foundPlanes.right.material.map = videoTextures.right;
      foundPlanes.right.material.needsUpdate = true;
    }
    console.log('Video textures attached to planes.');
  } catch (e) {
    console.warn('attachVideoTexturesToPlanes error', e);
  }
}

/* -----------------------------
   Full setup sequence (called once planes found)
   ----------------------------- */
function setupAllMediaFlow() {
  if (mediaReady) return;
  ensureListener();
  createAndPrepareVideo();
  setupMultichannelAudio();

  // attach textures now (they'll show when the video plays)
  attachVideoTexturesToPlanes();

  // Wait for readiness: video canplay + audio loadedmetadata
  let videoReady = false;
  let audioMetaReady = false;

  function tryReady() {
    if (videoReady && audioMetaReady) {
      mediaReady = true;
      console.log('Media READY: video + audio metadata present.');
    }
  }

  if (videoElem.readyState >= 2) videoReady = true;
  else videoElem.addEventListener('canplay', () => { videoReady = true; tryReady(); }, { once: true });

  // audio element metadata
  audioElem.addEventListener('loadedmetadata', () => { audioMetaReady = true; tryReady(); }, { once: true });
  audioElem.addEventListener('error', (e) => {
    console.warn('audioElem load error', e);
    audioMetaReady = true; // allow progression even on minor errors
    tryReady();
  }, { once: true });

  // safety fallback: after 10s consider ready anyway
  setTimeout(() => {
    if (!mediaReady) {
      mediaReady = !!(videoElem && audioElem);
      console.warn('Media not fully reported ready but forcing mediaReady =', mediaReady);
    }
  }, 10000);

  console.log('setupAllMediaFlow: waiting for canplay & metadata...');
}

/* -----------------------------
   Play / Pause / Seek
   ----------------------------- */

async function resumeAudioContext() {
  if (!listener || !listener.context) return;
  const ctx = listener.context;
  if (ctx.state === 'running') return;
  try {
    await ctx.resume();
    console.log('AudioContext resumed');
  } catch(e) {
    console.warn('AudioContext resume failed', e);
  }
}

async function togglePlayPauseAll() {
  if (!mediaReady) {
    console.warn('Media not ready; ignoring play request.');
    return;
  }

  await resumeAudioContext();

  if (!playing) {
    if (!firstAttachDone) {
      attachVideoTexturesToPlanes();
      firstAttachDone = true;
    }

    // baseline sync: set audio currentTime to video currentTime (or 0)
    const baseline = (videoElem && !isNaN(videoElem.currentTime)) ? videoElem.currentTime : 0;
    try { audioElem.currentTime = baseline; } catch(e) {}

    // attempt simultaneous play
    const promises = [];
    try { promises.push(videoElem.play()); } catch(e) { console.warn('video play error', e); }
    try { promises.push(audioElem.play()); } catch(e) { console.warn('audio play error', e); }

    const settled = await Promise.allSettled(promises);
    const rejected = settled.filter(s => s.status === 'rejected');
    if (rejected.length) {
      console.warn('Some media failed to play. User gesture may be required.');
      playing = !audioElem.paused || !videoElem.paused;
    } else {
      playing = true;
    }
    console.log('togglePlayPauseAll: playing =', playing);
  } else {
    try { videoElem.pause(); } catch(e){}
    try { audioElem.pause(); } catch(e){}
    playing = false;
    console.log('Playback paused.');
  }
}

function seekAllTo(sec, fragmentIndex = 0) {
  if (!mediaReady) {
    console.warn('seekAllTo: media not ready');
    return;
  }
  console.log('Seeking to', sec);
  try { videoElem.currentTime = sec; } catch(e) { console.warn('video seek err', e); }
  try { audioElem.currentTime = sec; } catch(e) { console.warn('audio seek err', e); }

  if (fragmentIndex) debugCurrentFragment = fragmentIndex;

  // brief pause/resume to improve sync if playing
  if (playing) {
    try { videoElem.pause(); } catch(e){}
    try { audioElem.pause(); } catch(e){}
    setTimeout(async () => {
      try { await videoElem.play(); } catch(e){}
      try { await audioElem.play(); } catch(e){}
    }, 80);
  }
}

/* -----------------------------
   Input handling (Space, digits)
   ----------------------------- */
document.addEventListener('keydown', async (ev) => {
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (!listener) ensureListener();
    await resumeAudioContext();
    if (!mediaReady) setupAllMediaFlow();
    await togglePlayPauseAll();
    return;
  }

  if (/^[1-7]$/.test(ev.key)) {
    const n = parseInt(ev.key,10);
    const sec = CHAPTERS[n];
    if (typeof sec === 'number') {
      seekAllTo(sec, n);
    }
  }
});

/* -----------------------------
   Expose debug helpers
   ----------------------------- */
window._NB = window._NB || {};
window._NB.status = () => ({
  planesFound,
  mediaReady,
  playing,
  videoCurrentTime: videoElem ? videoElem.currentTime : null,
  audioCurrentTime: audioElem ? audioElem.currentTime : null,
  cineLoaded: debugModelLoaded,
  currentFragment: debugCurrentFragment
});

/* -----------------------------
   End of file
   ----------------------------- */
