// ISS sky view: camera + compass/tilt sensors → draws the ISS, its pass path, Sun and Moon over the live sky.
(function () {
  const I = window.ISS;
  const $ = (id) => document.getElementById(id);
  const D = I.DEG;
  const cv = $('sky'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  }
  window.addEventListener('resize', resize); resize();

  // ---------- state ----------
  let iss = null, obs = null, passes = [], lastPassCalc = 0;
  let sensorMode = 'none';            // 'absolute' | 'ios' | 'relative' | 'drag'
  let raw = null;                     // latest {alpha, beta, gamma}
  let yaw = 180, pitch = 25;          // drag mode (deg)
  let offset = 0, fov = 62;
  let clockShift = 0, clockRate = 1, previewEnd = 0, previewBase = 0; // preview pass playback
  const basis = { f: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1] }; // smoothed screen basis in ENU

  try {
    const s = JSON.parse(localStorage.getItem('iss-sky-v1') || '{}');
    if (typeof s.offset === 'number') offset = s.offset;
    if (typeof s.fov === 'number') fov = s.fov;
  } catch (e) { /* storage blocked */ }
  const saveSettings = () => { try { localStorage.setItem('iss-sky-v1', JSON.stringify({ offset, fov })); } catch (e) { /* ignore */ } };
  $('off').value = offset; $('offV').textContent = offset + '°';
  $('fov').value = fov; $('fovV').textContent = fov + '°';
  $('off').oninput = () => { offset = +$('off').value; $('offV').textContent = offset + '°'; saveSettings(); };
  $('fov').oninput = () => { fov = +$('fov').value; $('fovV').textContent = fov + '°'; saveSettings(); };
  $('settings').onclick = () => $('drawer').classList.toggle('open');

  const now = () => {
    const real = Date.now();
    if (!previewEnd) return real;
    const t = previewBase + (real - clockShift) * clockRate;
    if (t > previewEnd) { previewEnd = 0; $('preview').textContent = 'Preview pass'; return real; }
    return t;
  };

  // ---------- math ----------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  // az/el (deg) → ENU unit vector, with the compass fix applied
  function enu(az, el) {
    const a = (az - offset) * D, e = el * D;
    return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
  }
  function toAzEl(v) {
    const az = (Math.atan2(v[0], v[1]) / D + offset + 360) % 360;
    return { az, el: Math.asin(Math.max(-1, Math.min(1, v[2]))) / D };
  }

  // W3C device orientation → rotation matrix (device frame → East/North/Up)
  function deviceBasis(alpha, beta, gamma) {
    const a = alpha * D, b = beta * D, g = gamma * D;
    const cX = Math.cos(b), cY = Math.cos(g), cZ = Math.cos(a), sX = Math.sin(b), sY = Math.sin(g), sZ = Math.sin(a);
    const X = [cZ * cY - sZ * sX * sY, cY * sZ + cZ * sX * sY, -cX * sY];  // device x axis in ENU
    const Y = [-cX * sZ, cZ * cX, sX];                                    // device y axis
    const Z = [cY * sZ * sX + cZ * sY, sZ * sY - cZ * cY * sX, cX * cY];  // device z axis (out of screen)
    const ang = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * D;
    const r = [X[0] * Math.cos(ang) + Y[0] * Math.sin(ang), X[1] * Math.cos(ang) + Y[1] * Math.sin(ang), X[2] * Math.cos(ang) + Y[2] * Math.sin(ang)];
    const u = [-X[0] * Math.sin(ang) + Y[0] * Math.cos(ang), -X[1] * Math.sin(ang) + Y[1] * Math.cos(ang), -X[2] * Math.sin(ang) + Y[2] * Math.cos(ang)];
    return { f: [-Z[0], -Z[1], -Z[2]], r, u };
  }
  function dragBasis() {
    const y = yaw * D, p = pitch * D;
    const f = [Math.cos(p) * Math.sin(y), Math.cos(p) * Math.cos(y), Math.sin(p)];
    const r = [Math.cos(y), -Math.sin(y), 0];
    return { f, r, u: cross(r, f) };
  }
  function updateBasis() {
    let t = null;
    if (sensorMode === 'drag' || !raw) t = dragBasis();
    else t = deviceBasis(raw.alpha, raw.beta, raw.gamma);
    const k = sensorMode === 'drag' ? 1 : 0.22; // smooth sensor jitter
    let f = norm(lerp(basis.f, t.f, k));
    let u = lerp(basis.u, t.u, k);
    u = norm([u[0] - f[0] * dot(u, f), u[1] - f[1] * dot(u, f), u[2] - f[2] * dot(u, f)]);
    basis.f = f; basis.u = u; basis.r = cross(f, u);
  }
  function project(v) {
    const z = dot(v, basis.f);
    if (z <= 0.02) return null;
    const fpx = (H / 2) / Math.tan((fov * D) / 2);
    return { x: W / 2 + (fpx * dot(v, basis.r)) / z, y: H / 2 - (fpx * dot(v, basis.u)) / z };
  }
  const onScreen = (p, m = 0) => p && p.x > m && p.x < W - m && p.y > m && p.y < H - m;

  // ---------- moon (low precision, ~0.3°) ----------
  function moonEci(date) {
    const T = (date.getTime() / 86400e3 + 2440587.5 - 2451545) / 36525;
    const s = (x) => Math.sin(x * D), c = (x) => Math.cos(x * D);
    const lam = 218.32 + 481267.881 * T + 6.29 * s(135.0 + 477198.87 * T) - 1.27 * s(259.3 - 413335.36 * T)
      + 0.66 * s(235.7 + 890534.22 * T) + 0.21 * s(269.9 + 954397.74 * T) - 0.19 * s(357.5 + 35999.05 * T) - 0.11 * s(186.5 + 966404.03 * T);
    const bet = 5.13 * s(93.3 + 483202.02 * T) + 0.28 * s(228.2 + 960400.89 * T) - 0.28 * s(318.3 + 6003.15 * T) - 0.17 * s(217.6 - 407332.21 * T);
    const par = 0.9508 + 0.0518 * c(135.0 + 477198.87 * T) + 0.0095 * c(259.3 - 413335.36 * T) + 0.0078 * c(235.7 + 890534.22 * T) + 0.0028 * c(269.9 + 954397.74 * T);
    const r = I.RE / Math.sin(par * D);
    const l = lam * D, b = bet * D, eps = 23.439 * D;
    const x = r * Math.cos(b) * Math.cos(l), y = r * Math.cos(b) * Math.sin(l), z = r * Math.sin(b);
    return { x, y: y * Math.cos(eps) - z * Math.sin(eps), z: y * Math.sin(eps) + z * Math.cos(eps) };
  }
  function lookEci(eci, date) {
    const S = window.satellite;
    const la = S.ecfToLookAngles(obs.gd, S.eciToEcf(eci, S.gstime(date)));
    return { az: la.azimuth / D, el: la.elevation / D };
  }

  // ---------- drawing ----------
  const COL = { accent: '#5ee7ff', good: '#7dffb0', warn: '#ffc46b', text: '#e8f3ff', dim: 'rgba(168,191,211,0.55)', grid: 'rgba(168,191,211,0.18)' };
  function pathAlong(points, stroke, width, dash) {
    ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let pen = false;
    for (const v of points) {
      const p = project(v);
      if (!p) { pen = false; continue; }
      if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      pen = true;
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  function text(t, x, y, col, size = 13, align = 'left', weight = 600) {
    ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(t, x, y);
    ctx.fillStyle = col; ctx.fillText(t, x, y);
    ctx.textAlign = 'left';
  }
  function glow(x, y, r, rgb) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.2, `rgba(${rgb},0.9)`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  function drawGrid() {
    // altitude rings
    for (const el of [30, 60]) {
      const pts = []; for (let az = 0; az <= 360; az += 3) pts.push(enu(az, el));
      pathAlong(pts, COL.grid, 1, [4, 6]);
      const p = project(enu(basisAz(), el));
      if (onScreen(p, 10)) text(el + '°', p.x + 6, p.y - 4, COL.dim, 11, 'left', 500);
    }
    // horizon
    const hz = []; for (let az = 0; az <= 360; az += 2) hz.push(enu(az, 0));
    pathAlong(hz, 'rgba(94,231,255,0.55)', 1.5);
    // ground shading hint: label
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let az = 0; az < 360; az += 15) {
      const top = project(enu(az, 0)), bot = project(enu(az, az % 45 === 0 ? -3 : -1.5));
      if (!top || !bot) continue;
      ctx.strokeStyle = 'rgba(94,231,255,0.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
      if (az % 45 === 0) {
        const lp = project(enu(az, -6));
        if (lp) text(names[az / 45], lp.x, lp.y, az === 0 ? COL.warn : COL.text, az % 90 === 0 ? 17 : 13, 'center', 700);
      }
    }
  }
  const basisAz = () => toAzEl(basis.f).az;

  function drawBody(look, name, rgb, r) {
    const p = project(enu(look.az, look.el));
    if (!onScreen(p, -40)) return;
    glow(p.x, p.y, r, rgb);
    text(look.el > 0 ? name : `${name} (below horizon)`, p.x + r * 0.5 + 6, p.y + 4, `rgb(${rgb})`, 12);
  }

  function drawPass(p, t) {
    if (!p) return;
    const pts = p.points;
    // full arc (dim) then visible part (bright)
    pathAlong(pts.map((q) => enu(q.az, q.el)), 'rgba(94,231,255,0.35)', 2, [6, 6]);
    const visPts = pts.filter((q) => q.vis).map((q) => enu(q.az, q.el));
    if (visPts.length > 1) pathAlong(visPts, 'rgba(125,255,176,0.9)', 3);
    // minute ticks with clock labels
    for (let m = Math.ceil(p.start / 60e3) * 60e3; m < p.end; m += 60e3) {
      const l = iss.look(new Date(m), obs);
      const q = project(enu(l.az, l.el));
      if (!onScreen(q)) continue;
      ctx.fillStyle = COL.text; ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
      text(I.timeStr(m), q.x + 8, q.y - 6, COL.dim, 11, 'left', 500);
    }
    // start / end markers of the visible part
    if (p.visible) {
      const a = project(enu(p.visStartLook.az, p.visStartLook.el));
      const b = project(enu(p.visEndLook.az, p.visEndLook.el));
      if (onScreen(a)) text(`appears ${I.timeStr(p.visStart)}`, a.x + 10, a.y + 18, COL.good, 13);
      if (onScreen(b)) text(`fades ${I.timeStr(p.visEnd)}`, b.x + 10, b.y + 18, COL.good, 13);
    }
  }

  function drawPointer(v, label) {
    // arrow at the screen edge pointing toward an off-screen target
    const x = dot(v, basis.r), y = dot(v, basis.u), z = dot(v, basis.f);
    let dx = x, dy = -y;
    if (z < 0) { dx = x >= 0 ? 1 : -1; dy = 0; } // behind you: always point sideways (turn around)
    const ang = Math.atan2(dy, dx);
    const m = 46;
    const cx = W / 2, cy = H / 2;
    const k = Math.min((W / 2 - m) / Math.abs(Math.cos(ang) || 1e-6), (H / 2 - m - 70) / Math.abs(Math.sin(ang) || 1e-6));
    const px = cx + Math.cos(ang) * k, py = cy + Math.sin(ang) * k;
    ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
    ctx.fillStyle = COL.accent;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -11); ctx.lineTo(-4, 0); ctx.lineTo(-10, 11); ctx.closePath(); ctx.fill();
    ctx.restore();
    const turn = Math.abs(x) > Math.abs(y) || z < 0 ? (x >= 0 ? 'turn right' : 'turn left') : (y > 0 ? 'tilt up' : 'tilt down');
    const ca = Math.cos(ang);
    const align = ca > 0.5 ? 'right' : ca < -0.5 ? 'left' : 'center';
    const ty = Math.abs(Math.sin(ang)) > 0.5 ? py - Math.sin(ang) * 30 + 4 : py + 4;
    text(`${label} · ${turn}`, px - ca * 24, ty, COL.accent, 13, align);
  }

  function frame() {
    updateBasis();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!iss || !obs) { requestAnimationFrame(frame); return; }
    const t = now(), date = new Date(t);
    if (!previewEnd && t - lastPassCalc > 10 * 60e3) { passes = iss.passes(obs, new Date(t), 10); lastPassCalc = t; }

    drawGrid();
    drawBody(I.sunLook(date, obs), 'Sun', '255,196,107', 26);
    drawBody(lookEci(moonEci(date), date), 'Moon', '220,230,255', 18);

    const look = iss.look(date, obs);
    // during a preview without sensors, glide the view along with the station
    if (previewEnd && sensorMode === 'drag' && !drag && look.el > -5) {
      const wantYaw = look.az - offset, wantPitch = Math.min(80, Math.max(10, look.el));
      const dy = ((wantYaw - yaw + 540) % 360) - 180;
      yaw += dy * 0.12; pitch += (wantPitch - pitch) * 0.12;
    }
    const vis = passes.filter((p) => p.visible && p.visEnd > t);
    const next = vis[0];
    const active = passes.find((p) => t >= p.start && t <= p.end);
    drawPass(active || next, t);

    // the station itself
    const iv = enu(look.az, look.el);
    const ip = project(iv);
    const seen = look.el > 0 && look.sunlit && I.sunLook(date, obs).el < -6;
    if (onScreen(ip, -30)) {
      glow(ip.x, ip.y, seen ? 30 : 20, seen ? '125,255,176' : '94,231,255');
      ctx.strokeStyle = seen ? COL.good : COL.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ip.x, ip.y, 22 + 3 * Math.sin(Date.now() / 250), 0, Math.PI * 2); ctx.stroke();
      const sub = look.el > 0 ? `${Math.round(look.el)}° up · ${Math.round(look.range).toLocaleString()} km`
        : `below horizon · ${Math.round(look.range).toLocaleString()} km`;
      text('ISS', ip.x + 30, ip.y - 2, seen ? COL.good : COL.text, 16, 'left', 700);
      text(sub, ip.x + 30, ip.y + 15, COL.dim, 12, 'left', 500);
    }

    // guidance arrow: to the station during a pass, otherwise to where the next one appears
    let target = null, tlabel = '';
    if (active && look.el > 0) { target = iv; tlabel = 'ISS'; }
    else if (next) { target = enu(next.visStartLook.az, next.visStartLook.el); tlabel = `appears ${I.timeStr(next.visStart)}`; }
    if (target && !onScreen(project(target), 40)) drawPointer(target, tlabel);

    // HUD
    const a = toAzEl(basis.f);
    $('facing').textContent = `Facing ${Math.round(a.az)}° ${I.compass(a.az)} · ${Math.round(a.el)}° up` + (previewEnd ? ' · preview ×30' : '');
    updateCountdown(t, next, look, seen);
    requestAnimationFrame(frame);
  }

  function updateCountdown(t, next, look, seen) {
    const b = $('banner');
    if (seen) { b.textContent = `ISS visible now · look ${I.compass(look.az)}, ${Math.round(look.el)}° up`; b.classList.add('on'); }
    else b.classList.remove('on');
    if (!next) { $('cd').textContent = '—'; $('cdSub').textContent = 'No visible pass in the next 10 days'; return; }
    if (t >= next.visStart) {
      $('cdLabel').textContent = 'Visible now, ends in';
      $('cd').textContent = I.countdown(next.visEnd - t);
    } else {
      $('cdLabel').textContent = 'Next visible flyover in';
      $('cd').textContent = I.countdown(next.visStart - t);
    }
    $('cdSub').textContent = `${I.dateStr(next.visStart)} ${I.timeStr(next.visStart)} · ${I.compass(next.visStartLook.az)} → ${I.compass(next.visEndLook.az)} · max ${Math.round(next.maxEl)}° · ${obs.name}`;
  }

  // ---------- buttons ----------
  $('aim').onclick = () => {
    // in drag mode jump the view; with sensors, the arrow already guides the user
    const t = now(), look = iss.look(new Date(t), obs);
    const next = passes.find((p) => p.visible && p.visEnd > t);
    const tgt = look.el > 0 || !next ? look : next.visStartLook;
    if (sensorMode === 'drag') { yaw = tgt.az - offset; pitch = Math.max(5, tgt.el); }
    else flash(`Look ${I.compass(tgt.az)} (${Math.round(tgt.az)}°), ${Math.round(Math.max(0, tgt.el))}° up`);
  };
  $('preview').onclick = () => {
    if (previewEnd) { previewEnd = 0; $('preview').textContent = 'Preview pass'; return; }
    const next = passes.find((p) => p.visible && p.visEnd > Date.now());
    if (!next) return flash('No visible pass to preview');
    previewBase = next.start; previewEnd = next.end; clockShift = Date.now(); clockRate = 30;
    $('preview').textContent = 'Stop preview';
    if (sensorMode === 'drag') { yaw = next.maxAz - offset; pitch = Math.min(70, next.maxEl * 0.7); }
  };
  let flashTimer = 0;
  function flash(msg) {
    const b = $('banner'); b.textContent = msg; b.classList.add('on');
    clearTimeout(flashTimer); flashTimer = setTimeout(() => b.classList.remove('on'), 4000);
  }

  // drag to look (desktop / no sensors)
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { if (sensorMode === 'drag') { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; cv.setPointerCapture(e.pointerId); } });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = fov / H;
    yaw = drag.yaw - (e.clientX - drag.x) * k;
    pitch = Math.max(-30, Math.min(89, drag.pitch + (e.clientY - drag.y) * k));
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('wheel', (e) => { fov = Math.max(35, Math.min(90, fov + Math.sign(e.deltaY) * 3)); $('fov').value = fov; $('fovV').textContent = fov + '°'; }, { passive: true });

  // ---------- sensors / camera ----------
  function listenOrientation() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (m) => { if (!settled) { settled = true; resolve(m); } };
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', (e) => {
          if (e.alpha == null) return;
          raw = { alpha: e.alpha, beta: e.beta, gamma: e.gamma }; done('absolute');
        });
      }
      window.addEventListener('deviceorientation', (e) => {
        if (e.webkitCompassHeading != null) { raw = { alpha: 360 - e.webkitCompassHeading, beta: e.beta, gamma: e.gamma }; done('ios'); }
        else if (e.absolute && e.alpha != null) { raw = { alpha: e.alpha, beta: e.beta, gamma: e.gamma }; done('absolute'); }
      });
      setTimeout(() => done(null), 2500);
    });
  }

  async function startSensors(withCamera) {
    $('gateErr').textContent = '';
    // iOS asks for motion permission and needs a tap to do it
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { await DeviceOrientationEvent.requestPermission(); } catch (e) { /* denied → drag mode */ }
    }
    if (withCamera) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        const v = $('cam'); v.srcObject = stream; v.style.display = 'block';
        await v.play().catch(() => {});
      } catch (e) {
        $('gateErr').textContent = window.isSecureContext
          ? 'Camera not available (' + (e.name || e.message) + '). Showing a drawn sky instead.'
          : 'The camera needs a secure (https) link. Showing a drawn sky instead.';
      }
    }
    const mode = await listenOrientation();
    sensorMode = mode || 'drag';
    if (!mode) {
      $('facing').title = 'No compass found: drag to look around';
      if (withCamera) flash('No compass found on this device: drag the screen to look around');
    }
    $('gate').style.display = $('gateErr').textContent ? 'flex' : 'none';
    if ($('gateErr').textContent) setTimeout(() => { $('gate').style.display = 'none'; }, 2500);
  }
  $('start').onclick = () => startSensors(true);
  $('noCam').onclick = () => startSensors(false);

  // ---------- boot ----------
  async function boot() {
    const tle = await I.fetchTle();
    iss = new I.Iss(tle);
    let loc = I.savedLocation();
    if (!loc) {
      try { loc = await I.geolocate(); I.saveLocation(loc); } catch (e) {
        $('cdSub').textContent = 'Set your city on the globe page first';
        return;
      }
    }
    obs = I.observer(loc.lat, loc.lon, 0, loc.name);
    passes = iss.passes(obs, new Date(), 10); lastPassCalc = Date.now();
  }
  boot();
  requestAnimationFrame(frame);
})();
