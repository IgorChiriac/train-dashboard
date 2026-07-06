/* Live train radar — flightradar-style map of every train moving in Switzerland.
 *
 * Data sources:
 *  - Vehicle positions: geOps realtime API (wss://api.geops.io/tracker-ws) — the
 *    feed behind the official SBB/trafimage train map. Free key: developer.geops.io
 *  - Wagon formation: opentransportdata.swiss Formation Service v2 (optional key)
 *  - Basemap: OpenFreeMap vector tiles (no key)
 *
 * Rendering: trains are animated on a single 2D canvas overlay (one rAF loop,
 * pre-rendered sprites, viewport culling) instead of per-frame GeoJSON updates.
 */

"use strict";

/* ---------------------------------------------------------------- config */

const QS = new URLSearchParams(location.search);
const MOCK = QS.has("mock");
const DEBUG = QS.has("debug");

// Keys are never committed to the repo: ?key= / ?otdkey= are persisted to
// localStorage on first visit, after which plain trains.html works.
const GEOPS_KEY_CONST = ""; // optionally hardcode your own key here
const OTD_KEY_CONST = "";   // optionally hardcode your opentransportdata key here

if (QS.get("key")) localStorage.setItem("radar-geops-key", QS.get("key"));
if (QS.get("otdkey")) localStorage.setItem("radar-otd-key", QS.get("otdkey"));

const GEOPS_KEY = localStorage.getItem("radar-geops-key") || GEOPS_KEY_CONST;
const OTD_KEY = localStorage.getItem("radar-otd-key") || OTD_KEY_CONST;

// NB: the endpoint is /tracker-ws/v1/ (trailing slash, no extra path segment),
// matching geOps' own mobility-toolbox-js client.
const WS_URL = (key) => `wss://api.geops.io/tracker-ws/v1/?key=${encodeURIComponent(key)}`;
const FORMATION_API = "https://api.opentransportdata.swiss/formation/v2/formations_stop_based";

const STYLE_URLS = [
  "https://tiles.openfreemap.org/styles/dark",
  "https://tiles.openfreemap.org/styles/positron",
  "https://tiles.openfreemap.org/styles/liberty",
];
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0d1428" } }],
};

const START = { center: [8.54, 47.32], zoom: 10 }; // Zürichsee, matches the commute
const PING_MS = 10_000;
const STALE_MS = 60_000;
const BBOX_DEBOUNCE_MS = 250;
const HIT_RADIUS_PX = 24;

/* ------------------------------------------------------ geometry helpers */

const MERC_R = 6378137;
const MERC_MAX = Math.PI * MERC_R;

function mercToLngLat(x, y) {
  return [
    (x / MERC_MAX) * 180,
    (Math.atan(Math.exp((y / MERC_MAX) * Math.PI)) * 360) / Math.PI - 90,
  ];
}

function lngLatToMerc(lng, lat) {
  return [
    (lng / 180) * MERC_MAX,
    (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / Math.PI) * MERC_MAX,
  ];
}

function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

function pathLengthKm(lnglats) {
  let km = 0;
  for (let i = 1; i < lnglats.length; i++) km += haversineKm(lnglats[i - 1], lnglats[i]);
  return km;
}

// Convert an EPSG:3857 LineString once, and precompute cumulative segment
// lengths so fraction→point lookup is a binary search. Everything downstream
// of this function speaks lng/lat only.
function preprocessGeometry(coords3857) {
  const n = coords3857.length;
  const lnglat = new Array(n);
  const cum = new Float64Array(n);
  let total = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = coords3857[i];
    lnglat[i] = mercToLngLat(x, y);
    if (i > 0) total += Math.hypot(x - px, y - py);
    cum[i] = total;
    px = x;
    py = y;
  }
  return { lnglat, cum, total, merc: coords3857 };
}

// Point + heading at fraction f (0..1) along a preprocessed geometry.
// Heading is derived from the local segment direction (radians, 0 = north,
// clockwise) — the feed's rotation field is deliberately not trusted.
function pointAtFraction(geom, f) {
  const { lnglat, cum, total, merc } = geom;
  const n = lnglat.length;
  if (n === 0) return null;
  if (n === 1 || total === 0) return { lng: lnglat[0][0], lat: lnglat[0][1], heading: 0 };
  const target = Math.min(Math.max(f, 0), 1) * total;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (target - cum[i - 1]) / seg;
  const a = lnglat[i - 1];
  const b = lnglat[i];
  const dx = merc[i][0] - merc[i - 1][0];
  const dy = merc[i][1] - merc[i - 1][1];
  return {
    lng: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    heading: Math.atan2(dx, dy),
  };
}

/* ---------------------------------------------------------- vehicle store */

const vehicles = new Map(); // train_id → vehicle record

function normalizeColor(c, fallback) {
  if (typeof c !== "string" || !c.trim()) return fallback;
  c = c.trim();
  return c.startsWith("#") || c.startsWith("rgb") ? c : `#${c}`;
}

// The feed reports delays in milliseconds; values under 1000 are treated as
// a seconds-based variant so a schema drift degrades to "roughly right".
function normalizeDelayMin(delay) {
  if (typeof delay !== "number" || !isFinite(delay)) return null;
  const min = Math.abs(delay) >= 1000 ? delay / 60_000 : delay / 60;
  return Math.round(min);
}

