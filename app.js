// Satellite Orbit Viewer — Cesium + satellite.js
// Reads data/full_catalog.tle, groups by name prefix, propagates SGP4
// in-browser, renders as point primitives. Click-to-track, top timeline
// for time scrubbing. Plan: ~/.claude/plans/cheerful-stirring-bonbon.md

const GROUP_RULES = [
  { re: /^STARLINK/,                  label: "Starlink",        color: [255, 120, 120] },
  { re: /^ONEWEB/,                    label: "OneWeb",          color: [120, 180, 255] },
  { re: /^IRIDIUM/,                   label: "Iridium",         color: [255, 200, 120] },
  { re: /^GPS BII?I?/,                label: "GPS",             color: [120, 255, 160] },
  { re: /^GALILEO/,                   label: "Galileo",         color: [180, 120, 255] },
  { re: /^(COSMOS \d+|GLONASS)/,      label: "GLONASS",         color: [255, 255, 120] },
  { re: /^BEIDOU/,                    label: "BeiDou",          color: [255, 160,  80] },
  { re: /^GLOBALSTAR/,                label: "Globalstar",      color: [200, 200, 255] },
  { re: /^O3B/,                       label: "O3b MEO",         color: [120, 220, 220] },
  { re: /^(FLOCK|PLANET)/,            label: "Planet Labs",     color: [220, 120, 220] },
  { re: /^(ISS|TIANGONG|CSS|TIANHE)/, label: "Crewed stations", color: [255,  80,  80] },
  { re: /^(USA |OPS )/,               label: "US military",     color: [180, 180, 180] },
];
const OTHER_COLOR = [160, 160, 160];

// ---------- Cesium setup ----------
Cesium.Ion.defaultAccessToken = ""; // offline imagery only

const viewer = new Cesium.Viewer("cesium-container", {
  animation: true,
  timeline: true,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: true,
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
    )
  ),
});
viewer.scene.globe.enableLighting = true;

// ±14 days from now (SGP4 accuracy envelope)
const nowJD = Cesium.JulianDate.now();
viewer.clock.startTime    = Cesium.JulianDate.addDays(nowJD, -14, new Cesium.JulianDate());
viewer.clock.stopTime     = Cesium.JulianDate.addDays(nowJD,  14, new Cesium.JulianDate());
viewer.clock.currentTime  = Cesium.JulianDate.clone(nowJD);
viewer.clock.clockRange   = Cesium.ClockRange.CLAMPED;
viewer.clock.multiplier   = 1;
viewer.clock.shouldAnimate = true;
viewer.timeline.zoomTo(viewer.clock.startTime, viewer.clock.stopTime);

// ---------- Sun position helpers ----------
// Low-precision sub-solar point (sun directly overhead) — accurate to ~0.01°,
// more than enough for terminator + twilight visualization.
function sunSubpoint(jsDate) {
  const n = (jsDate.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const L = (280.460 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  const ra  = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = satellite.gstime(jsDate);
  let lon = ra - gmst;
  while (lon >  Math.PI) lon -= 2 * Math.PI;
  while (lon < -Math.PI) lon += 2 * Math.PI;
  return { lat: dec, lon };
}

function sunECEFkm(jsDate) {
  // Sun position in Earth-fixed frame (km), from low-precision formulas.
  const sub = sunSubpoint(jsDate);
  const auKm = 149597870.7;
  return {
    x: auKm * Math.cos(sub.lat) * Math.cos(sub.lon),
    y: auKm * Math.cos(sub.lat) * Math.sin(sub.lon),
    z: auKm * Math.sin(sub.lat),
  };
}

function sunElevationAt(observer, jsDate) {
  const ecf = sunECEFkm(jsDate);
  return satellite.ecfToLookAngles(observer, ecf).elevation;
}

// Spherical small-circle: point at angular distance angRad from (lat0,lon0)
// along bearing brg (radians clockwise from north).
function pointAtAng(lat0, lon0, angRad, brg) {
  const sinLat = Math.sin(lat0) * Math.cos(angRad) +
                 Math.cos(lat0) * Math.sin(angRad) * Math.cos(brg);
  const lat = Math.asin(sinLat);
  const lon = lon0 + Math.atan2(
    Math.sin(brg) * Math.sin(angRad) * Math.cos(lat0),
    Math.cos(angRad) - Math.sin(lat0) * sinLat);
  return Cesium.Cartesian3.fromRadians(lon, lat, 0);
}

function ringPositions(subLat, subLon, angDeg, samples = 180) {
  const ang = Cesium.Math.toRadians(angDeg);
  const out = [];
  for (let i = 0; i < samples; i++) {
    out.push(pointAtAng(subLat, subLon, ang, 2 * Math.PI * i / samples));
  }
  return out;
}

// ---------- Twilight bands ----------
// Three translucent rings on the night side of the geometric terminator:
//   90°–96°  = civil twilight (sun 0° → -6°)
//   96°–102° = nautical twilight (sun -6° → -12°)
//   102°–108° = astronomical twilight (sun -12° → -18°)
const twilightEntities = [];

function makeTwilightBand(innerDeg, outerDeg, color) {
  return viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(time => {
        const jsDate = Cesium.JulianDate.toDate(time);
        const sub = sunSubpoint(jsDate);
        const outer = ringPositions(sub.lat, sub.lon, outerDeg);
        const inner = ringPositions(sub.lat, sub.lon, innerDeg);
        return new Cesium.PolygonHierarchy(outer, [new Cesium.PolygonHierarchy(inner)]);
      }, false),
      material: color,
      height: 0,
    },
  });
}

