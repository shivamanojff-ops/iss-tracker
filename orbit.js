// ISS orbit core shared by the globe and the sky view.
// Needs satellite.js v5 loaded first (global `satellite`).
(function () {
  const S = window.satellite;
  const RE = 6371;                 // km
  const DEG = Math.PI / 180;
  const TLE_KEY = 'iss-tle-v1';
  const LOC_KEY = 'iss-loc-v1';
  // Backup TLE (2026-11-05) so the app still works offline; refreshed from the network when possible.
  const FALLBACK = {
    line1: '1 25544U 98067A   26309.85320381  .00006629  00000+0  12749-3 0  9998',
    line2: '2 25544  51.6327 319.0560 0007195 352.5747   7.5134 15.49194530593711',
    fetched: 0,
  };

  // ---------- TLE ----------
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }

  async function fetchTle() {
    const cached = load(TLE_KEY);
    if (cached && Date.now() - cached.fetched < 6 * 3600e3) return cached;
    const sources = [
      async () => {
        const j = await (await fetch('https://api.wheretheiss.at/v1/satellites/25544/tles')).json();
        return { line1: j.line1, line2: j.line2 };
      },
      async () => {
        const t = (await (await fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE')).text()).trim().split(/\r?\n/);
        return { line1: t[1].trim(), line2: t[2].trim() };
      },
    ];
    for (const src of sources) {
      try {
        const t = await src();
        if (t.line1 && t.line1.startsWith('1 25544')) { t.fetched = Date.now(); store(TLE_KEY, t); return t; }
      } catch (e) { /* try next */ }
    }
    return cached || FALLBACK;
  }

  function tleAgeDays(tle) {
    // epoch from line 1 columns 19-32 (YYDDD.DDDDDDDD)
    const yy = +tle.line1.slice(18, 20), doy = +tle.line1.slice(20, 32);
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const epoch = Date.UTC(year, 0, 1) + (doy - 1) * 86400e3;
    return (Date.now() - epoch) / 86400e3;
  }

  // ---------- sun ----------
  // Low-precision solar position (Astronomical Almanac), good to ~0.01°.
  function sunEci(date) {
    const jd = date.getTime() / 86400e3 + 2440587.5;
    const n = jd - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    const AU = 149597870.7 * (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g));
    return {
      x: AU * Math.cos(lambda),
      y: AU * Math.cos(eps) * Math.sin(lambda),
      z: AU * Math.sin(eps) * Math.sin(lambda),
    };
  }
  function lookFromEci(eci, date, obs) {
    const gmst = S.gstime(date);
    const ecf = S.eciToEcf(eci, gmst);
    const la = S.ecfToLookAngles(obs.gd, ecf);
    return { az: la.azimuth / DEG, el: la.elevation / DEG, range: la.rangeSat };
  }
  function sunLook(date, obs) { return lookFromEci(sunEci(date), date, obs); }

  // ISS in Earth's shadow? (cylindrical shadow model)
  function sunlit(posEci, date) {
    const s = sunEci(date);
    const sl = Math.hypot(s.x, s.y, s.z);
    const ux = s.x / sl, uy = s.y / sl, uz = s.z / sl;
    const d = posEci.x * ux + posEci.y * uy + posEci.z * uz;
    if (d > 0) return true;
    const perp2 = posEci.x ** 2 + posEci.y ** 2 + posEci.z ** 2 - d * d;
    return perp2 > RE * RE;
  }

  // ---------- satellite ----------
  class Iss {
    constructor(tle) { this.setTle(tle); }
    setTle(tle) { this.tle = tle; this.rec = S.twoline2satrec(tle.line1, tle.line2); }
    eci(date) { const pv = S.propagate(this.rec, date); return pv && pv.position ? pv : null; }
    geo(date) {
      const pv = this.eci(date);
      if (!pv) return null;
      const gd = S.eciToGeodetic(pv.position, S.gstime(date));
      const v = pv.velocity;
      return {
        lat: S.degreesLat(gd.latitude), lon: S.degreesLong(gd.longitude), alt: gd.height,
        speed: Math.hypot(v.x, v.y, v.z) * 3600, // km/h (inertial)
        sunlit: sunlit(pv.position, date),
      };
    }
    look(date, obs) {
      const pv = this.eci(date);
      if (!pv) return null;
      const l = lookFromEci(pv.position, date, obs);
      l.sunlit = sunlit(pv.position, date);
      return l;
    }
    groundTrack(fromDate, minutes, stepSec = 30) {
      const out = [];
      for (let s = 0; s <= minutes * 60; s += stepSec) {
        const g = this.geo(new Date(fromDate.getTime() + s * 1000));
        if (g) out.push(g);
      }
      return out;
    }

    // Find passes above minEl over the next `days`. A pass is "visible" when, at some moment,
    // the ISS is sunlit, above minEl, and the observer's sky is dark (sun below -6°).
    passes(obs, start = new Date(), days = 10, minEl = 10) {
      const step = 20e3;
      const end = start.getTime() + days * 86400e3;
      const el = (t) => { const l = this.look(new Date(t), obs); return l ? l.el : -90; };
      const edge = (a, b) => { // binary search for the minEl crossing between a and b
        const up = el(a) < minEl;
        for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if ((el(m) < minEl) === up) a = m; else b = m; }
        return (a + b) / 2;
      };
      const out = [];
      let prev = start.getTime(), prevEl = el(prev);
      let cur = null;
      if (prevEl >= minEl) cur = { start: prev, inProgress: true };
      for (let t = prev + step; t <= end; t += step) {
        const e = el(t);
        if (!cur && e >= minEl && prevEl < minEl) cur = { start: edge(t - step, t) };
        if (cur && e < minEl && prevEl >= minEl) {
          cur.end = edge(t - step, t);
          out.push(this.describePass(cur, obs, minEl));
          cur = null;
          if (out.length >= 60) break;
        }
        prev = t; prevEl = e;
      }
      return out;
    }

    describePass(p, obs, minEl) {
      let maxEl = -90, maxT = p.start, visStart = null, visEnd = null;
      const pts = [];
      for (let t = p.start; t <= p.end; t += 10e3) {
        const d = new Date(t);
        const l = this.look(d, obs);
        const sun = sunLook(d, obs);
        const vis = l.el >= minEl && l.sunlit && sun.el < -6;
        if (l.el > maxEl) { maxEl = l.el; maxT = t; }
        if (vis) { if (visStart == null) visStart = t; visEnd = t; }
        pts.push({ t, az: l.az, el: l.el, vis });
      }
      const at = (t) => this.look(new Date(t), obs);
      const sunAtMax = sunLook(new Date(maxT), obs);
      return {
        start: p.start, end: p.end, maxT, maxEl, inProgress: !!p.inProgress,
        startAz: at(p.start).az, endAz: at(p.end).az, maxAz: at(maxT).az,
        visible: visStart != null, visStart, visEnd,
        visStartLook: visStart != null ? at(visStart) : null,
        visEndLook: visEnd != null ? at(visEnd) : null,
        sky: sunAtMax.el < -6 ? 'dark' : sunAtMax.el < 0 ? 'twilight' : 'daylight',
        points: pts,
      };
    }
  }

  // ---------- observer / location ----------
  function observer(lat, lon, heightKm = 0, name = '') {
    return { lat, lon, name, gd: { latitude: lat * DEG, longitude: lon * DEG, height: heightKm } };
  }
  function savedLocation() { return load(LOC_KEY); }
  function saveLocation(loc) { store(LOC_KEY, loc); }
  function geolocate() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('Location is not available in this browser'));
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, name: 'My location' }),
        (e) => rej(new Error(e.message || 'Location permission denied')),
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    });
  }
  async function searchCity(q) {
    const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=' + encodeURIComponent(q));
    const j = await r.json();
    return (j.results || []).map((c) => ({
      lat: c.latitude, lon: c.longitude,
      name: [c.name, c.admin1, c.country_code].filter(Boolean).join(', '),
    }));
  }

  // ---------- formatting ----------
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (az) => DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
  function countdown(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return (d ? d + 'd ' : '') + `${p(h)}:${p(m)}:${p(r)}`;
  }
  const timeStr = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  function brightness(maxEl) {
    return maxEl > 60 ? 'very bright, almost overhead' : maxEl > 35 ? 'bright, high in the sky' : maxEl > 20 ? 'easy to spot' : 'low near the horizon';
  }

  window.ISS = {
    RE, DEG, Iss, fetchTle, tleAgeDays, sunEci, sunLook, sunlit, observer, savedLocation, saveLocation,
    geolocate, searchCity, compass, countdown, timeStr, dateStr, brightness,
  };
})();