function upsertTrajectory(feature) {
  try {
    const p = feature && feature.properties;
    const g = feature && feature.geometry;
    if (!p || !p.train_id || !g || !Array.isArray(g.coordinates)) return;
    const coords = g.type === "Point" ? [g.coordinates] : g.coordinates;
    if (!coords.length || !Array.isArray(coords[0])) return;

    const line = p.line || {};
    const intervals = Array.isArray(p.time_intervals) ? p.time_intervals : [];
    const rec = vehicles.get(p.train_id) || { id: p.train_id };
    rec.geom = preprocessGeometry(coords);
    rec.timeIntervals = intervals;
    rec.name = (line.name || p.name || "").trim();
    rec.color = normalizeColor(line.color, null);
    rec.textColor = normalizeColor(line.text_color, "#ffffff");
    rec.type = p.type || "rail";
    rec.tenant = p.tenant || "";
    rec.state = p.state || "";
    rec.trainNumber = p.train_number || null;
    rec.delayMin = normalizeDelayMin(p.delay);
    rec.lastSeen = Date.now();
    rec.screen = null;
    if (rec.state === "JOURNEY_CANCELLED") vehicles.delete(rec.id);
    else vehicles.set(rec.id, rec);
  } catch (err) {
    if (DEBUG) console.warn("bad trajectory", err, feature);
  }
}

function purgeStale(now) {
  for (const [id, v] of vehicles) {
    if (now - v.lastSeen > STALE_MS) {
      vehicles.delete(id);
      if (id === selectedId) deselect();
    }
  }
}

// Where is this vehicle right now? Interpolates time_intervals ([ts, fraction,
// rotation?] pairs) and clamps at both ends so trains hold position at stops.
function positionAt(v, now) {
  const ti = v.timeIntervals;
  if (!ti || !ti.length) return pointAtFraction(v.geom, 0);
  if (now <= ti[0][0]) return pointAtFraction(v.geom, ti[0][1]);
  const last = ti[ti.length - 1];
  if (now >= last[0]) return pointAtFraction(v.geom, last[1]);
  let lo = 0;
  let hi = ti.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ti[mid][0] <= now) lo = mid;
    else hi = mid;
  }
  const [t0, f0] = ti[lo];
  const [t1, f1] = ti[hi];
  const t = t1 > t0 ? (now - t0) / (t1 - t0) : 0;
  return pointAtFraction(v.geom, f0 + (f1 - f0) * t);
}

/* -------------------------------------------------------------- DOM refs */

const $ = (id) => document.getElementById(id);
const liveDot = $("liveDot");
const liveText = $("liveText");
const trainCount = $("trainCount");
const toastEl = $("toast");
const panel = $("panel");
const panelBody = $("panelBody");
const keySheet = $("keySheet");

function setLive(state, label) {
  liveDot.className = `live live--${state}`;
  liveText.textContent = label;
}

let toastTimer = null;
function toast(msg, ms = 6000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/* ------------------------------------------------------- websocket client */

let ws = null;
let wsState = "idle"; // idle | connecting | open | backoff | suspended | dead
let backoffMs = 1000;
let pingTimer = null;
let wsOpened = false;
let failedAttempts = 0; // consecutive connections that never (or barely) opened

function send(cmd) {
  if (MOCK) return mockSend(cmd);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd);
}

function connect() {
  if (MOCK || !GEOPS_KEY || wsState === "dead") return;
  wsState = "connecting";
  setLive("loading", "CONNECTING");
  wsOpened = false;
  const connectedAt = Date.now();
  try {
    ws = new WebSocket(WS_URL(GEOPS_KEY));
  } catch (err) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsState = "open";
    wsOpened = true;
    backoffMs = 1000;
    setLive("ok", "LIVE");
    send("BUFFER 100 100");
    // BBOX only scopes the stream — the channels must be subscribed explicitly
    // (GET replays current state, SUB streams updates), same as geOps' own
    // mobility-toolbox client does.
    send("GET trajectory");
    send("SUB trajectory");
    send("GET deleted_vehicles");
    send("SUB deleted_vehicles");
    sendBbox();
    if (selectedId) subscribeSelected(selectedId);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send("PING"), PING_MS);
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    route(msg);
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    if (wsState === "suspended" || MOCK) return;
    // A rejected key surfaces as connections that die before/right after the
    // upgrade. Three strikes while online → stop looping and ask for the key.
    const quick = !wsOpened || Date.now() - connectedAt < 2000;
    failedAttempts = quick ? failedAttempts + 1 : 0;
    if (failedAttempts >= 3 && navigator.onLine !== false) {
      wsState = "dead";
      setLive("error", "KEY?");
      openKeySheet("Could not connect — the geOps API key looks invalid or the service is unreachable. Free keys: ");
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    if (DEBUG) console.warn("ws error");
  };
}

function scheduleReconnect() {
  wsState = "backoff";
  setLive("error", "RETRYING");
  const wait = backoffMs + Math.random() * 500;
  backoffMs = Math.min(backoffMs * 2, 30_000);
  setTimeout(() => {
    if (wsState === "backoff") connect();
  }, wait);
}