function setTwilightVisible(on) {
  if (on && twilightEntities.length === 0) {
    twilightEntities.push(
      makeTwilightBand(90,  96,  Cesium.Color.fromCssColorString("#ffb84d").withAlpha(0.18)),
      makeTwilightBand(96,  102, Cesium.Color.fromCssColorString("#4d6bb8").withAlpha(0.22)),
      makeTwilightBand(102, 108, Cesium.Color.fromCssColorString("#1a2654").withAlpha(0.25)),
    );
  } else if (!on) {
    for (const e of twilightEntities) viewer.entities.remove(e);
    twilightEntities.length = 0;
  }
}

// ---------- Cloud cover overlay (CIMSS RealEarth) ----------
// 3 geostationary satellites' clean-IR Band 13/09: G16 (Americas),
// Met11 (Europe/Africa), Himawari (Asia/Pacific). EPSG:4326 tiles, ~30 min
// update cadence, no API key needed. Each layer is transparent outside its
// satellite's footprint, so overlaying all three gives near-global coverage.
const CLOUD_PRODUCTS = [
  "G16-C-BAND13",          // GOES-East — Americas
  "Met11-SEVIRI-FD-BAND09",// Meteosat-11 at 0° — Europe/Africa
  "Met8-SEVIRI-FD-BAND09", // Meteosat-8 at 41.5°E — Indian Ocean
  "HIMAWARI-B13",          // Himawari at 140°E — Asia/Pacific
];
const cloudLayers = [];

function setCloudCoverVisible(on) {
  if (on) {
    for (const product of CLOUD_PRODUCTS) {
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: `https://realearth.ssec.wisc.edu/api/image?products=${product}&x={x}&y={y}&z={z}`,
        tilingScheme: new Cesium.GeographicTilingScheme(),
        maximumLevel: 8,
        credit: "Imagery © UW-Madison SSEC / CIMSS RealEarth",
      });
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      layer.alpha = 0.6;
      cloudLayers.push(layer);
    }
  } else {
    for (const layer of cloudLayers) viewer.imageryLayers.remove(layer);
    cloudLayers.length = 0;
  }
}

// ---------- State ----------
let ALL_SATS = [];                                 // parsed catalog
const VISIBLE = new Set();                         // currently rendered
const groupVisible = new Map();                    // group label -> bool
const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
let trackedSat    = null;
let trackedEntity = null;
let orbitPolyline = null;
let footprint     = null;
let groundTrack   = null;

// Colorado Springs observer (for pass predictions).
const COS_OBSERVER = {
  latitude:  Cesium.Math.toRadians(38.9194),
  longitude: Cesium.Math.toRadians(-104.7509),
  height:    1.890, // km, ~6,200 ft elevation
};

