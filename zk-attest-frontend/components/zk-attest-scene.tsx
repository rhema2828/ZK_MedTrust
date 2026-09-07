import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

/* ---------------------------------------------------------------------
   ZK-ATTEST — interactive 3D product visualization
   Private data stays. Only the proof moves.
   Vanilla Three.js (r128) inside a React component — no OrbitControls/
   R3F available, so orbit + zoom + raycast picking are hand-rolled.
--------------------------------------------------------------------- */

const COLORS = {
  bg: 0x101522,
  fog: 0x101522,
  graphite: 0x303b52,
  graphiteDark: 0x202a40,
  graphiteLight: 0x566783,
  metalTrim: 0x8ea4c6,
  glass: 0x8fdcff,
  floor: 0x151d30,
  dataBlue: 0x6fe7ff,
  dataBlueEmissive: 0x19cfff,
  amber: 0xffc56b,
  amberEmissive: 0xff8a3d,
  green: 0x70f6b0,
  idleScreen: 0x30415d,
};

const PRIVATE_X = -7;
const PROC_X = -2.6;
const BOUNDARY_X = 0;
const VERIFIER_X = 5.5;
const CHANNEL_Y = 1.35;

const COMPONENT_INFO = {
  private: {
    title: "Private environment",
    body: "Revenue, cash and liabilities are generated and held here. This data is never transmitted — it does not leave this enclosure at any point in the process.",
  },
  processor: {
    title: "Cryptographic processor",
    body: "Private inputs are transformed into a proof inside this module. The computation happens entirely within the private side of the boundary.",
  },
  boundary: {
    title: "Security boundary",
    body: "The edge between the private environment and the external verifier. Only a proof packet is permitted through the port — nothing else crosses.",
  },
  verifier: {
    title: "Verifier",
    body: "Receives and checks the proof. It confirms the underlying conditions are satisfied without ever seeing the private financial data itself.",
  },
};

/* Phase timeline, in seconds, cumulative */
const PHASES = [
  { key: "idle", end: 0 },
  { key: "dataLit", end: 0.9 }, // data nodes light up
  { key: "dataFlow", end: 2.2 }, // blue pulse: private box -> processor
  { key: "computing", end: 3.9 }, // core spins up, glows, LEDs sequence
  { key: "proofSpawn", end: 4.25 }, // amber packet appears
  { key: "proofTravel", end: 6.15 }, // packet rides tube, crosses port
  { key: "arrive", end: 6.55 }, // packet reaches verifier, absorbed
  { key: "verified", end: 7.2 }, // screen -> green, check draws in
  { key: "done", end: 999 },
];

const STATUS_LABEL = {
  idle: "Idle",
  dataLit: "Reading private inputs",
  dataFlow: "Feeding processor",
  computing: "Computing proof",
  proofSpawn: "Proof generated",
  proofTravel: "Proof crossing boundary",
  arrive: "Proof received",
  verified: "Verified",
  done: "Verified",
};

function phaseAt(t) {
  for (let i = 0; i < PHASES.length; i++) {
    if (t < PHASES[i].end) {
      const prevEnd = i === 0 ? 0 : PHASES[i - 1].end;
      const span = Math.max(0.0001, PHASES[i].end - prevEnd);
      const localT = Math.min(1, Math.max(0, (t - prevEnd) / span));
      return { key: PHASES[i].key, localT };
    }
  }
  return { key: "done", localT: 1 };
}

function easeInOutQuad(x) {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}
function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

/* ---------- geometry builders ---------- */

function makeEnclosure({ width, height, depth, panelColor = COLORS.graphite }) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: panelColor,
    metalness: 0.85,
    roughness: 0.38,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: COLORS.metalTrim,
    metalness: 0.9,
    roughness: 0.28,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // base plinth
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width * 1.08, 0.14, depth * 1.08),
    trimMat
  );
  base.position.y = -height / 2 - 0.07;
  base.receiveShadow = true;
  base.castShadow = true;
  group.add(base);

  // top cap trim
  const cap = new THREE.Mesh(new THREE.BoxGeometry(width * 1.02, 0.06, depth * 1.02), trimMat);
  cap.position.y = height / 2 + 0.03;
  group.add(cap);

  // vertical edge trims (front corners) for a machined look
  [-1, 1].forEach((sx) => {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.05, height, 0.05), trimMat);
    edge.position.set((sx * width) / 2, 0, depth / 2 - 0.02);
    group.add(edge);
  });

  // horizontal vent grooves on the side
  for (let i = 0; i < 5; i++) {
    const groove = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.04, depth * 0.7),
      new THREE.MeshStandardMaterial({ color: COLORS.graphiteDark, metalness: 0.6, roughness: 0.6 })
    );
    groove.position.set(width / 2 + 0.011, height / 2 - 0.3 - i * 0.22, 0);
    group.add(groove);
  }

  return { group, body };
}