function sendBbox() {
  if (!map) return;
  const b = map.getBounds();
  const [minX, minY] = lngLatToMerc(b.getWest(), b.getSouth());
  const [maxX, maxY] = lngLatToMerc(b.getEast(), b.getNorth());
  const zoom = Math.max(0, Math.floor(map.getZoom()));
  // The server rejects non-rail modes below zoom 9 anyway; ask explicitly,
  // mirroring mobility-toolbox's motsByZoom defaults.
  const mots = zoom < 9 ? "rail" : "tram,subway,rail,bus";
  send(
    `BBOX ${Math.floor(minX)} ${Math.floor(minY)} ${Math.ceil(maxX)} ${Math.ceil(maxY)} ${zoom} mots=${mots}`
  );
}

function route(msg) {
  if (!msg || typeof msg.source !== "string") return;
  const { source, content } = msg;
  // With BUFFER active most frames arrive as a buffer envelope wrapping a
  // list of ordinary messages (the last entry can be null).
  if (source === "buffer") {
    if (Array.isArray(content)) for (const inner of content) if (inner) route(inner);
    return;
  }
  if (source === "trajectory") {
    if (content) upsertTrajectory(content);
  } else if (source === "deleted_vehicles") {
    const ids = Array.isArray(content) ? content : [content];
    for (const d of ids) {
      const id = typeof d === "string" ? d : d && d.train_id;
      if (id) vehicles.delete(id);
      if (id === selectedId) deselect();
    }
  } else if (source.startsWith("full_trajectory_")) {
    if (source.slice("full_trajectory_".length) === selectedId && content) showRoute(content);
  } else if (source.startsWith("stopsequence_")) {
    if (source.slice("stopsequence_".length) === selectedId && content) {
      const seq = Array.isArray(content) ? content[0] : content;
      if (seq) renderPanel(seq);
    }
  } else if (DEBUG) {
    console.log("ws msg", source, content);
  }
}

/* ------------------------------------------------------------- map setup */

let map = null;
const canvas = $("radar");
const ctx = canvas.getContext("2d");
let dpr = window.devicePixelRatio || 1;

async function pickStyle() {
  if (MOCK) return FALLBACK_STYLE;
  for (const url of STYLE_URLS) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (res.ok) return await res.json();
    } catch {
      /* try next */
    }
  }
  toast("Basemap unavailable — trains are still live on a plain background.", 8000);
  return FALLBACK_STYLE;
}

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spriteCache.clear();
}

async function initMap() {
  const style = await pickStyle();
  map = new maplibregl.Map({
    container: "map",
    style,
    center: START.center,
    zoom: START.zoom,
    minZoom: 5,
    maxZoom: 17,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  setupGeolocation();
  map.on("error", (e) => {
    if (DEBUG) console.warn("map error", e && e.error);
  });

  let bboxTimer = null;
  const queueBbox = () => {
    clearTimeout(bboxTimer);
    bboxTimer = setTimeout(sendBbox, BBOX_DEBOUNCE_MS);
  };
  map.on("moveend", queueBbox);
  map.on("zoomend", queueBbox);
  map.on("click", onMapClick);

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  matchMedia(`(resolution: ${dpr}dppx)`).addEventListener?.("change", resizeCanvas);

  startLoop();
  if (MOCK) installMock();
  else connect();
}

// Locate the user, remember the choice, and open the radar centred on them at a
// ~1–2 km radius (zoom 14) so the first thing they see is the trains nearby.
// Uses MapLibre's GeolocateControl for the marker/accuracy circle/tracking, and
// auto-triggers it on load once the preference is set.
let geolocateCtl = null;
function setupGeolocation() {
  geolocateCtl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
    fitBoundsOptions: { maxZoom: 14 }, // a single fix zooms to ~1–2 km radius
  });
  map.addControl(geolocateCtl, "bottom-right");

  // Remember that the user shares location so we auto-locate on every visit.
  // On the first fix, force a fixed ~1–2 km view (zoom 14) rather than letting
  // the control fit the GPS accuracy circle — accuracy varies wildly (metres on
  // a phone, kilometres on desktop wifi) and we want a consistent radius.
  let didInitialLocate = false;
  geolocateCtl.on("geolocate", (e) => {
    localStorage.setItem("radar-geolocate", "on");
    if (!didInitialLocate && e && e.coords) {
      didInitialLocate = true;
      map.easeTo({ center: [e.coords.longitude, e.coords.latitude], zoom: 14, duration: 700 });
    }
  });
  geolocateCtl.on("error", (e) => {
    // Only stop auto-locating if the user actually denied permission (code 1);
    // transient failures (timeout/unavailable) shouldn't disable the feature.
    if (e && e.code === 1) localStorage.setItem("radar-geolocate", "off");
    if (DEBUG) console.warn("geolocate error", e && e.code, e && e.message);
  });

  // First visit (pref unset) prompts; afterwards it's silent until they opt out.
  map.on("load", () => {
    if (MOCK) return;
    if (localStorage.getItem("radar-geolocate") === "off") return;
    try {
      geolocateCtl.trigger();
    } catch (_) {
      /* control not ready — user can still tap the locate button */
    }
  });
}

/* ------------------------------------------------- sprites + render loop */

// zoom buckets: 0 = country overview dots, 1 = direction circles,
// 2 = line badges, 3 = badges + delay chip
function zoomBucket(z) {
  if (z < 8) return 0;
  if (z < 11) return 1;
  if (z < 13) return 2;
  return 3;
}

const CAT_LONG_DISTANCE = "#eb0000"; // SBB red
const CAT_REGIONAL = "#2d327d";      // S-Bahn blue
const CAT_OTHER = "#7c8db0";