// ---------- TLE load + parse ----------
async function loadTLEs() {
  const resp = await fetch("data/full_catalog.tle");
  if (!resp.ok) throw new Error(`Failed to fetch TLE: ${resp.status}`);
  const txt = await resp.text();
  const lines = txt.split(/\r?\n/);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i]   || "").trim();
    const l1   = (lines[i+1] || "").trim();
    const l2   = (lines[i+2] || "").trim();
    if (!name || !l1.startsWith("1 ") || !l2.startsWith("2 ")) continue;
    const noradId = parseInt(l1.slice(2, 7), 10);
    let group = "Other", color = OTHER_COLOR;
    for (const rule of GROUP_RULES) {
      if (rule.re.test(name)) { group = rule.label; color = rule.color; break; }
    }
    let satrec;
    try { satrec = satellite.twoline2satrec(l1, l2); } catch { continue; }
    if (!satrec || satrec.error) continue;
    sats.push({ name, noradId, group, color, satrec, pp: null });
  }
  return sats;
}

// ---------- SGP4 propagation ----------
function propagate(sat, jsDate) {
  const pv = satellite.propagate(sat.satrec, jsDate);
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(jsDate);
  const geo  = satellite.eciToGeodetic(pv.position, gmst);
  return Cesium.Cartesian3.fromRadians(geo.longitude, geo.latitude, geo.height * 1000);
}

// ---------- Render loop ----------
viewer.scene.preUpdate.addEventListener(() => {
  if (VISIBLE.size === 0) return;
  const jsDate = Cesium.JulianDate.toDate(viewer.clock.currentTime);
  for (const sat of VISIBLE) {
    if (!sat.pp) continue;
    const pos = propagate(sat, jsDate);
    if (pos) sat.pp.position = pos;
  }
});

// ---------- Visibility ----------
function addToScene(sat) {
  if (sat.pp) return;
  const [r, g, b] = sat.color;
  sat.pp = points.add({
    position: new Cesium.Cartesian3(0, 0, 0),
    color: new Cesium.Color(r/255, g/255, b/255, 1.0),
    pixelSize: 3,
  });
  VISIBLE.add(sat);
}
function removeFromScene(sat) {
  if (sat.pp) { points.remove(sat.pp); sat.pp = null; }
  VISIBLE.delete(sat);
  if (trackedSat === sat) releaseTracking();
}
function setGroupVisible(group, on) {
  groupVisible.set(group, on);
  for (const sat of ALL_SATS) {
    if (sat.group !== group) continue;
    if (on) addToScene(sat); else removeFromScene(sat);
  }
  updateStatus();
}

// ---------- Sidebar ----------
function buildGroupsUI() {
  const counts = new Map();
  for (const sat of ALL_SATS) counts.set(sat.group, (counts.get(sat.group) || 0) + 1);
  const groupOrder = [...GROUP_RULES.map(r => r.label), "Other"];
  const colorOf = label => {
    const r = GROUP_RULES.find(g => g.label === label);
    return r ? r.color : OTHER_COLOR;
  };
  const div = document.getElementById("groups");
  div.innerHTML = "";
  for (const label of groupOrder) {
    if (!counts.has(label)) continue;
    const [r, g, b] = colorOf(label);
    const row = document.createElement("label");
    row.className = "group";
    row.innerHTML = `
      <input type="checkbox" data-group="${label}">
      <span class="swatch" style="background:rgb(${r},${g},${b})"></span>
      <span>${label}</span>
      <span class="count">${counts.get(label).toLocaleString()}</span>`;
    row.querySelector("input").addEventListener("change", e => {
      setGroupVisible(label, e.target.checked);
    });
    div.appendChild(row);
  }
}

function updateStatus() {
  document.getElementById("status").textContent =
    `${ALL_SATS.length.toLocaleString()} cataloged · ${VISIBLE.size.toLocaleString()} visible`;
}

