import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const I = window.ISS;
const S = window.satellite;
const $ = (id) => document.getElementById(id);
const ALT_SCALE = 1.6; // exaggerate orbit height a little so the station reads clearly above the surface

// lat/lon (deg) → unit vector in the globe's frame (matches three.js SphereGeometry UVs)
function vec(lat, lon, r = 1) {
  const la = lat * I.DEG, lo = lon * I.DEG;
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * r, Math.sin(la) * r, -Math.cos(la) * Math.sin(lo) * r);
}
const altR = (altKm) => 1 + (altKm / I.RE) * ALT_SCALE;

// ---------- scene ----------
const canvas = $('globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
camera.position.copy(vec(20, 78, 3.6));
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.minDistance = 1.35; controls.maxDistance = 8; controls.enablePan = false;
controls.rotateSpeed = 0.5;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep the globe clear of the side panel on desktop
  camera.setViewOffset(w, h, w > 820 ? 170 : 0, w > 820 ? 0 : h * 0.16, w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

// stars (seeded so they never jump)
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 2500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = 40;
    const s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(t) * r, u * r, s * Math.sin(t) * r], i * 3);
    const b = 0.35 + rnd() * 0.65;
    col.set([b * 0.85, b * 0.92, b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, sizeAttenuation: true })));
}