function categoryColor(v) {
  if (/^(IC|IR|EC|EN|RJ|RJX|TGV|ICE|NJ|PE|GEX)\b/i.test(v.name)) return CAT_LONG_DISTANCE;
  if (/^S\d*/i.test(v.name)) return CAT_REGIONAL;
  return v.color || CAT_OTHER;
}

function lineColor(v) {
  return v.color || categoryColor(v);
}

const spriteCache = new Map(); // key → {canvas, w, h, ax, ay}
const SPRITE_CACHE_MAX = 400;

function getSprite(v, bucket) {
  const delayTxt = bucket === 3 && v.delayMin >= 1 ? `+${v.delayMin}′` : "";
  const key = `${bucket}|${v.name}|${lineColor(v)}|${v.textColor}|${delayTxt}`;
  let s = spriteCache.get(key);
  if (s) return s;
  s = bucket <= 1 ? makeCircleSprite(v, bucket) : makeBadgeSprite(v, bucket, delayTxt);
  if (spriteCache.size >= SPRITE_CACHE_MAX) {
    spriteCache.delete(spriteCache.keys().next().value);
  }
  spriteCache.set(key, s);
  return s;
}

function makeSpriteCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  return [c, g];
}

function makeCircleSprite(v, bucket) {
  const r = bucket === 0 ? 3 : 8;
  const pad = 3;
  const size = r * 2 + pad * 2;
  const [c, g] = makeSpriteCanvas(size, size);
  const cx = size / 2;
  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fillStyle = bucket === 0 ? categoryColor(v) : lineColor(v);
  g.fill();
  if (bucket === 1) {
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.stroke();
    // direction notch (points up; rotated at draw time)
    g.beginPath();
    g.moveTo(cx, cx - r - 2.5);
    g.lineTo(cx - 3.5, cx - r + 3);
    g.lineTo(cx + 3.5, cx - r + 3);
    g.closePath();
    g.fillStyle = "rgba(255,255,255,0.95)";
    g.fill();
  }
  return { canvas: c, w: size, h: size, ax: cx, ay: cx, rotates: bucket === 1 };
}

function makeBadgeSprite(v, bucket, delayTxt) {
  const fontPx = bucket === 3 ? 13 : 11;
  const hBadge = bucket === 3 ? 24 : 20;
  const font = `800 ${fontPx}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = font;
  const label = v.name || "•";
  const wText = meas.measureText(label).width;
  const wBadge = Math.max(hBadge, Math.ceil(wText) + 14);
  const chipFont = `700 10px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  meas.font = chipFont;
  const wChip = delayTxt ? Math.ceil(meas.measureText(delayTxt).width) + 10 : 0;
  const pad = 3;
  const w = wBadge + (wChip ? wChip + 4 : 0) + pad * 2;
  const h = hBadge + pad * 2;
  const [c, g] = makeSpriteCanvas(w, h);

  const x = pad;
  const y = pad;
  g.beginPath();
  g.roundRect(x, y, wBadge, hBadge, 6);
  g.fillStyle = lineColor(v);
  g.fill();
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.stroke();
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = v.textColor;
  g.fillText(label, x + wBadge / 2, y + hBadge / 2 + 0.5);

  if (wChip) {
    const cx = x + wBadge + 4;
    const hChip = 15;
    const cy = y + (hBadge - hChip) / 2;
    g.beginPath();
    g.roundRect(cx, cy, wChip, hChip, 7);
    g.fillStyle = "#3a1220";
    g.fill();
    g.strokeStyle = "#ff6b6b";
    g.stroke();
    g.font = chipFont;
    g.fillStyle = "#ff6b6b";
    g.fillText(delayTxt, cx + wChip / 2, cy + hChip / 2 + 0.5);
  }
  // anchor on the badge centre so the badge sits on the position
  return { canvas: c, w, h, ax: pad + wBadge / 2, ay: h / 2, rotates: false };
}

let rafId = null;
let frameNo = 0;
let lastPurge = 0;
let lastCount = 0;

function startLoop() {
  if (rafId == null) rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
}

function frame() {
  rafId = requestAnimationFrame(frame);
  frameNo++;
  // frame-halving valve for very busy views
  if (vehicles.size > 600 && frameNo % 2) return;

  const now = Date.now();
  if (now - lastPurge > 5000) {
    lastPurge = now;
    purgeStale(now);
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!map) return;

  const bucket = zoomBucket(map.getZoom());
  let selected = null;

  for (const v of vehicles.values()) {
    const pos = positionAt(v, now);
    if (!pos || Math.abs(pos.lat) > 72) {
      v.screen = null;
      continue;
    }
    const pt = map.project([pos.lng, pos.lat]);
    if (pt.x < -40 || pt.y < -40 || pt.x > w + 40 || pt.y > h + 40) {
      v.screen = null;
      continue;
    }
    v.screen = { x: pt.x, y: pt.y };
    if (v.id === selectedId) {
      selected = { v, pos, pt };
      continue; // drawn last, on top
    }
    drawVehicle(v, pos, pt, bucket);
  }

  if (selected) {
    ctx.beginPath();
    ctx.arc(selected.pt.x, selected.pt.y, bucket <= 1 ? 13 : 17, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffd23f";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    drawVehicle(selected.v, selected.pos, selected.pt, bucket);
  }

  if (frameNo % 60 === 0 && vehicles.size !== lastCount) {
    lastCount = vehicles.size;
    trainCount.hidden = lastCount === 0;
    trainCount.textContent = `${lastCount} trains`;
  }
}

function drawVehicle(v, pos, pt, bucket) {
  const s = getSprite(v, bucket);
  if (s.rotates) {
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(pos.heading);
    ctx.drawImage(s.canvas, -s.ax, -s.ay, s.w, s.h);
    ctx.restore();
  } else {
    ctx.drawImage(s.canvas, pt.x - s.ax, pt.y - s.ay, s.w, s.h);
    if (bucket >= 2) {
      // small heading tick above the badge so direction stays visible
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pos.heading);
      ctx.beginPath();
      ctx.moveTo(0, -16);
      ctx.lineTo(-3.5, -10);
      ctx.lineTo(3.5, -10);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      ctx.restore();
    }
  }
}