// ---------- Search ----------
function setupSearch() {
  const box = document.getElementById("search");
  const out = document.getElementById("search-results");
  box.addEventListener("input", () => {
    const q = box.value.trim().toUpperCase();
    out.innerHTML = "";
    if (q.length < 2) return;
    const hits = [];
    for (const sat of ALL_SATS) {
      if (sat.name.includes(q) || String(sat.noradId) === q) {
        hits.push(sat);
        if (hits.length >= 20) break;
      }
    }
    for (const sat of hits) {
      const row = document.createElement("div");
      row.className = "result";
      row.innerHTML = `${sat.name} <span class="nid">#${sat.noradId}</span>`;
      row.addEventListener("click", () => trackSat(sat));
      out.appendChild(row);
    }
  });
}

// ---------- Tracking ----------
function trackSat(sat) {
  if (!sat.pp) {
    // Turn on the whole constellation when tracking from search results so
    // the user sees context. If the user prefers not, they can uncheck after.
    if (!groupVisible.get(sat.group)) {
      const cb = document.querySelector(`#groups input[data-group="${sat.group}"]`);
      if (cb) cb.checked = true;
      setGroupVisible(sat.group, true);
    } else {
      addToScene(sat);
    }
  }
  releaseTracking();
  trackedSat = sat;

  trackedEntity = viewer.entities.add({
    name: sat.name,
    position: new Cesium.CallbackProperty(time => {
      const jsDate = Cesium.JulianDate.toDate(time);
      return propagate(sat, jsDate) || Cesium.Cartesian3.ZERO;
    }, false),
    point: {
      pixelSize: 8,
      color: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
    },
    label: {
      text: sat.name, font: "12px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(10, 0),
    },
  });
  drawOrbitPath(sat);
  drawFootprint(sat);
  drawGroundTrack(sat);
  showPasses(sat);

  document.getElementById("tracking-name").textContent = sat.name;
  document.getElementById("tracking-chip").style.display = "block";
}

function releaseTracking() {
  if (trackedEntity) viewer.entities.remove(trackedEntity);
  if (orbitPolyline) viewer.entities.remove(orbitPolyline);
  if (footprint)     viewer.entities.remove(footprint);
  if (groundTrack)   viewer.entities.remove(groundTrack);
  trackedEntity = null; orbitPolyline = null; footprint = null;
  groundTrack = null; trackedSat = null;
  hidePasses();
  viewer.trackedEntity = undefined;
  document.getElementById("tracking-chip").style.display = "none";
}

function drawOrbitPath(sat) {
  // satellite.js mean motion `no` is rad/min → period in minutes
  const periodMin = (2 * Math.PI) / sat.satrec.no;
  const samples = 90;
  const startMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
  const positions = [];
  for (let i = 0; i <= samples; i++) {
    const t = new Date(startMs + (periodMin * 60 * 1000) * (i / samples));
    const p = propagate(sat, t);
    if (p) positions.push(p);
  }
  orbitPolyline = viewer.entities.add({
    polyline: {
      positions, width: 1.5,
      material: Cesium.Color.fromBytes(...sat.color, 200),
      arcType: Cesium.ArcType.NONE,
    },
  });
}

// ---------- Visibility footprint ----------
// Locus of ground points where the satellite is currently above the horizon.
// For a satellite at altitude h, the central angle from sub-sat point is
// acos(R / (R + h)); the ground-distance radius of the circle is R * angle.
function subSatGeodetic(sat, jsDate) {
  const pv = satellite.propagate(sat.satrec, jsDate);
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(jsDate);
  return satellite.eciToGeodetic(pv.position, gmst);
}

// Minimum elevation angle above local horizon for "visible" — most ground
// observers can't see anything below ~10° due to atmosphere, terrain, and
// buildings. Set to 0 to get the geometric horizon circle.
const MIN_ELEVATION_DEG = 10;

function footprintRadiusMeters(sat, jsDate) {
  const geo = subSatGeodetic(sat, jsDate);
  if (!geo) return 1;
  const Re = 6378137; // WGS84 equatorial radius, meters
  const r  = Re + geo.height * 1000;
  if (r <= Re) return 1;
  // Spherical triangle: observer at P on surface, satellite at S' above
  // sub-sat point. With elevation angle e at P, the nadir angle alpha at the
  // satellite satisfies sin(alpha) = (R/(R+h)) * cos(e), and the central
  // angle gamma at Earth's center is 90 - e - alpha (radians).
  const e = Cesium.Math.toRadians(MIN_ELEVATION_DEG);
  const sinAlpha = (Re / r) * Math.cos(e);
  if (sinAlpha >= 1) return 1; // satellite below horizon everywhere
  const alpha = Math.asin(sinAlpha);
  const gamma = Math.PI / 2 - e - alpha;
  return Re * gamma;
}