function makeStatusLed(color = COLORS.metalTrim) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x111316,
    emissive: color,
    emissiveIntensity: 0.0,
    metalness: 0.2,
    roughness: 0.4,
  });
  const led = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16), mat);
  led.rotation.x = Math.PI / 2;
  return led;
}

function buildScene(container, callbacks) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.Fog(COLORS.fog, 18, 44);

  const camera = new THREE.PerspectiveCamera(
    38,
    container.clientWidth / container.clientHeight,
    0.1,
    100
  );

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.outputColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  /* ---------------- lighting ---------------- */
  const hemi = new THREE.HemisphereLight(0xc7e9ff, 0x18213a, 1.15);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff4df, 1.8);
  key.position.set(6, 10, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -14;
  key.shadow.camera.right = 14;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0015;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x5f7fb0, 0.28);
  fill.position.set(-8, 5, -4);
  scene.add(fill);

  const amberAccent = new THREE.PointLight(COLORS.amberEmissive, 0, 9, 2);
  amberAccent.position.set(PROC_X + 0.6, CHANNEL_Y + 0.4, 1.6);
  scene.add(amberAccent);

  const boundaryAccent = new THREE.PointLight(COLORS.amberEmissive, 0, 6, 2);
  boundaryAccent.position.set(BOUNDARY_X, CHANNEL_Y, 1.2);
  scene.add(boundaryAccent);

  /* ---------------- floor ---------------- */
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(20, 64),
    new THREE.MeshStandardMaterial({ color: COLORS.floor, metalness: 0.3, roughness: 0.85 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.85;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(40, 40, 0x1b2028, 0x14171c);
  grid.position.y = -1.84;
  grid.material.transparent = true;
  grid.material.opacity = 0.4;
  scene.add(grid);

  /* ================= PRIVATE ENVIRONMENT (left) ================= */
  const privateGroup = new THREE.Group();
  privateGroup.userData.label = "private";
  privateGroup.position.set(PRIVATE_X, 0, 0);
  scene.add(privateGroup);

  const priv = makeEnclosure({ width: 2.7, height: 3.1, depth: 2.2 });
  privateGroup.add(priv.group);

  // glass viewing panel on the front face
  const privGlassMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.glass,
    transparent: true,
    opacity: 0.22,
    metalness: 0,
    roughness: 0.12,
    side: THREE.DoubleSide,
  });
  const privGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 2.1), privGlassMat);
  privGlass.position.set(0, 0.1, 1.11);
  privateGroup.add(privGlass);

  // data nodes behind the glass
  const dataNodeMat = () =>
    new THREE.MeshStandardMaterial({
      color: COLORS.dataBlue,
      emissive: COLORS.dataBlueEmissive,
      emissiveIntensity: 0.0,
      metalness: 0.1,
      roughness: 0.3,
    });
  const dataNodes = [];
  const nodeLabels = ["Revenue", "Cash", "Liabilities"];
  [0.62, 0.0, -0.62].forEach((y, i) => {
    const geo = new THREE.CylinderGeometry(0.18, 0.18, 0.5, 16);
    const mesh = new THREE.Mesh(geo, dataNodeMat());
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(0, y, 0.75);
    mesh.userData.label = "private";
    mesh.userData.baseEmissive = 0.0;
    mesh.name = nodeLabels[i];
    privateGroup.add(mesh);
    dataNodes.push(mesh);
  });

  // status LED on top of private enclosure
  const privLed = makeStatusLed(COLORS.dataBlueEmissive);
  privLed.position.set(0, 1.66, 0.9);
  privateGroup.add(privLed);

  /* ================= CRYPTOGRAPHIC PROCESSOR (center-left) ================= */
  const procGroup = new THREE.Group();
  procGroup.userData.label = "processor";
  procGroup.position.set(PROC_X, 0, 0);
  scene.add(procGroup);

  const proc = makeEnclosure({ width: 2.0, height: 2.6, depth: 2.0, panelColor: COLORS.graphiteDark });
  procGroup.add(proc.group);

  const procGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffdca8,
    transparent: true,
    opacity: 0.16,
    metalness: 0,
    roughness: 0.15,
    side: THREE.DoubleSide,
  });
  const procGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.6), procGlassMat);
  procGlass.position.set(0, 0.1, 1.01);
  procGroup.add(procGlass);

  // rotating crystalline core
  const coreGroup = new THREE.Group();
  coreGroup.position.set(0, 0.1, 0.55);
  procGroup.add(coreGroup);

  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x2a2f36,
    emissive: COLORS.amberEmissive,
    emissiveIntensity: 0.0,
    metalness: 0.6,
    roughness: 0.25,
    flatShading: true,
  });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), coreMat);
  core.castShadow = true;
  coreGroup.add(core);

  const coreRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.58, 0.02, 8, 40),
    new THREE.MeshStandardMaterial({
      color: 0x333a42,
      emissive: COLORS.amberEmissive,
      emissiveIntensity: 0.0,
      metalness: 0.7,
      roughness: 0.3,
    })
  );
  coreRing.rotation.x = Math.PI / 2.4;
  coreGroup.add(coreRing);

  // sequencing LED strip
  const procLeds = [];
  for (let i = 0; i < 4; i++) {
    const led = makeStatusLed(COLORS.amberEmissive);
    led.position.set(-0.6 + i * 0.4, -0.95, 1.01);
    led.rotation.x = 0;
    procGroup.add(led);
    procLeds.push(led);
  }

  /* ================= BOUNDARY WALL (center) ================= */
  const boundaryGroup = new THREE.Group();
  boundaryGroup.userData.label = "boundary";
  boundaryGroup.position.set(BOUNDARY_X, 0, 0);
  scene.add(boundaryGroup);

  const wallMat = new THREE.MeshPhysicalMaterial({
    color: 0x6f8bab,
    transparent: true,
    opacity: 0.28,
    metalness: 0.1,
    roughness: 0.2,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.9, 3.4), wallMat);
  boundaryGroup.add(wall);

  const frameMat = new THREE.MeshStandardMaterial({ color: COLORS.metalTrim, metalness: 0.85, roughness: 0.3 });
  const frameTop = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 3.5), frameMat);
  frameTop.position.y = 1.98;
  boundaryGroup.add(frameTop);
  const frameBottom = frameTop.clone();
  frameBottom.position.y = -1.98;
  boundaryGroup.add(frameBottom);

  // faint grid pattern on the glass (thin bars)
  for (let i = -1; i <= 1; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(0.145, 3.9, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x8fa8c4, transparent: true, opacity: 0.18 })
    );
    bar.position.z = i * 1.1;
    boundaryGroup.add(bar);
  }

  // the port — the only opening in the wall
  const portRingMat = new THREE.MeshStandardMaterial({
    color: 0x3a4048,
    emissive: COLORS.amberEmissive,
    emissiveIntensity: 0.0,
    metalness: 0.85,
    roughness: 0.25,
  });
  const portRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 12, 32), portRingMat);
  portRing.rotation.y = Math.PI / 2;
  portRing.position.set(0, CHANNEL_Y, 0);
  boundaryGroup.add(portRing);

  /* ================= VERIFIER (right) ================= */
  const verifierGroup = new THREE.Group();
  verifierGroup.userData.label = "verifier";
  verifierGroup.position.set(VERIFIER_X, 0, 0);
  scene.add(verifierGroup);

  const ver = makeEnclosure({ width: 2.7, height: 3.1, depth: 2.2, panelColor: COLORS.graphite });
  verifierGroup.add(ver.group);

  const screenMat = new THREE.MeshStandardMaterial({
    color: COLORS.idleScreen,
    emissive: 0x000000,
    emissiveIntensity: 0,
    metalness: 0.2,
    roughness: 0.4,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), screenMat);
  screen.position.set(0, 0.15, 1.11);
  verifierGroup.add(screen);

  // checkmark, built from two thin boxes, hidden until verified
  const checkGroup = new THREE.Group();
  checkGroup.position.set(0, 0.12, 1.13);
  checkGroup.visible = false;
  const checkMat = new THREE.MeshStandardMaterial({
    color: 0x0d1a12,
    emissive: COLORS.green,
    emissiveIntensity: 1.4,
  });
  const short = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.03), checkMat);
  short.position.set(-0.18, -0.06, 0);
  short.rotation.z = Math.PI / 4;
  const long = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.09, 0.03), checkMat);
  long.position.set(0.14, 0.08, 0);
  long.rotation.z = -Math.PI / 4;
  checkGroup.add(short, long);
  verifierGroup.add(checkGroup);

  const verLed = makeStatusLed(COLORS.metalTrim);
  verLed.position.set(0, 1.66, 0.9);
  verifierGroup.add(verLed);

  /* ================= CABLES ================= */
  // internal data channel: private -> processor (never crosses the boundary)
  const dataCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(PRIVATE_X + 1.4, CHANNEL_Y - 0.15, 0),
    new THREE.Vector3((PRIVATE_X + PROC_X) / 2, CHANNEL_Y - 0.35, 0),
    new THREE.Vector3(PROC_X - 1.05, CHANNEL_Y - 0.15, 0),
  ]);
  const dataSheath = new THREE.Mesh(
    new THREE.TubeGeometry(dataCurve, 32, 0.05, 8, false),
    new THREE.MeshStandardMaterial({ color: 0x1c1f24, metalness: 0.4, roughness: 0.6 })
  );
  scene.add(dataSheath);
  const dataCoreMat = new THREE.MeshStandardMaterial({
    color: 0x1c1f24,
    emissive: COLORS.dataBlueEmissive,
    emissiveIntensity: 0.0,
  });
  const dataCoreTube = new THREE.Mesh(new THREE.TubeGeometry(dataCurve, 32, 0.018, 8, false), dataCoreMat);
  scene.add(dataCoreTube);

  // proof channel: processor -> through the port -> verifier (the only thing that crosses)
  const proofCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(PROC_X + 1.0, CHANNEL_Y, 0.0),
    new THREE.Vector3(PROC_X + 1.8, CHANNEL_Y + 0.12, 0),
    new THREE.Vector3(BOUNDARY_X, CHANNEL_Y, 0),
    new THREE.Vector3(VERIFIER_X - 1.8, CHANNEL_Y + 0.12, 0),
    new THREE.Vector3(VERIFIER_X - 1.35, CHANNEL_Y, 0),
  ]);
  const proofSheath = new THREE.Mesh(
    new THREE.TubeGeometry(proofCurve, 64, 0.045, 8, false),
    new THREE.MeshStandardMaterial({ color: 0x1c1f24, metalness: 0.4, roughness: 0.55 })
  );
  scene.add(proofSheath);
  const proofCoreMat = new THREE.MeshStandardMaterial({
    color: 0x1c1f24,
    emissive: COLORS.amberEmissive,
    emissiveIntensity: 0.05,
  });
  const proofCoreTube = new THREE.Mesh(new THREE.TubeGeometry(proofCurve, 64, 0.015, 8, false), proofCoreMat);
  scene.add(proofCoreTube);

  /* ================= PROOF PACKET ================= */
  const proofMat = new THREE.MeshStandardMaterial({
    color: 0x2a2016,
    emissive: COLORS.amberEmissive,
    emissiveIntensity: 2.2,
    metalness: 0.3,
    roughness: 0.25,
  });
  const proofPacket = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), proofMat);
  proofPacket.visible = false;
  proofPacket.castShadow = true;
  const proofGlow = new THREE.PointLight(COLORS.amberEmissive, 0, 3.2, 2);
  proofPacket.add(proofGlow);
  scene.add(proofPacket);

  // Fast-moving signal beads make the verification computation feel physical.
  const signalParticles = [];
  const signalGroup = new THREE.Group();
  signalGroup.visible = false;
  scene.add(signalGroup);
  for (let i = 0; i < 12; i++) {
    const signalMat = new THREE.MeshBasicMaterial({
      color: i < 6 ? COLORS.dataBlue : COLORS.amber,
      transparent: true,
      opacity: 0.95,
    });
    const bead = new THREE.Mesh(new THREE.SphereGeometry(i % 3 === 0 ? 0.13 : 0.085, 16, 16), signalMat);
    const glow = new THREE.PointLight(i < 6 ? COLORS.dataBlueEmissive : COLORS.amberEmissive, 0.35, 1.2, 2);
    bead.add(glow);
    signalGroup.add(bead);
    signalParticles.push(bead);
  }

  /* ---------------- interactive object registry ---------------- */
  const pickables = [];
  scene.traverse((obj) => {
    if (obj.isMesh) pickables.push(obj);
  });

  /* ---------------- camera / orbit rig ---------------- */
  const target = new THREE.Vector3(-0.7, 0.5, 0);
  const spherical = { radius: 15.5, theta: 0.62, phi: 1.15 };
  const minRadius = 8;
  const maxRadius = 26;

  function updateCamera() {
    const s = spherical;
    const x = target.x + s.radius * Math.sin(s.phi) * Math.sin(s.theta);
    const y = target.y + s.radius * Math.cos(s.phi);
    const z = target.z + s.radius * Math.sin(s.phi) * Math.cos(s.theta);
    camera.position.set(x, y, z);
    camera.lookAt(target);
  }
  updateCamera();

  return {
    scene,
    camera,
    renderer,
    target,
    spherical,
    minRadius,
    maxRadius,
    updateCamera,
    pickables,
    refs: {
      dataNodes,
      privLed,
      dataCoreMat,
      core,
      coreGroup,
      coreRing,
      procLeds,
      amberAccent,
      boundaryAccent,
      portRingMat,
      proofCoreMat,
      proofPacket,
      proofGlow,
      proofCurve,
      dataCurve,
      signalGroup,
      signalParticles,
      screenMat,
      checkGroup,
      verLed,
      key,
    },
  };
}