/* --------------------------------------------------- selection + details */

let selectedId = null;
let selectedSeq = null;
let panelTimer = null;

function onMapClick(e) {
  const { x, y } = e.point;
  let best = null;
  let bestD = HIT_RADIUS_PX;
  for (const v of vehicles.values()) {
    if (!v.screen) continue;
    if (Math.abs(v.screen.x - x) > HIT_RADIUS_PX || Math.abs(v.screen.y - y) > HIT_RADIUS_PX) continue;
    const d = Math.hypot(v.screen.x - x, v.screen.y - y);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  if (best) select(best.id);
  else deselect();
}

function subscribeSelected(id) {
  send(`GET full_trajectory_${id}`);
  send(`GET stopsequence_${id}`);
  send(`SUB stopsequence_${id}`);
}

function select(id) {
  if (selectedId === id) return;
  if (selectedId) unsubscribeSelected(selectedId);
  selectedId = id;
  selectedSeq = null;
  routeKm = null;
  const v = vehicles.get(id);
  renderPanelSkeleton(v);
  openPanel();
  subscribeSelected(id);
  clearInterval(panelTimer);
  panelTimer = setInterval(refreshPanelLive, 1000);
}

function unsubscribeSelected(id) {
  send(`DEL stopsequence_${id}`);
}

function deselect() {
  if (!selectedId) return;
  unsubscribeSelected(selectedId);
  selectedId = null;
  selectedSeq = null;
  routeKm = null;
  clearInterval(panelTimer);
  closePanel();
  removeRouteLayer();
}

/* route polyline for the selected train */

let routeKm = null;

function removeRouteLayer() {
  if (!map) return;
  if (map.getLayer("selected-route")) map.removeLayer("selected-route");
  if (map.getSource("selected-route")) map.removeSource("selected-route");
}

function showRoute(content) {
  try {
    const features = content.type === "FeatureCollection" ? content.features : [content];
    const lines = [];
    for (const f of features) {
      const g = f && f.geometry;
      if (!g) continue;
      if (g.type === "LineString") lines.push(g.coordinates.map(([x, y]) => mercToLngLat(x, y)));
      else if (g.type === "MultiLineString")
        for (const part of g.coordinates) lines.push(part.map(([x, y]) => mercToLngLat(x, y)));
    }
    if (!lines.length) return;
    routeKm = lines.reduce((km, l) => km + pathLengthKm(l), 0);
    const data = {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: lines },
      properties: {},
    };
    const v = vehicles.get(selectedId);
    const color = v ? lineColor(v) : "#ffd23f";
    const src = map.getSource("selected-route");
    if (src) {
      src.setData(data);
      map.setPaintProperty("selected-route", "line-color", color);
    } else {
      map.addSource("selected-route", { type: "geojson", data });
      const firstSymbol = (map.getStyle().layers || []).find((l) => l.type === "symbol");
      map.addLayer(
        {
          id: "selected-route",
          type: "line",
          source: "selected-route",
          paint: { "line-color": color, "line-width": 4, "line-opacity": 0.7 },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        firstSymbol && firstSymbol.id
      );
    }
    refreshPanelLive();
  } catch (err) {
    if (DEBUG) console.warn("bad full trajectory", err, content);
  }
}

/* ----------------------------------------------------------- info panel */

function openPanel() {
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("sheet--open"));
}

function closePanel() {
  panel.classList.remove("sheet--open");
  setTimeout(() => {
    if (!panel.classList.contains("sheet--open")) panel.hidden = true;
  }, 260);
}

$("panelClose").addEventListener("click", deselect);