function drawFootprint(sat) {
  footprint = viewer.entities.add({
    position: new Cesium.CallbackProperty(time => {
      const geo = subSatGeodetic(sat, Cesium.JulianDate.toDate(time));
      if (!geo) return Cesium.Cartesian3.ZERO;
      return Cesium.Cartesian3.fromRadians(geo.longitude, geo.latitude, 0);
    }, false),
    ellipse: {
      semiMajorAxis: new Cesium.CallbackProperty(
        time => footprintRadiusMeters(sat, Cesium.JulianDate.toDate(time)), false),
      semiMinorAxis: new Cesium.CallbackProperty(
        time => footprintRadiusMeters(sat, Cesium.JulianDate.toDate(time)), false),
      material: Cesium.Color.fromBytes(sat.color[0], sat.color[1], sat.color[2], 60),
      outline: true,
      outlineColor: Cesium.Color.fromBytes(sat.color[0], sat.color[1], sat.color[2], 220),
      height: 0,
      granularity: Cesium.Math.toRadians(2),
    },
  });
}

// ---------- Ground track ----------
// Sub-satellite point trace over ±half-period centered on current clock.
// clampToGround handles antimeridian wrap automatically.
function drawGroundTrack(sat) {
  const periodMin = (2 * Math.PI) / sat.satrec.no;
  const halfMs = (periodMin / 2) * 60 * 1000;
  const samples = 240;
  const center = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
  const positions = [];
  for (let i = 0; i <= samples; i++) {
    const t = new Date(center - halfMs + (2 * halfMs) * (i / samples));
    const geo = subSatGeodetic(sat, t);
    if (geo) positions.push(
      Cesium.Cartesian3.fromRadians(geo.longitude, geo.latitude, 0));
  }
  groundTrack = viewer.entities.add({
    polyline: {
      positions, width: 2,
      material: Cesium.Color.LIME.withAlpha(0.9),
      clampToGround: true,
    },
  });
}

// ---------- COS pass predictions ----------
// Scan forward stepSec seconds at a time, detect periods where elevation at
// COS observer is ≥ MIN_ELEVATION_DEG. Record AOS, LOS, peak elevation, and
// rough start/end compass direction. Returns up to maxPasses upcoming.
// Earth's umbra is approximately cylindrical for satellites near Earth.
// Satellite is lit if it's on the sun-facing hemisphere OR if it's on the
// far side but outside Earth's shadow cylinder. (All vectors in km.)
function satIsSunlit(satPosKm, sunPosKm) {
  const sx = satPosKm.x, sy = satPosKm.y, sz = satPosKm.z;
  const ux = sunPosKm.x, uy = sunPosKm.y, uz = sunPosKm.z;
  const sunMag = Math.hypot(ux, uy, uz);
  const nx = ux / sunMag, ny = uy / sunMag, nz = uz / sunMag;
  const parallel = sx * nx + sy * ny + sz * nz;
  if (parallel >= 0) return true; // sun-facing side
  // perpendicular distance from sun-Earth line
  const px = sx - parallel * nx;
  const py = sy - parallel * ny;
  const pz = sz - parallel * nz;
  return Math.hypot(px, py, pz) > 6378.137;
}