/* =====================================================================
   REACT COMPONENT
===================================================================== */

type ZKAttestVisualizationProps = {
  running?: boolean
  authorized?: boolean
  blocked?: boolean
}

export default function ZKAttestVisualization({ running = false }: ZKAttestVisualizationProps) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const rafRef = useRef(null);
  const clockRef = useRef({ running: false, startTime: 0, elapsed: 0 });
  const dragRef = useRef({ dragging: false, moved: false, lastX: 0, lastY: 0 });
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseNDC = useRef(new THREE.Vector2());

  const [status, setStatus] = useState("idle");
  const [hover, setHover] = useState(null); // { label, x, y }
  const [selected, setSelected] = useState(null); // key into COMPONENT_INFO
  const lastStatusKey = useRef("idle");
  const previousRunning = useRef(false);

  const startVerification = useCallback(() => {
    clockRef.current.running = true;
    clockRef.current.startTime = performance.now();
    clockRef.current.elapsed = 0;
    lastStatusKey.current = "idle";
    setStatus("idle");
  }, []);

  const resetVerification = useCallback(() => {
    clockRef.current.running = false;
    clockRef.current.elapsed = 0;
    lastStatusKey.current = "idle";
    setStatus("idle");
    applyPhase(sceneRef.current, "idle", 0);
  }, []);

  useEffect(() => {
    if (running && !previousRunning.current) {
      startVerification();
    }
    previousRunning.current = running;
  }, [running, startVerification]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const built = buildScene(container);
    sceneRef.current = built;
    applyPhase(built, "idle", 0);

    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      built.camera.aspect = w / h;
      built.camera.updateProjectionMatrix();
      built.renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    /* -------- pointer controls -------- */
    const dom = built.renderer.domElement;

    const onPointerDown = (e) => {
      dragRef.current.dragging = true;
      dragRef.current.moved = false;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e) => {
      const rect = dom.getBoundingClientRect();
      mouseNDC.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseNDC.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (dragRef.current.dragging) {
        const dx = e.clientX - dragRef.current.lastX;
        const dy = e.clientY - dragRef.current.lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
        dragRef.current.lastX = e.clientX;
        dragRef.current.lastY = e.clientY;
        built.spherical.theta -= dx * 0.006;
        built.spherical.phi = Math.min(
          1.45,
          Math.max(0.35, built.spherical.phi - dy * 0.006)
        );
        built.updateCamera();
        setHover(null);
      } else {
        // hover raycast
        raycasterRef.current.setFromCamera(mouseNDC.current, built.camera);
        const hits = raycasterRef.current.intersectObjects(built.pickables, false);
        const hit = hits.find((h) => findLabel(h.object));
        if (hit) {
          const label = findLabel(hit.object);
          setHover({ label, x: e.clientX, y: e.clientY });
          dom.style.cursor = "pointer";
        } else {
          setHover(null);
          dom.style.cursor = "grab";
        }
      }
    };

    const onPointerUp = (e) => {
      if (dragRef.current.dragging && !dragRef.current.moved) {
        raycasterRef.current.setFromCamera(mouseNDC.current, built.camera);
        const hits = raycasterRef.current.intersectObjects(built.pickables, false);
        const hit = hits.find((h) => findLabel(h.object));
        if (hit) {
          setSelected((prev) => {
            const label = findLabel(hit.object);
            return prev === label ? null : label;
          });
        } else {
          setSelected(null);
        }
      }
      dragRef.current.dragging = false;
      dom.style.cursor = "grab";
    };

    const onWheel = (e) => {
      e.preventDefault();
      built.spherical.radius = Math.min(
        built.maxRadius,
        Math.max(built.minRadius, built.spherical.radius + e.deltaY * 0.015)
      );
      built.updateCamera();
    };

    dom.style.cursor = "grab";
    dom.style.touchAction = "none";
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("wheel", onWheel, { passive: false });

    /* -------- render / animation loop -------- */
    const tick = () => {
      const c = clockRef.current;
      if (c.running) {
        c.elapsed = (performance.now() - c.startTime) / 1000;
      }
      const { key, localT } = phaseAt(c.elapsed);
      applyPhase(built, key, localT);

      if (key !== lastStatusKey.current) {
        lastStatusKey.current = key;
        setStatus(key);
        if (key === "done") clockRef.current.running = false;
      }

      // gentle idle rotation of the core always
      built.refs.coreGroup.rotation.y += key === "computing" ? 0.05 : 0.01;

      built.renderer.render(built.scene, built.camera);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("wheel", onWheel);
      built.renderer.dispose();
      if (dom.parentNode) dom.parentNode.removeChild(dom);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = status !== "idle" && status !== "done";

  return (
    <div style={styles.root}>
      <style>{FONT_IMPORT}</style>
      <div ref={mountRef} style={styles.canvasWrap} />

      <div style={styles.headerCol}>
        <div style={styles.kicker}>ZK-Attest</div>
        <div style={styles.headline}>
          Private data stays.
          <br />
          Only the proof moves.
        </div>
        <div style={styles.subcopy}>
          Drag to rotate, scroll to zoom, and hover a component to see what it does.
        </div>
      </div>

      <div style={styles.legend}>
        <div style={styles.legendRow}>
          <span style={{ ...styles.dot, background: "#7ec8ff" }} />
          Private financial data — never leaves the enclosure
        </div>
        <div style={styles.legendRow}>
          <span style={{ ...styles.dot, background: "#ffb454" }} />
          Cryptographic proof — the only thing that crosses
        </div>
      </div>

      <div style={styles.controlBar}>
        <div style={styles.statusText}>{STATUS_LABEL[status]}</div>
        <button
          style={{ ...styles.button, ...(isRunning ? styles.buttonDisabled : {}) }}
          onClick={startVerification}
          disabled={isRunning}
        >
          {status === "done" ? "Run again" : "Start verification"}
        </button>
        {status !== "idle" && (
          <button style={styles.buttonGhost} onClick={resetVerification}>
            Reset
          </button>
        )}
      </div>

      {hover && !selected && (
        <div
          style={{
            ...styles.tooltip,
            left: hover.x + 16,
            top: hover.y + 16,
          }}
        >
          {COMPONENT_INFO[hover.label].title}
        </div>
      )}

      {selected && (
        <div style={styles.infoPanel}>
          <div style={styles.infoTitle}>{COMPONENT_INFO[selected].title}</div>
          <div style={styles.infoBody}>{COMPONENT_INFO[selected].body}</div>
          <button style={styles.infoClose} onClick={() => setSelected(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Phase -> visual state application (pure function of animation state)
--------------------------------------------------------------------- */
function findLabel(object) {
  let o = object;
  while (o) {
    if (o.userData && o.userData.label) return o.userData.label;
    o = o.parent;
  }
  return null;
}

function applyPhase(built, key, localT) {
  if (!built) return;
  const r = built.refs;

  const dataOn = key === "dataLit" || key === "dataFlow" || key === "computing" || key === "proofSpawn" || key === "proofTravel" || key === "arrive" || key === "verified" || key === "done";
  const dataIntensity = key === "idle" ? 0 : key === "dataLit" ? easeOutCubic(localT) * 1.6 : dataOn ? 1.4 : 0;
  r.dataNodes.forEach((n) => {
    n.material.emissiveIntensity = THREE.MathUtils.lerp(n.material.emissiveIntensity, dataIntensity, 0.25);
    const pulse = 1 + (dataOn ? Math.sin(performance.now() * 0.004) * 0.03 : 0);
    n.scale.setScalar(pulse);
  });
  r.privLed.material.emissiveIntensity = THREE.MathUtils.lerp(
    r.privLed.material.emissiveIntensity,
    dataOn ? 1.6 : 0,
    0.2
  );

  // data pulse traveling along the internal channel (private -> processor only)
  let dataCoreGlow = 0;
  if (key === "dataFlow") dataCoreGlow = 1.4;
  else if (key === "dataLit") dataCoreGlow = 0.3;
  else if (["computing", "proofSpawn", "proofTravel", "arrive", "verified", "done"].includes(key)) dataCoreGlow = 0.5;
  r.dataCoreMat.emissiveIntensity = THREE.MathUtils.lerp(r.dataCoreMat.emissiveIntensity, dataCoreGlow, 0.2);

  // processor core
  const computing = key === "computing";
  const coreGlowTarget =
    key === "idle" || key === "dataLit" || key === "dataFlow"
      ? 0.05
      : computing
      ? 0.4 + easeInOutQuad(localT) * 1.6
      : 1.9;
  r.core.material.emissiveIntensity = THREE.MathUtils.lerp(r.core.material.emissiveIntensity, coreGlowTarget, 0.15);
  r.coreRing.material.emissiveIntensity = r.core.material.emissiveIntensity * 0.7;
  const coreScale = computing ? 1 + Math.sin(performance.now() * 0.012) * 0.05 * easeInOutQuad(localT) : 1;
  r.core.scale.setScalar(coreScale);

  r.amberAccent.intensity = THREE.MathUtils.lerp(
    r.amberAccent.intensity,
    computing ? 1.2 + easeInOutQuad(localT) * 1.8 : ["proofSpawn", "proofTravel"].includes(key) ? 2.4 : 0.15,
    0.15
  );

  // sequencing LEDs during compute
  r.procLeds.forEach((led, i) => {
    const threshold = i / r.procLeds.length;
    const on = computing && localT > threshold;
    led.material.emissiveIntensity = THREE.MathUtils.lerp(led.material.emissiveIntensity, on ? 1.8 : 0.05, 0.3);
  });

  // proof packet
  const showPacket = ["proofSpawn", "proofTravel", "arrive"].includes(key);
  r.proofPacket.visible = showPacket;
  if (key === "proofSpawn") {
    const t = easeOutCubic(localT);
    r.proofPacket.position.copy(r.proofCurve.getPointAt(0));
    r.proofPacket.scale.setScalar(t);
    r.proofGlow.intensity = t * 2;
  } else if (key === "proofTravel") {
    const u = easeInOutQuad(localT);
    r.proofPacket.position.copy(r.proofCurve.getPointAt(u));
    r.proofPacket.rotation.x += 0.06;
    r.proofPacket.rotation.y += 0.04;
    r.proofPacket.scale.setScalar(1);
    r.proofGlow.intensity = 2;

    // port ring flashes as the packet passes through the boundary (u ~ 0.5)
    const dist = Math.abs(u - 0.5);
    const portGlow = Math.max(0, 1 - dist * 6);
    r.portRingMat.emissiveIntensity = THREE.MathUtils.lerp(r.portRingMat.emissiveIntensity, portGlow * 2.4, 0.4);
    r.boundaryAccent.intensity = THREE.MathUtils.lerp(r.boundaryAccent.intensity, portGlow * 3, 0.4);
  } else if (key === "arrive") {
    const t = 1 - easeOutCubic(localT);
    r.proofPacket.position.copy(r.proofCurve.getPointAt(1));
    r.proofPacket.scale.setScalar(Math.max(0.001, t));
    r.proofGlow.intensity = t * 2;
    r.portRingMat.emissiveIntensity = THREE.MathUtils.lerp(r.portRingMat.emissiveIntensity, 0, 0.2);
    r.boundaryAccent.intensity = THREE.MathUtils.lerp(r.boundaryAccent.intensity, 0, 0.2);
  } else {
    r.portRingMat.emissiveIntensity = THREE.MathUtils.lerp(r.portRingMat.emissiveIntensity, 0.05, 0.2);
    r.boundaryAccent.intensity = THREE.MathUtils.lerp(r.boundaryAccent.intensity, 0, 0.2);
  }
  r.proofCoreMat.emissiveIntensity = THREE.MathUtils.lerp(
    r.proofCoreMat.emissiveIntensity,
    ["proofSpawn", "proofTravel", "arrive"].includes(key) ? 1.6 : 0.05,
    0.2
  );

  // Electrical-looking pulses stream through the private channel first, then
  // switch to the proof channel once the cryptographic proof is emitted.
  const signalPhase = ["dataLit", "dataFlow", "computing", "proofSpawn", "proofTravel", "arrive", "verified"].includes(key);
  r.signalGroup.visible = signalPhase;
  if (signalPhase) {
    const now = performance.now() * 0.001;
    const dataMode = ["dataFlow", "computing"].includes(key);
    r.signalParticles.forEach((particle, index) => {
      const offset = (index % 6) / 6;
      const speed = dataMode ? 0.7 : 0.9;
      const progress = (now * speed + offset) % 1;
      const curve = dataMode ? r.dataCurve : r.proofCurve;
      particle.position.copy(curve.getPointAt(progress));
      const pulse = 0.72 + Math.sin(now * 10 + index) * 0.22;
      particle.scale.setScalar(pulse);
      particle.material.opacity = 0.72 + pulse * 0.25;
      const glow = particle.children[0];
      if (glow) glow.intensity = 0.5 + pulse * 0.65;
    });
  }

  // verifier
  const verified = key === "verified" || key === "done";
  r.verLed.material.emissiveIntensity = THREE.MathUtils.lerp(r.verLed.material.emissiveIntensity, verified ? 1.8 : 0, 0.2);
  if (verified) {
    r.screenMat.color.lerp(new THREE.Color(COLORS.green), 0.12);
    r.screenMat.emissive.lerp(new THREE.Color(COLORS.green), 0.12);
    r.screenMat.emissiveIntensity = THREE.MathUtils.lerp(r.screenMat.emissiveIntensity, 0.6, 0.15);
    r.checkGroup.visible = true;
    const s = key === "verified" ? easeOutCubic(localT) : 1;
    r.checkGroup.scale.setScalar(Math.max(0.001, s));
  } else {
    r.screenMat.color.lerp(new THREE.Color(COLORS.idleScreen), 0.1);
    r.screenMat.emissive.lerp(new THREE.Color(0x000000), 0.1);
    r.screenMat.emissiveIntensity = THREE.MathUtils.lerp(r.screenMat.emissiveIntensity, 0, 0.1);
    r.checkGroup.visible = false;
  }
}

/* ---------------------------------------------------------------------
   Styles — graphite / glass / amber, institutional fintech
--------------------------------------------------------------------- */
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');`;

const styles = {
  root: {
    position: "relative",
    width: "100%",
    height: "100%",
    minHeight: 460,
    background: "#101522",
    fontFamily: "'Inter', sans-serif",
    overflow: "hidden",
  },
  canvasWrap: {
    position: "absolute",
    inset: 0,
  },
  headerCol: {
    position: "absolute",
    top: 24,
    left: 24,
    maxWidth: 320,
    pointerEvents: "none",
  },
  kicker: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 13,
    letterSpacing: "0.02em",
    color: "#ffc56b",
    marginBottom: 10,
    fontWeight: 500,
  },
  headline: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 30,
    lineHeight: 1.15,
    color: "#f6f8ff",
    fontWeight: 500,
    letterSpacing: "-0.01em",
  },
  subcopy: {
    marginTop: 14,
    fontSize: 14,
    lineHeight: 1.5,
    color: "#b6c5df",
    maxWidth: 320,
  },
  legend: {
    position: "absolute",
    bottom: 22,
    left: 24,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    pointerEvents: "none",
  },
  legendRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12.5,
    color: "#9aa2b0",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    boxShadow: "0 0 8px currentColor",
  },
  controlBar: {
    position: "absolute",
    bottom: 22,
    right: 24,
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  statusText: {
    fontSize: 13,
    color: "#c3c9d3",
    minWidth: 168,
    textAlign: "right",
  },
  button: {
    background: "#ffc56b",
    color: "#17111a",
    border: "none",
    borderRadius: 3,
    padding: "11px 20px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
    transition: "opacity 0.15s ease",
  },
  buttonDisabled: {
    opacity: 0.45,
    cursor: "default",
  },
  buttonGhost: {
    background: "transparent",
    color: "#b6c5df",
    border: "1px solid #2a2f38",
    borderRadius: 3,
    padding: "11px 16px",
    fontSize: 13.5,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  tooltip: {
    position: "fixed",
    background: "#14171cee",
    border: "1px solid #2a2f38",
    color: "#e8ecf1",
    fontSize: 12.5,
    padding: "7px 11px",
    borderRadius: 3,
    pointerEvents: "none",
    zIndex: 20,
    whiteSpace: "nowrap",
  },
  infoPanel: {
    position: "absolute",
    top: 32,
    right: 36,
    width: 300,
    background: "#18233bee",
    border: "1px solid #536b91",
    borderRadius: 4,
    padding: "20px 22px",
    backdropFilter: "blur(6px)",
  },
  infoTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 16,
    color: "#f6f8ff",
    marginBottom: 8,
    fontWeight: 500,
  },
  infoBody: {
    fontSize: 13,
    lineHeight: 1.55,
    color: "#9aa2b0",
  },
  infoClose: {
    marginTop: 16,
    background: "transparent",
    border: "1px solid #2a2f38",
    color: "#b6c5df",
    borderRadius: 3,
    padding: "7px 14px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
};