function formatClock(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function badgeFor(v) {
  const badge = el("span", "sheet__badge", (v && v.name) || "🚆");
  badge.style.background = v ? lineColor(v) : "#2a3350";
  badge.style.color = (v && v.textColor) || "#fff";
  return badge;
}

function renderPanelSkeleton(v) {
  panelBody.replaceChildren();
  const head = el("div", "sheet__head");
  head.append(badgeFor(v));
  head.append(el("div", "sheet__route", "Loading train details…"));
  panelBody.append(head);
  panelBody.append(el("p", "sheet__sub", v && v.delayMin >= 1 ? `Delay +${v.delayMin} min` : ""));
}

function speedKmh(v) {
  const now = Date.now();
  const a = positionAt(v, now - 5000);
  const b = positionAt(v, now);
  if (!a || !b) return null;
  const kmh = haversineKm([a.lng, a.lat], [b.lng, b.lat]) / (5 / 3600);
  return isFinite(kmh) && kmh >= 1 && kmh < 350 ? Math.round(kmh) : null;
}

// live bits of the panel (speed, distance) refresh once a second
function refreshPanelLive() {
  const sub = panelBody.querySelector(".sheet__sub");
  const v = selectedId && vehicles.get(selectedId);
  if (!sub || !v) return;
  const seq = selectedSeq || {};
  const bits = [];
  if (seq.category || v.type) bits.push(seq.category || v.type);
  const operator = seq.operator || seq.operatorName || v.tenant.toUpperCase();
  if (operator) bits.push(operator);
  if (routeKm) bits.push(`${Math.round(routeKm)} km route`);
  const kmh = speedKmh(v);
  if (kmh != null) bits.push(`${kmh} km/h`);
  sub.replaceChildren(document.createTextNode(bits.join(" · ")));
  const delay = normalizeDelayMin(seq.delay) ?? v.delayMin;
  if (delay != null) {
    sub.append(document.createTextNode(" · "));
    sub.append(
      delay >= 1
        ? el("span", "delay-late", `+${delay} min`)
        : el("span", "delay-ok", "on time")
    );
  }
}

function renderPanel(seq) {
  selectedSeq = seq;
  const v = vehicles.get(selectedId);
  const stations = Array.isArray(seq.stations) ? seq.stations : [];
  const firstStop = stations[0] || {};
  const lastStop = stations[stations.length - 1] || {};
  const origin = seq.origin || firstStop.stationName || firstStop.name || "?";
  const destination = seq.destination || lastStop.stationName || lastStop.name || "?";

  panelBody.replaceChildren();

  const head = el("div", "sheet__head");
  head.append(badgeFor(v));
  const routeEl = el("div", "sheet__route");
  routeEl.append(document.createTextNode(origin));
  routeEl.append(el("span", "arrow", "→"));
  routeEl.append(document.createTextNode(destination));
  head.append(routeEl);
  panelBody.append(head);
  panelBody.append(el("p", "sheet__sub", ""));

  if (stations.length) {
    panelBody.append(el("h3", "sheet__section", "Stops"));
    const list = el("ol", "stops");
    const now = Date.now();
    let nextMarked = false;
    for (const st of stations) {
      const arr = st.arrivalTime || st.aimedArrivalTime || null;
      const dep = st.departureTime || st.aimedDepartureTime || null;
      const ref = dep || arr;
      const li = el("li", "stop");
      const past = ref && ref < now;
      if (past) li.classList.add("stop--past");
      else if (!nextMarked) {
        li.classList.add("stop--next");
        nextMarked = true;
      }
      li.append(el("span", "stop__time", formatClock(arr || dep)));
      li.append(el("span", "stop__name", st.stationName || st.name || "?"));
      const delayMin = normalizeDelayMin(st.arrivalDelay ?? st.departureDelay);
      if (delayMin >= 1) li.append(el("span", "stop__delay", `+${delayMin}′`));
      if (st.cancelled) li.append(el("span", "stop__delay", "✕"));
      list.append(li);
    }
    panelBody.append(list);
  }

  panelBody.append(el("h3", "sheet__section", "Formation"));
  const wagonsHost = el("div");
  wagonsHost.id = "wagonsHost";
  wagonsHost.append(el("p", "wagons-note", OTD_KEY || MOCK ? "Loading formation…" : "Add an opentransportdata.swiss key (?otdkey=…) to see wagons."));
  panelBody.append(wagonsHost);

  const credit = el("p", "sheet__credit");
  credit.append(document.createTextNode("Positions: geOps / SBB realtime · Formation: opentransportdata.swiss"));
  panelBody.append(credit);

  refreshPanelLive();
  if (OTD_KEY || MOCK) loadFormation(seq, v);
}

/* --------------------------------------------------- wagons / formation */

// operator name → EVU code understood by the formation service
const EVU_MAP = [
  [/thurbo/i, "THURBO"],
  [/bls/i, "BLSP"],
  [/s(ü|u)dostbahn|^sob/i, "SOB"],
  [/zentralbahn|^zb/i, "ZB"],
  [/sbb|cff|ffs/i, "SBBP"],
];

function evuFor(seq, v) {
  const hay = `${seq.operator || seq.operatorName || ""} ${(v && v.tenant) || ""}`;
  for (const [re, code] of EVU_MAP) if (re.test(hay)) return code;
  return "SBBP";
}

function trainNumberFor(seq, v) {
  if (v && v.trainNumber) return String(v.trainNumber);
  for (const cand of [seq.train_number, seq.trainNumber]) {
    if (cand) return String(cand);
  }
  // routeIdentifier carries the operational number as its first digit run,
  // e.g. "2735.000001.001:2735"
  const rid = String(seq.routeIdentifier || seq.id || "");
  const m = rid.match(/\d{2,6}/);
  return m ? m[0] : null;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadFormation(seq, v) {
  const host = $("wagonsHost");
  if (!host) return;
  const fail = (msg) => host.replaceChildren(el("p", "wagons-note", msg));
  const trainNumber = trainNumberFor(seq, v);
  if (!trainNumber) return fail("Formation not available for this train.");
  try {
    let json;
    if (MOCK) {
      json = MOCK_FORMATION;
    } else {
      const url = `${FORMATION_API}?evu=${evuFor(seq, v)}&operationDate=${todayIso()}&trainNumber=${trainNumber}`;
      const res = await fetch(url, { headers: { Authorization: OTD_KEY } });
      if (!res.ok) return fail("Formation not available for this train.");
      json = await res.json();
    }
    if (selectedId !== (v && v.id)) return; // user moved on
    const cars = extractCars(json);
    if (!cars || !cars.length) return fail("Formation not available for this train.");
    const strip = el("div", "wagons");
    for (const car of cars) strip.append(renderWagon(car));
    host.replaceChildren(strip, el("p", "wagons-note", `${cars.length} vehicles`));
  } catch (err) {
    if (DEBUG) console.warn("formation fetch failed", err);
    fail("Formation not available for this train.");
  }
}

// The formation JSON is deep and versioned; hunt for the first array whose
// items look like rail vehicles rather than pinning the exact schema.
function extractCars(json) {
  const carish = (o) =>
    o &&
    typeof o === "object" &&
    ["vehicleType", "vehicleCategory", "typeOfVehicle", "carUicNumber", "classOfVehicle", "vehicleIdentifier"].some(
      (k) => k in o
    );
  const seen = new Set();
  const queue = [json];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node.every(carish)) return node.map(normalizeCar);
      queue.push(...node);
    } else {
      queue.push(...Object.values(node));
    }
  }
  return null;
}