function predictPasses(sat, fromDate, hours = 48, maxPasses = 6) {
  const stepSec = 30;
  const minEl = Cesium.Math.toRadians(MIN_ELEVATION_DEG);
  const civilDark = Cesium.Math.toRadians(-6); // sun ≤ -6° at observer
  const passes = [];
  let inPass = false;
  let aos = null, aosAz = 0, peakEl = 0, peakTime = null, visible = false;
  for (let s = 0; s < hours * 3600; s += stepSec) {
    const t = new Date(fromDate.getTime() + s * 1000);
    const pv = satellite.propagate(sat.satrec, t);
    if (!pv || !pv.position) continue;
    const gmst = satellite.gstime(t);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(COS_OBSERVER, ecf);
    if (look.elevation >= minEl) {
      // Naked-eye check: observer in twilight/dark AND satellite still in sunlight
      const sunPos = sunECEFkm(t);
      const sunEl  = satellite.ecfToLookAngles(COS_OBSERVER, sunPos).elevation;
      const sunlit = satIsSunlit({ x: ecf.x, y: ecf.y, z: ecf.z }, sunPos);
      const isVisible = (sunEl <= civilDark) && sunlit;
      if (!inPass) {
        inPass = true;
        aos = t; aosAz = look.azimuth;
        peakEl = look.elevation; peakTime = t;
        visible = isVisible;
      } else {
        if (look.elevation > peakEl) { peakEl = look.elevation; peakTime = t; }
        if (isVisible) visible = true;
      }
    } else if (inPass) {
      passes.push({ aos, los: t, aosAz, losAz: look.azimuth, peakEl, peakTime, visible });
      inPass = false; visible = false;
      if (passes.length >= maxPasses) break;
    }
  }
  return passes;
}

function compass(azRad) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                "S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((azRad * 180 / Math.PI) % 360) / 22.5) % 16];
}

function fmtLocal(d) {
  return d.toLocaleString("en-US", {
    timeZone: "America/Denver", weekday: "short",
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function showPasses(sat) {
  const panel = document.getElementById("passes");
  panel.style.display = "block";
  panel.innerHTML = `<h2>Passes from Colorado Springs</h2>
    <div class="hint">Computing…</div>`;
  // run on next tick so UI updates first
  setTimeout(() => {
    const passes = predictPasses(sat, new Date());
    if (passes.length === 0) {
      panel.innerHTML = `<h2>Passes from Colorado Springs</h2>
        <div class="hint">No passes ≥ ${MIN_ELEVATION_DEG}° in next 48h.</div>`;
      return;
    }
    const rows = passes.map(p => {
      const peakDeg = (p.peakEl * 180 / Math.PI).toFixed(0);
      const dur = fmtDuration(p.los - p.aos);
      const tag = p.visible ? `<span class="pass-visible" title="Naked-eye visible: sat sunlit, observer in twilight or darker">⭐</span>` : "";
      return `<div class="pass${p.visible ? " visible" : ""}">
        <div class="pass-time">${tag}${fmtLocal(p.aos)} → ${fmtLocal(p.los).split(" ").pop()}</div>
        <div class="pass-meta">peak ${peakDeg}° · ${dur} · ${compass(p.aosAz)}→${compass(p.losAz)}</div>
      </div>`;
    }).join("");
    panel.innerHTML = `<h2>Passes from Colorado Springs</h2>
      <div class="hint">Next 48h, ≥${MIN_ELEVATION_DEG}° elevation</div>${rows}`;
  }, 0);
}

function hidePasses() {
  const panel = document.getElementById("passes");
  if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
}

// ---------- Click-to-track ----------
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction(event => {
  const picked = viewer.scene.pick(event.position);
  if (picked && picked.primitive instanceof Cesium.PointPrimitive) {
    for (const sat of VISIBLE) {
      if (sat.pp === picked.primitive) { trackSat(sat); return; }
    }
  } else if (!picked) {
    releaseTracking();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

document.addEventListener("keydown", e => {
  if (e.key === "Escape") releaseTracking();
});
document.getElementById("cloud-toggle").addEventListener("change", e => {
  setCloudCoverVisible(e.target.checked);
});
document.getElementById("twilight-toggle").addEventListener("change", e => {
  setTwilightVisible(e.target.checked);
});
document.getElementById("tracking-release").addEventListener("click", releaseTracking);
document.getElementById("tracking-lock").addEventListener("click", () => {
  if (trackedEntity) {
    if (viewer.trackedEntity === trackedEntity) viewer.trackedEntity = undefined;
    else viewer.trackedEntity = trackedEntity;
  }
});

// ---------- Boot ----------
(async function init() {
  const status = document.getElementById("status");
  status.textContent = "Loading TLE catalog…";
  try {
    ALL_SATS = await loadTLEs();
  } catch (e) {
    status.textContent = "Failed to load TLE: " + e.message;
    return;
  }
  buildGroupsUI();
  setupSearch();
  updateStatus();
})();