// earth: day/night blend lit by the real sun direction
const loader = new THREE.TextureLoader();
const dayTex = loader.load('img/earth-day.jpg');
const nightTex = loader.load('img/earth-night.jpg');
dayTex.colorSpace = nightTex.colorSpace = THREE.SRGBColorSpace;
const sunDir = new THREE.Vector3(1, 0, 0);
const earthMat = new THREE.ShaderMaterial({
  uniforms: { day: { value: dayTex }, night: { value: nightTex }, sun: { value: sunDir } },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vView;
    void main(){ vUv=uv; vN=normalize(normal); vec4 mv=modelViewMatrix*vec4(position,1.); vView=normalize(-mv.xyz);
      gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `uniform sampler2D day; uniform sampler2D night; uniform vec3 sun; varying vec2 vUv; varying vec3 vN; varying vec3 vView;
    void main(){
      float l = dot(normalize(vN), normalize(sun));
      float dayMix = smoothstep(-0.12, 0.18, l);
      vec3 d = texture2D(day, vUv).rgb * (0.25 + 0.95 * max(l, 0.0));
      vec3 n = texture2D(night, vUv).rgb * vec3(1.25, 1.05, 0.8) * 1.6;
      vec3 c = mix(n + vec3(0.004, 0.012, 0.03), d, dayMix);
      // thin bright twilight band
      c += vec3(1.0, 0.5, 0.25) * 0.07 * max(0.0, 1.0 - abs(l + 0.02) / 0.05);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), earthMat);
scene.add(earth);

// atmosphere glow
// Back faces of a slightly larger shell: brightest where the view ray grazes Earth's limb, fading to 0 at the shell edge.
const ATM_R = 1.12, LIMB = Math.sqrt(1 - 1 / (ATM_R * ATM_R));
scene.add(new THREE.Mesh(new THREE.SphereGeometry(ATM_R, 96, 64), new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  uniforms: { limb: { value: LIMB } },
  vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.); vP=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `uniform float limb; varying vec3 vN; varying vec3 vP;
    void main(){ float k = clamp(-dot(vN, vP) / limb, 0.0, 1.0); float i = pow(k, 4.0) * 0.9; gl_FragColor = vec4(0.32, 0.78, 1.0, 1.0) * i; }`,
})));

// glow sprite texture (drawn once)
function glowTexture(rgb) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(255,255,255,1)`); gr.addColorStop(0.15, `rgba(${rgb},0.95)`);
  gr.addColorStop(0.45, `rgba(${rgb},0.25)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowMat = (rgb, op = 1) => new THREE.SpriteMaterial({ map: glowTexture(rgb), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: op });

// ISS marker
const issGroup = new THREE.Group(); scene.add(issGroup);
const issGlow = new THREE.Sprite(glowMat('94,231,255')); issGlow.scale.setScalar(0.16); issGroup.add(issGlow);
const issCore = new THREE.Sprite(glowMat('255,255,255')); issCore.scale.setScalar(0.045); issGroup.add(issCore);
// nadir line from the station to the ground
const nadirGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
scene.add(new THREE.Line(nadirGeo, new THREE.LineBasicMaterial({ color: 0x5ee7ff, transparent: true, opacity: 0.45 })));

// orbit trail (past dim → future bright)
const TRAIL_N = 280;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
scene.add(trail);

// footprint: where on Earth the ISS is at least 10° above the horizon
const FOOT_N = 120;
const footGeo = new THREE.BufferGeometry();
footGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((FOOT_N + 1) * 3), 3));
scene.add(new THREE.Line(footGeo, new THREE.LineBasicMaterial({ color: 0x5ee7ff, transparent: true, opacity: 0.35 })));

// observer pin
const obsGroup = new THREE.Group(); obsGroup.visible = false; scene.add(obsGroup);
const obsGlow = new THREE.Sprite(glowMat('255,196,107')); obsGlow.scale.setScalar(0.07); obsGroup.add(obsGlow);
const ringGeo = new THREE.RingGeometry(0.018, 0.024, 48);
const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
obsGroup.add(ring);

// ---------- state ----------
let iss = null;
let obs = null;
let passes = [];
let following = false;
let lastTrail = 0, lastPasses = 0;

function setTrail(now) {
  const pos = trailGeo.attributes.position.array, col = trailGeo.attributes.color.array;
  const pastMin = 45, futureMin = 95, total = pastMin + futureMin;
  for (let i = 0; i < TRAIL_N; i++) {
    const m = -pastMin + (i / (TRAIL_N - 1)) * total;
    const g = iss.geo(new Date(now + m * 60e3));
    const v = vec(g.lat, g.lon, altR(g.alt));
    pos.set([v.x, v.y, v.z], i * 3);
    const f = m < 0 ? 0.15 + 0.35 * (1 + m / pastMin) : 1 - 0.75 * (m / futureMin);
    col.set([0.37 * f, 0.9 * f, 1.0 * f], i * 3);
  }
  trailGeo.attributes.position.needsUpdate = trailGeo.attributes.color.needsUpdate = true;
  trailGeo.computeBoundingSphere();
}

function setFootprint(g) {
  const el = 10 * I.DEG, R = I.RE, h = g.alt;
  const lam = Math.acos((R * Math.cos(el)) / (R + h)) - el; // angular radius
  const c = vec(g.lat, g.lon);
  const up = Math.abs(c.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e1 = new THREE.Vector3().crossVectors(up, c).normalize();
  const e2 = new THREE.Vector3().crossVectors(c, e1);
  const arr = footGeo.attributes.position.array;
  for (let i = 0; i <= FOOT_N; i++) {
    const a = (i / FOOT_N) * Math.PI * 2;
    const p = c.clone().multiplyScalar(Math.cos(lam))
      .addScaledVector(e1, Math.sin(lam) * Math.cos(a)).addScaledVector(e2, Math.sin(lam) * Math.sin(a))
      .multiplyScalar(1.002);
    arr.set([p.x, p.y, p.z], i * 3);
  }
  footGeo.attributes.position.needsUpdate = true;
  footGeo.computeBoundingSphere();
}

function setSun(date) {
  const s = I.sunEci(date), g = S.gstime(date);
  // ECI → ECEF (rotate by -GMST about Z), then ECEF → globe frame (x=X, y=Z, z=-Y)
  const X = s.x * Math.cos(g) + s.y * Math.sin(g);
  const Y = -s.x * Math.sin(g) + s.y * Math.cos(g);
  sunDir.set(X, s.z, -Y).normalize();
}

// ---------- panels ----------
const fmtDeg = (v, p, n) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? p : n}`;
function updateStats(g, now) {
  $('lat').textContent = fmtDeg(g.lat, 'N', 'S');
  $('lon').textContent = fmtDeg(g.lon, 'E', 'W');
  $('alt').textContent = Math.round(g.alt) + ' km';
  $('spd').textContent = Math.round(g.speed).toLocaleString() + ' km/h';
  let s = g.sunlit ? 'In sunlight' : "In Earth's shadow";
  if (obs) {
    const l = iss.look(new Date(now), obs);
    s += l.el > 0 ? ` · ${Math.round(l.el)}° above your horizon (${I.compass(l.az)})`
      : ` · ${Math.round(l.range).toLocaleString()} km from you, below horizon`;
  }
  $('state').textContent = s;
}

function recomputePasses(now) {
  if (!obs) return;
  passes = iss.passes(obs, new Date(now), 10);
  lastPasses = now;
  renderList();
}

function renderList() {
  const vis = passes.filter((p) => p.visible && p.visEnd > Date.now()).slice(0, 6);
  $('list').style.display = vis.length > 1 ? '' : 'none';
  $('rows').innerHTML = '';
  for (const p of vis.slice(1)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="d"></span><span class="e"></span><span class="m"></span><span class="m" style="text-align:right"></span>`;
    row.children[0].textContent = `${I.dateStr(p.visStart)} · ${I.timeStr(p.visStart)}`;
    row.children[1].textContent = `${Math.round(p.maxEl)}°`;
    row.children[2].textContent = `${I.compass(p.visStartLook.az)} → ${I.compass(p.visEndLook.az)} · ${Math.max(1, Math.round((p.visEnd - p.visStart) / 60e3))} min`;
    row.children[3].textContent = 'max height';
    $('rows').appendChild(row);
  }
}

function updateNext(now) {
  if (!obs) return;
  const vis = passes.filter((p) => p.visible && p.visEnd > now);
  const p = vis[0];
  const nv = $('nowVis');
  if (!p) {
    $('cd').textContent = '—'; $('when').textContent = 'No visible passes in the next 10 days';
    $('how').textContent = 'The ISS still flies over, but only in daylight or while it is in Earth\'s shadow.';
    nv.className = 'now-vis'; return;
  }
  if (now >= p.visStart) {
    const l = iss.look(new Date(now), obs);
    $('nextLabel').textContent = 'Visible right now';
    $('cd').textContent = I.countdown(p.visEnd - now);
    $('when').textContent = `Ends at ${I.timeStr(p.visEnd)}`;
    nv.className = 'now-vis on';
    nv.textContent = l.el > 0 && l.sunlit ? `Look ${I.compass(l.az)}, ${Math.round(l.el)}° up. Go outside now!` : 'Fading into Earth\'s shadow…';
  } else {
    $('nextLabel').textContent = 'Next visible flyover in';
    $('cd').textContent = I.countdown(p.visStart - now);
    $('when').textContent = `${I.dateStr(p.visStart)} at ${I.timeStr(p.visStart)}`;
    nv.className = 'now-vis';
  }
  const mins = Math.max(1, Math.round((p.visEnd - p.visStart) / 60e3));
  $('how').innerHTML = '';
  const parts = [
    ['Appears ', `${I.compass(p.visStartLook.az)} (${Math.round(p.visStartLook.el)}° up)`],
    [', rises to ', `${Math.round(p.maxEl)}°`],
    [', disappears ', `${I.compass(p.visEndLook.az)}`],
    [`. Visible ~${mins} min, `, I.brightness(p.maxEl) + '.'],
  ];
  for (const [t, b] of parts) { $('how').append(t); const el = document.createElement('b'); el.textContent = b; $('how').append(el); }
}

// ---------- location ----------
function setObserver(loc) {
  obs = I.observer(loc.lat, loc.lon, 0, loc.name);
  I.saveLocation(loc);
  $('locName').textContent = loc.name;
  const v = vec(loc.lat, loc.lon, 1.003);
  obsGroup.position.copy(v); obsGroup.visible = true;
  ring.lookAt(v.clone().multiplyScalar(2));
  $('search').classList.remove('open');
  recomputePasses(Date.now());
}
$('locBtn').onclick = () => { $('search').classList.toggle('open'); $('q').focus(); };
$('gps').onclick = async () => {
  $('results').textContent = 'Finding you…';
  try { setObserver(await I.geolocate()); $('results').textContent = ''; } catch (e) { $('results').textContent = e.message; }
};
let qTimer = 0;
$('q').addEventListener('input', () => {
  clearTimeout(qTimer);
  const q = $('q').value.trim();
  if (q.length < 2) { $('results').textContent = ''; return; }
  qTimer = setTimeout(async () => {
    try {
      const res = await I.searchCity(q);
      $('results').innerHTML = '';
      if (!res.length) $('results').textContent = 'No match';
      for (const r of res) {
        const b = document.createElement('button');
        b.textContent = r.name;
        b.onclick = () => setObserver(r);
        $('results').appendChild(b);
      }
    } catch (e) { $('results').textContent = 'Search unavailable offline'; }
  }, 300);
});

$('follow').onclick = () => { following = !following; $('follow').textContent = following ? 'Free look' : 'Follow ISS'; };
controls.addEventListener('start', () => { if (following) { following = false; $('follow').textContent = 'Follow ISS'; } });

// ---------- loop ----------
const label = $('issLabel');
const tmp = new THREE.Vector3();
function frame() {
  const now = Date.now();
  if (iss) {
    const date = new Date(now);
    const g = iss.geo(date);
    if (g) {
      const p = vec(g.lat, g.lon, altR(g.alt));
      issGroup.position.copy(p);
      const nadir = nadirGeo.attributes.position;
      nadir.setXYZ(0, p.x, p.y, p.z); const gnd = vec(g.lat, g.lon, 1.001); nadir.setXYZ(1, gnd.x, gnd.y, gnd.z); nadir.needsUpdate = true;
      issGlow.scale.setScalar(0.15 + 0.02 * Math.sin(now / 300));
      if (now - lastTrail > 5000) { setTrail(now); setFootprint(g); setSun(date); updateStats(g, now); lastTrail = now; }
      if (following) {
        const want = p.clone().normalize().multiplyScalar(camera.position.length());
        camera.position.lerp(want, 0.04);
      }
      // HTML label
      tmp.copy(p).project(camera);
      const behind = p.clone().normalize().dot(camera.position.clone().normalize()) < 0.15;
      label.style.display = behind ? 'none' : '';
      label.style.left = ((tmp.x + 1) / 2) * window.innerWidth + 'px';
      label.style.top = ((1 - tmp.y) / 2) * window.innerHeight + 'px';
      label.textContent = g.sunlit ? 'ISS' : 'ISS · in shadow';
    }
    updateNext(now);
    if (obs && now - lastPasses > 15 * 60e3) recomputePasses(now);
  }
  ring.scale.setScalar(1 + 0.6 * ((now / 1600) % 1));
  ring.material.opacity = 1 - ((now / 1600) % 1);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

async function start() {
  const tle = await I.fetchTle();
  iss = new I.Iss(tle);
  const age = I.tleAgeDays(tle);
  if (age > 7) $('foot').textContent = `Offline: using orbit data ${Math.round(age)} days old, so times may be off by a few minutes.`;
  const loc = I.savedLocation();
  if (loc) setObserver(loc);
  else {
    $('search').classList.add('open');
    I.geolocate().then(setObserver).catch(() => { /* user can search instead */ });
  }
  setSun(new Date());
  // start looking at the station
  const g = iss.geo(new Date());
  camera.position.copy(vec(g.lat, g.lon, 3.6));
  setTrail(Date.now()); setFootprint(g); updateStats(g, Date.now()); lastTrail = Date.now();
  // refresh orbit data every 6 h
  setInterval(async () => { iss.setTle(await I.fetchTle()); }, 6 * 3600e3);
}
requestAnimationFrame(frame);
start();