function normalizeCar(raw) {
  const cat = String(raw.vehicleCategory || raw.vehicleType || raw.typeOfVehicle || "").toUpperCase();
  const cls = String(raw.classOfVehicle ?? raw.class ?? "");
  const attrs = []
    .concat(raw.attributes || raw.properties || [])
    .map((a) => String(a && (a.code || a.name || a)).toUpperCase());
  const has = (re) => attrs.some((a) => re.test(a)) || re.test(cat);
  return {
    loco: /LOCO|LOK|TRIEBKOPF/.test(cat),
    cls: /1/.test(cls) ? "1" : /2/.test(cls) ? "2" : null,
    restaurant: has(/REST|WR|BISTRO/),
    family: has(/FAM|FA\b/),
    bike: has(/VELO|BIKE|BZ/),
    sleeper: has(/SLEEP|WL|COUCH/),
    lowFloor: has(/NF|LOW.?FLOOR|NIEDERFLUR/),
    closed: /CLOSED|GESCHLOSSEN/.test(cat),
  };
}

function renderWagon(car) {
  const box = el("div", "wagon");
  let icon = "🚃";
  let label = car.cls ? `${car.cls}. cl` : "car";
  if (car.loco) {
    box.classList.add("wagon--loco");
    icon = "🚈";
    label = "loco";
  } else if (car.restaurant) {
    icon = "🍽️";
    label = "resto";
  } else if (car.sleeper) {
    icon = "🛏️";
    label = "sleeper";
  } else if (car.cls === "1") {
    box.classList.add("wagon--first");
  }
  if (car.closed) label = "closed";
  box.append(el("span", "wagon__icon", icon));
  box.append(document.createTextNode(label));
  const tags = [];
  if (car.bike) tags.push("🚲");
  if (car.family) tags.push("👶");
  if (car.lowFloor) tags.push("♿");
  if (tags.length) box.append(el("span", "wagon__tags", tags.join(" ")));
  return box;
}

/* -------------------------------------------------------- key setup UI */

function openKeySheet(message) {
  const intro = $("keyIntro");
  if (message) {
    intro.textContent = message + " ";
    const link = el("a", null, "developer.geops.io");
    link.href = "https://developer.geops.io";
    link.target = "_blank";
    link.rel = "noopener";
    intro.append(link);
  }
  $("geopsKeyInput").value = GEOPS_KEY || "";
  $("otdKeyInput").value = OTD_KEY || "";
  keySheet.hidden = false;
  requestAnimationFrame(() => keySheet.classList.add("sheet--open"));
}

$("keySave").addEventListener("click", () => {
  const gk = $("geopsKeyInput").value.trim();
  const ok = $("otdKeyInput").value.trim();
  if (!gk) {
    $("geopsKeyInput").focus();
    return;
  }
  localStorage.setItem("radar-geops-key", gk);
  if (ok) localStorage.setItem("radar-otd-key", ok);
  else localStorage.removeItem("radar-otd-key");
  // reload without query params so the fresh keys are picked up cleanly
  location.href = location.pathname;
});

/* ---------------------------------------------------- lifecycle handling */

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (wsState === "open" || wsState === "connecting" || wsState === "backoff") {
      wsState = "suspended";
      clearInterval(pingTimer);
      if (ws) ws.close();
    }
    stopLoop();
  } else {
    startLoop();
    if (wsState === "suspended") connect();
  }
});

window.addEventListener("offline", () => setLive("error", "OFFLINE"));
window.addEventListener("online", () => {
  if (wsState === "backoff" || wsState === "suspended") connect();
});

/* -------------------------------------------------------------- mock mode
 * ?mock=1 feeds canned trajectories through the real pipeline (no network),
 * used for headless verification. Fixtures are built in EPSG:3857 so the
 * mercator→lng/lat conversion path is exercised too. */

let MOCK_FORMATION = null;

function mockSend(cmd) {
  if (cmd.startsWith("GET stopsequence_") || cmd.startsWith("SUB stopsequence_")) {
    const id = cmd.replace(/^(GET|SUB) stopsequence_/, "");
    const fix = MOCK_DETAILS[id];
    if (fix) route({ source: `stopsequence_${id}`, content: [fix.seq] });
  } else if (cmd.startsWith("GET full_trajectory_")) {
    const id = cmd.slice("GET full_trajectory_".length);
    const fix = MOCK_DETAILS[id];
    if (fix) route({ source: `full_trajectory_${id}`, content: fix.full });
  }
}

const MOCK_DETAILS = {};

function installMock() {
  setLive("ok", "MOCK");
  const merc = (lng, lat) => lngLatToMerc(lng, lat);
  const now = () => Date.now();

  // S2 Horgen → Zürich Enge (along the left lake shore)
  const s2Path = [
    merc(8.5989, 47.2599), // Horgen
    merc(8.5646, 47.2919), // Thalwil
    merc(8.5525, 47.32),   // Rüschlikon
    merc(8.5417, 47.3446), // Wollishofen
    merc(8.5316, 47.3641), // Zürich Enge
  ];
  // IC Zürich HB → Thalwil (heading south)
  const icPath = [
    merc(8.5402, 47.3782), // Zürich HB
    merc(8.5316, 47.3641), // Enge
    merc(8.5646, 47.2919), // Thalwil
  ];
  // Tram loop near the center
  const tramPath = [merc(8.53, 47.372), merc(8.545, 47.3755), merc(8.555, 47.366)];

  const mkTraj = (id, name, color, textColor, type, path, durMs, delaySec) => ({
    source: "trajectory",
    content: {
      type: "Feature",
      geometry: { type: "LineString", coordinates: path },
      properties: {
        train_id: id,
        type,
        tenant: "sbb",
        state: "DRIVING",
        delay: delaySec,
        line: { name, color, text_color: textColor },
        time_intervals: [
          [now() - 30_000, 0, 0],
          [now() + durMs, 1, 0],
        ],
      },
    },
  });

  // Delivered inside a buffer envelope, exactly like the live feed with
  // BUFFER active, so the unwrap path is exercised by the headless tests.
  const feed = () => {
    route({
      source: "buffer",
      content: [
        mkTraj("mock-s2", "S2", "#2d327d", "#ffffff", "rail", s2Path, 240_000, 120),
        mkTraj("mock-ic", "IC 3", "#eb0000", "#ffffff", "rail", icPath, 300_000, 0),
        mkTraj("mock-tram", "11", "#7c8db0", "#0b1020", "tram", tramPath, 180_000, 0),
        null,
      ],
    });
  };
  feed();
  setInterval(feed, 20_000);

  const mkStops = (names, coords) => {
    const t0 = now() - 5 * 60_000;
    return names.map((n, i) => ({
      stationName: n,
      coordinate: coords[i],
      arrivalTime: t0 + i * 6 * 60_000,
      departureTime: t0 + i * 6 * 60_000 + 60_000,
      arrivalDelay: i >= 2 ? 120_000 : 0,
    }));
  };

  MOCK_DETAILS["mock-s2"] = {
    seq: {
      origin: "Zürich HB",
      destination: "Ziegelbrücke",
      category: "S-Bahn",
      operator: "SBB",
      routeIdentifier: "18234.000001",
      stations: mkStops(
        ["Zürich HB", "Zürich Enge", "Thalwil", "Horgen", "Wädenswil"],
        [icPath[0], s2Path[4], s2Path[1], s2Path[0], s2Path[0]]
      ),
    },
    full: {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [icPath[0], ...s2Path.slice().reverse()] },
      properties: {},
    },
  };
  MOCK_DETAILS["mock-ic"] = {
    seq: {
      origin: "Zürich HB",
      destination: "Chur",
      category: "InterCity",
      operator: "SBB",
      routeIdentifier: "563.000001",
      stations: mkStops(["Zürich HB", "Thalwil", "Pfäffikon SZ"], icPath),
    },
    full: {
      type: "Feature",
      geometry: { type: "LineString", coordinates: icPath },
      properties: {},
    },
  };
  MOCK_DETAILS["mock-tram"] = {
    seq: {
      origin: "Rehalp",
      destination: "Auzelg",
      category: "Tram",
      operator: "VBZ",
      stations: mkStops(["Bellevue", "Central", "Milchbuck"], tramPath),
    },
    full: {
      type: "Feature",
      geometry: { type: "LineString", coordinates: tramPath },
      properties: {},
    },
  };

  MOCK_FORMATION = {
    formationsAtScheduledStops: [
      {
        formation: {
          vehicles: [
            { vehicleCategory: "LOCOMOTIVE", classOfVehicle: "" },
            { vehicleCategory: "COACH", classOfVehicle: "1", attributes: [{ code: "NF" }] },
            { vehicleCategory: "COACH", classOfVehicle: "2", attributes: [{ code: "VELO" }] },
            { vehicleCategory: "RESTAURANT_COACH", classOfVehicle: "2" },
            { vehicleCategory: "COACH", classOfVehicle: "2", attributes: [{ code: "FA" }] },
          ],
        },
      },
    ],
  };
}

/* ------------------------------------------------------------------ boot */

if (!MOCK && !GEOPS_KEY) {
  setLive("error", "NO KEY");
  openKeySheet();
}

initMap();

if (MOCK || DEBUG) {
  window.__radar = {
    vehicles,
    positionAt,
    select,
    deselect,
    getMap: () => map,
    wsState: () => wsState,
  };
}
