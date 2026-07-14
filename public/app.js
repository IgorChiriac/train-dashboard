/**
 * Door-to-door commute board: Home ⇄ Office via the S2.
 *
 * Each commute is a predefined PATH with three legs:
 *   walk → train (Horgen ⇄ Zürich Enge) → walk
 * The board shows the next 5 trains, highlights the quick S2, tells you when to
 * leave (accounting for the walk to the station) and when you'll arrive at the
 * final address (accounting for the walk from the station), surfaces live
 * delays, and shows a weather widget for both ends of your walk.
 *
 * Data: transport.opendata.ch (timetable) + open-meteo.com (weather). No keys.
 */

const API = "https://transport.opendata.ch/v1/connections";
// transport.opendata.ch drives the board, but its data model carries no
// cancellation flag at all (a Prognosis only has platform/arrival/departure/
// capacity) — so a cancelled train comes back looking perfectly normal and used
// to just count down and vanish as "gone". We overlay search.ch's timetable,
// which *does* report cancellations, purely to flag those trains. The overlay is
// best-effort and fail-safe: any error (network, CORS, schema drift, no match)
// simply leaves every train un-flagged, so the board never regresses and never
// invents a cancellation that isn't there.
const CANCEL_API = "https://timetable.search.ch/api/route.json";
const GEO_API = "https://geocoding-api.open-meteo.com/v1/search";
const WX_API = "https://api.open-meteo.com/v1/forecast";
const QUICK_LINE = "S2";
const LIMIT = 5;
// How long a train lingers on the board after it has (really) left — handy when
// the one you wanted was late and you almost made it. We also start the
// timetable query this far in the past so late/just-departed trains are still
// returned by the API (it otherwise drops trains by their *scheduled* time).
const PAST_GRACE_MS = 5 * 60_000;
const MAX_PAST = 3; // cap how many already-departed trains we show at once
const REFRESH_MS = 60_000;
const TICK_MS = 1_000;
const WX_MS = 10 * 60_000;
const STORE_KEY = "commute-prefs-v3";

// --- Predefined commute paths -------------------------------------------------
// Each leg endpoint: { name, place, station, walk } where `walk` is the default
// minutes between the address and that path's *boarding/alighting* station.
const PRESETS = {
  toWork: {
    label: "To work", pill: "🏢 To work",
    origin: { name: "Home", place: "Brunnenwiesliweg 8, Horgen", station: "Horgen", walk: 5 },
    dest: { name: "Office", place: "Bleicherweg 21, 8002 Zürich", station: "Zürich Enge", walk: 8 },
  },
  toHome: {
    label: "To home", pill: "🏠 To home",
    origin: { name: "Office", place: "Bleicherweg 21, 8002 Zürich", station: "Zürich Enge", walk: 8 },
    dest: { name: "Home", place: "Brunnenwiesliweg 8, Horgen", station: "Horgen", walk: 5 },
  },
  fromEnge: {
    label: "Enge → home", pill: "🚉 Enge → home",
    origin: { name: "Zürich Enge", place: "Zürich Enge station", station: "Zürich Enge", walk: 2 },
    dest: { name: "Home", place: "Brunnenwiesliweg 8, Horgen", station: "Horgen", walk: 5 },
  },
  fromHB: {
    label: "HB → home", pill: "🚉 HB → home",
    origin: { name: "Zürich HB", place: "Zürich HB station", station: "Zürich HB", walk: 3 },
    dest: { name: "Home", place: "Brunnenwiesliweg 8, Horgen", station: "Horgen", walk: 5 },
  },
};

// Built-in coordinates so the weather works out of the box.
const KNOWN_COORDS = {
  "Horgen": { lat: 47.2597, lon: 8.5958, label: "Horgen" },
  "Zürich Enge": { lat: 47.3642, lon: 8.5315, label: "Zürich Enge" },
  "Zürich HB": { lat: 47.3779, lon: 8.5403, label: "Zürich HB" },
};

const els = {
  board: document.getElementById("board"),
  status: document.getElementById("status"),
  updated: document.getElementById("updated"),
  fromLabel: document.getElementById("fromLabel"),
  toLabel: document.getElementById("toLabel"),
  journeyLine: document.getElementById("journeyLine"),
  presets: document.getElementById("presets"),
  walkOriginInput: document.getElementById("walkOriginInput"),
  walkDestInput: document.getElementById("walkDestInput"),
  walkOriginLabel: document.getElementById("walkOriginLabel"),
  walkDestLabel: document.getElementById("walkDestLabel"),
  refreshBtn: document.getElementById("refreshBtn"),
  refreshBar: document.getElementById("refreshBar"),
  liveDot: document.getElementById("liveDot"),
  liveText: document.getElementById("liveText"),
  weather: document.getElementById("weather"),
  // focus (live-view) screen
  focus: document.getElementById("focus"),
  focusLine: document.getElementById("focusLine"),
  focusFrom: document.getElementById("focusFrom"),
  focusTo: document.getElementById("focusTo"),
  focusClose: document.getElementById("focusClose"),
  focusTimer: document.getElementById("focusTimer"),
  focusTimerLabel: document.getElementById("focusTimerLabel"),
  focusStatus: document.getElementById("focusStatus"),
  focusWalk: document.getElementById("focusWalk"),
  focusMeta: document.getElementById("focusMeta"),
  focusMap: document.getElementById("focusMap"),
  focusMapLink: document.getElementById("focusMapLink"),
  focusMapHint: document.getElementById("focusMapHint"),
};

let connections = [];
let refreshTimer = null;
let tickTimer = null;
let lastFetchOk = false;
let lastWeatherAt = 0;
let activeId = "toWork";
let prefs = { walks: {}, coords: {} };
// The train you've "decided on": a stable key (planned departure + line) so the
// selection survives refreshes and live re-renders. null = nothing picked.
let selectedKey = null;
// The full-screen "Live view" for the picked train is open. It always mirrors
// the currently selected train; closing it doesn't clear the selection.
let focusOpen = false;
// "I'm walking": you've left the door, so stop the dramatic leave-by countdown
// and calmly count down to the train leaving instead. Only meaningful for the
// selected train; reset whenever the selection changes.
let walking = false;

/* ---------- preferences ---------- */

function loadPrefs() {
  try {
    prefs = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
  } catch (_) {
    prefs = {};
  }
  prefs.walks = prefs.walks || {};
  prefs.coords = prefs.coords || {};
}

function persist() {
  prefs.walks[activeId] = { origin: walkOrigin(), dest: walkDest() };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch (_) { /* ignore */ }
}

/** The active path, with any saved walk overrides applied. */
function path() {
  const p = PRESETS[activeId];
  const saved = prefs.walks[activeId] || {};
  return {
    label: p.label,
    origin: { ...p.origin, walk: saved.origin != null ? saved.origin : p.origin.walk },
    dest: { ...p.dest, walk: saved.dest != null ? saved.dest : p.dest.walk },
  };
}

function intInput(el) {
  const n = parseInt(el.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function walkOrigin() { return intInput(els.walkOriginInput); }
function walkDest() { return intInput(els.walkDestInput); }

function defaultPresetId() {
  const h = new Date().getHours();
  return h >= 3 && h < 12 ? "toWork" : "toHome"; // before noon → work, noon onward → home
}

/* ---------- apply a preset to the UI ---------- */

function applyPreset(id) {
  activeId = id;
  selectedKey = null; // a picked train belongs to one direction
  walking = false;
  const p = path();

  // walk inputs + labels
  els.walkOriginInput.value = p.origin.walk;
  els.walkDestInput.value = p.dest.walk;
  els.walkOriginLabel.textContent = p.origin.name === p.origin.station
    ? `🚶 to ${p.origin.station} platform`
    : `🚶 ${p.origin.name} → ${p.origin.station}`;
  els.walkDestLabel.textContent = p.dest.name === p.dest.station
    ? `🚶 from ${p.dest.station} platform`
    : `🚶 ${p.dest.station} → ${p.dest.name}`;

  // header
  els.fromLabel.textContent = p.origin.name;
  els.toLabel.textContent = p.dest.name;
  els.journeyLine.textContent = `${p.origin.place}  →  ${p.dest.place}`;

  // toggle active button
  els.presets.querySelectorAll(".preset").forEach((b) =>
    b.classList.toggle("preset--active", b.dataset.preset === id)
  );

  loadDepartures();
  loadWeather(true);
}

/* ---------- API helpers ---------- */

function buildUrl(from, to) {
  // direct=1 → only connections without a transfer. Start the search a few
  // minutes in the past so a late or just-departed train (which the API would
  // otherwise drop by its scheduled time) is still returned; ask for extra so
  // the client-side window still leaves enough upcoming ones to show.
  const start = new Date(Date.now() - PAST_GRACE_MS);
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const time = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const params = new URLSearchParams({
    from, to, direct: "1", date, time, limit: String(LIMIT + MAX_PAST + 2),
  });
  return `${API}?${params.toString()}`;
}

function lineOf(conn) {
  const p = conn.products && conn.products[0];
  return (p || "?").trim();
}
function isQuick(conn) {
  return lineOf(conn).toUpperCase() === QUICK_LINE;
}

// True once the search.ch overlay has flagged this train as cancelled.
function isCancelled(conn) {
  return !!(conn && conn._cancelled);
}

/* ---------- cancellation overlay (search.ch) ---------- */

// Normalise a line label for matching across the two providers ("S 2" → "S2").
function normLine(line) {
  return String(line || "").replace(/\s+/g, "").toUpperCase();
}

// Match key shared by both feeds: local departure HH:MM + line. The planned
// departure minute is stable and unique enough per route to line the two up.
// (Assumes the board runs in Switzerland's timezone — opendata departures carry
// an offset we render as local wall-clock, search.ch reports local HH:MM — which
// holds for this personal CH commute board.)
function cancelKeyForConn(conn) {
  const planned = conn.from && conn.from.departure;
  if (!planned) return null;
  return `${formatClock(new Date(planned))}|${normLine(lineOf(conn))}`;
}

function buildCancelUrl(from, to) {
  // No date/time → search.ch returns connections from "now", which is exactly
  // the window the board shows. Fewer params means fewer ways to be wrong.
  const params = new URLSearchParams({
    from, to, num: String(LIMIT + MAX_PAST + 2),
  });
  return `${CANCEL_API}?${params.toString()}`;
}

// search.ch encodes a cancelled departure/arrival as the delay string "X"
// (and may also expose a boolean `cancelled`). We only ever treat an
// unambiguous positive signal as a cancellation — anything else is "running".
function legCancelled(leg) {
  if (!leg) return false;
  if (leg.cancelled === true) return true;
  const dep = String(leg.dep_delay == null ? "" : leg.dep_delay).toUpperCase();
  const arr = String(leg.arr_delay == null ? "" : leg.arr_delay).toUpperCase();
  return dep === "X" || arr === "X";
}

// Build the set of cancel-keys that search.ch reports as cancelled.
function parseCancellations(data) {
  const set = new Set();
  const conns = (data && data.connections) || [];
  for (const c of conns) {
    const legs = c.legs || [];
    const cancelled = c.cancelled === true || legs.some(legCancelled);
    if (!cancelled) continue;
    // The first leg with a line is the boarding train; key off it.
    const leg = legs.find((l) => l && l.line) || legs[0] || {};
    const dep = c.departure || leg.departure; // "YYYY-MM-DD HH:MM:SS" (local)
    const m = dep && String(dep).match(/(\d{2}):(\d{2})/);
    if (!m) continue;
    set.add(`${m[1]}:${m[2]}|${normLine(leg.line)}`);
  }
  return set;
}

// Fetch + flag. Never throws: on any failure it returns an empty set so the
// board simply shows no cancellations rather than breaking or guessing.
async function fetchCancellations(from, to) {
  try {
    const res = await fetch(buildCancelUrl(from, to));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCancellations(await res.json());
  } catch (err) {
    console.warn("Cancellation overlay unavailable:", err.message);
    return new Set();
  }
}

function departureDate(conn) {
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  return new Date(prog || planned);
}

// Stable identity for a connection: the *planned* departure + line. Survives
// refreshes (planned time doesn't drift) so a selected train stays selected.
function connKey(conn) {
  return `${conn.from && conn.from.departure}|${lineOf(conn)}`;
}

// The train's journey object (opendata puts the run on the first section that
// actually has a journey — a direct S2 has exactly one).
function journeyOf(conn) {
  const sec = (conn.sections || []).find((s) => s && s.journey);
  return (sec && sec.journey) || {};
}

// The operational train/run number (e.g. 18265), used to line this connection
// up with the same vehicle on the geOps radar. Best-effort: opendata exposes it
// as journey.number, else we scrape a run number out of the journey name.
function trainNumberOf(conn) {
  const j = journeyOf(conn);
  const num = j.number != null ? String(j.number).replace(/\D/g, "") : "";
  if (num) return num;
  const m = String(j.name || "").match(/\d{3,}/);
  return m ? m[0] : null;
}

// Where the train is ultimately heading (its final destination), for the map
// context line — not the same as *your* alighting stop.
function directionOf(conn) {
  const j = journeyOf(conn);
  return j.to || (conn.to && conn.to.station && conn.to.station.name) || "";
}

function delayMinutes(conn) {
  if (conn.from && typeof conn.from.delay === "number") return conn.from.delay;
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  if (!prog || !planned) return 0;
  return Math.max(0, Math.round((new Date(prog) - new Date(planned)) / 60000));
}

function hasPrognosis(conn) {
  return !!(conn.from && conn.from.prognosis && conn.from.prognosis.departure)
    || (conn.from && typeof conn.from.delay === "number");
}

function formatDuration(iso) {
  if (!iso) return "";
  const m = iso.match(/(\d+)d(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return "";
  const [, d, hh, mm] = m;
  const total = Number(d) * 1440 + Number(hh) * 60 + Number(mm);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${total % 60}min`;
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatClock(date) {
  return date.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}
function formatClockSec(date) {
  return date.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ---------- live indicator ---------- */

function setLive(state) {
  els.liveDot.classList.remove("live--ok", "live--loading", "live--error");
  els.liveDot.classList.add(`live--${state}`);
  els.liveText.textContent =
    state === "loading" ? "SYNCING" : state === "error" ? "OFFLINE" : "LIVE";
  els.refreshBtn.classList.toggle("btn--loading", state === "loading");
}

function restartRefreshBar() {
  const bar = els.refreshBar;
  bar.style.animation = "none";
  void bar.offsetWidth;
  bar.style.animation = `deplete ${REFRESH_MS}ms linear forwards`;
}

/* ---------- weather widget ---------- */

function weatherInfo(code) {
  if (code === 0) return { emoji: "☀️", text: "clear" };
  if ([1, 2].includes(code)) return { emoji: "🌤️", text: "partly cloudy" };
  if (code === 3) return { emoji: "☁️", text: "overcast" };
  if ([45, 48].includes(code)) return { emoji: "🌫️", text: "fog" };
  if ([51, 53, 55, 56, 57].includes(code)) return { emoji: "🌦️", text: "drizzle" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { emoji: "🌧️", text: "rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { emoji: "❄️", text: "snow" };
  if ([95, 96, 99].includes(code)) return { emoji: "⛈️", text: "thunderstorm" };
  return { emoji: "🌡️", text: "" };
}
const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];
const SNOW_CODES = [71, 73, 75, 77, 85, 86];

async function resolveCoords(name) {
  if (KNOWN_COORDS[name]) return KNOWN_COORDS[name];
  if (prefs.coords[name]) return prefs.coords[name];
  const query = name.replace(/^Zürich\s+/i, "") || name;
  const url = `${GEO_API}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const data = await res.json();
  const r = data.results && data.results[0];
  if (!r) throw new Error("no geocode result");
  const c = { lat: r.latitude, lon: r.longitude, label: r.name };
  prefs.coords[name] = c;
  persist();
  return c;
}

async function weatherAt(station) {
  const c = await resolveCoords(station);
  const url = `${WX_API}?latitude=${c.lat}&longitude=${c.lon}` +
    `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  const d = await res.json();
  return { label: c.label, cur: d.current };
}

async function loadWeather(force = false) {
  if (!force && Date.now() - lastWeatherAt < WX_MS) return;
  const p = path();
  try {
    const [origin, dest] = await Promise.all([
      weatherAt(p.origin.station),
      weatherAt(p.dest.station),
    ]);
    renderWeather(
      { ...origin, role: `${p.origin.name} · walk to ${p.origin.station}` },
      { ...dest, role: `${p.dest.station} · walk to ${p.dest.name}` }
    );
    lastWeatherAt = Date.now();
  } catch (err) {
    console.error(err);
  }
}

function locPanel(w) {
  const cur = w.cur || {};
  const info = weatherInfo(cur.weather_code);
  const temp = Math.round(cur.temperature_2m);
  const feels = Math.round(cur.apparent_temperature);
  const wind = Math.round(cur.wind_speed_10m);
  const precip = cur.precipitation || 0;
  const meta = [
    Number.isFinite(feels) ? `feels ${feels}°` : "",
    Number.isFinite(wind) ? `💨 ${wind} km/h` : "",
    precip > 0 ? `🌧 ${precip} mm` : "",
  ].filter(Boolean).join(" · ");
  return `
    <div class="wx__loc">
      <div class="wx__role">${w.role}</div>
      <div class="wx__temp">${info.emoji} ${Number.isFinite(temp) ? temp + "°" : "–"}</div>
      <div class="wx__cond">${info.text}</div>
      <div class="wx__metaline">${meta}</div>
    </div>`;
}

function adviceFor(w) {
  const cur = w.cur || {};
  const code = cur.weather_code;
  if (RAIN_CODES.includes(code) || (cur.precipitation || 0) > 0) return "umbrella";
  if (SNOW_CODES.includes(code)) return "snow";
  if (Number.isFinite(cur.apparent_temperature) && cur.apparent_temperature <= 3) return "cold";
  return null;
}

function renderWeather(origin, dest) {
  const flags = new Set([adviceFor(origin), adviceFor(dest)].filter(Boolean));
  let advice = "";
  if (flags.has("umbrella")) advice = `<div class="wx__advice wx__advice--warn">☔ Rain on your walk — take an umbrella</div>`;
  else if (flags.has("snow")) advice = `<div class="wx__advice wx__advice--warn">❄️ Snow — boots & a warm coat</div>`;
  else if (flags.has("cold")) advice = `<div class="wx__advice wx__advice--cold">🧥 Chilly walk — bundle up</div>`;
  else advice = `<div class="wx__advice">🙂 Clear walk both ways</div>`;

  els.weather.innerHTML = advice +
    `<div class="wx__cols">${locPanel(origin)}${locPanel(dest)}</div>`;
  els.weather.hidden = false;
}

/* ---------- fetch + render departures ---------- */

async function loadDepartures() {
  const p = path();
  persist();

  setLive("loading");
  els.status.textContent = "Syncing departures…";
  try {
    const res = await fetch(buildUrl(p.origin.station, p.dest.station));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    connections = (data.connections || [])
      .filter((c) => c.from && c.from.departure)
      .filter((c) => (c.transfers || 0) === 0); // direct only
    lastFetchOk = true;

    // Overlay cancellations from search.ch (fail-safe: no flags on any error).
    const cancelled = await fetchCancellations(p.origin.station, p.dest.station);
    if (cancelled.size) {
      connections.forEach((c) => {
        const key = cancelKeyForConn(c);
        if (key && cancelled.has(key)) c._cancelled = true;
      });
    }

    render();
    const offline = !navigator.onLine;
    setLive(offline ? "error" : "ok");
    els.status.classList.remove("status--error");
    els.updated.textContent = `updated ${formatClockSec(new Date())}`;
    const cancelledCount = connections.filter(isCancelled).length;
    const cancelNote = cancelledCount ? ` · ${cancelledCount} cancelled` : "";
    els.status.textContent = offline
      ? `${connections.length} trains · offline (cached)${cancelNote}`
      : `${connections.length} trains · auto-refresh 60s${cancelNote}`;
    restartRefreshBar();
  } catch (err) {
    console.error(err);
    lastFetchOk = false;
    setLive("error");
    els.status.classList.add("status--error");
    els.status.textContent = navigator.onLine
      ? `Couldn't reach the timetable (${err.message}). Retrying…`
      : `Offline — no cached departures yet.`;
  }
}

function render() {
  const now = Date.now();
  // Keep showing trains until well past departure — we don't hide the ones whose
  // leave-by time has passed (run for it / see what was available), and we keep
  // already-departed trains for PAST_GRACE_MS so a late one you nearly caught
  // lingers. Show every recent-past train (capped) PLUS the next LIMIT upcoming,
  // so the history never pushes future trains off the board.
  const sorted = connections
    .filter((c) => departureDate(c).getTime() - now > -PAST_GRACE_MS)
    .sort((a, b) => departureDate(a) - departureDate(b));
  const past = sorted.filter((c) => departureDate(c).getTime() <= now).slice(-MAX_PAST);
  const future = sorted.filter((c) => departureDate(c).getTime() > now).slice(0, LIMIT);
  const upcoming = [...past, ...future];

  if (upcoming.length === 0) {
    els.board.innerHTML = `<div class="empty">No upcoming trains right now — check back soon.</div>`;
    return;
  }

  // Drop a stale selection (its train already rolled off the board), and with it
  // the live view — there's nothing left to focus on.
  if (selectedKey && !upcoming.some((c) => connKey(c) === selectedKey)) {
    selectedKey = null;
    walking = false;
    if (focusOpen) closeFocus();
  }

  els.board.innerHTML = upcoming.map((conn) => cardHtml(conn, now)).join("");
  if (focusOpen) renderFocus();
}

/* ---------- focus (live-view) screen ---------- */

const RADAR_PAGE = "trains.html";
// The iframe is rebuilt only when the focused train changes (tracked here), so
// per-second re-renders don't reset the map and its websocket every tick.
let focusMapFor = null;

function focusConn() {
  if (!selectedKey) return null;
  return connections.find((c) => connKey(c) === selectedKey) || null;
}

// Build the radar URL centred on the commute corridor, hinting the line + train
// number so the radar can auto-follow this exact vehicle when it appears.
function radarSrc(conn, embed) {
  const p = path();
  const a = KNOWN_COORDS[p.origin.station];
  const b = KNOWN_COORDS[p.dest.station];
  const c = a && b ? { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 } : (a || b || { lat: 47.32, lon: 8.54 });
  const params = new URLSearchParams({ center: `${c.lon},${c.lat}`, zoom: "11", line: lineOf(conn) });
  if (embed) params.set("embed", "1");
  const num = trainNumberOf(conn);
  if (num) params.set("trainno", num);
  return `${RADAR_PAGE}?${params.toString()}`;
}

function mountFocusMap() {
  const conn = focusConn();
  if (!conn) return;
  els.focusMapLink.href = radarSrc(conn, false);
  // Already resolved for this train (iframe mounted OR no-key hint shown)? Leave
  // it — rebuilding each tick would reset the map/socket every second.
  if (focusMapFor === selectedKey && (els.focusMap.firstChild || !els.focusMapHint.hidden)) return;
  focusMapFor = selectedKey;

  // No geOps key stored (by the radar) → the embedded map can't stream. Show a
  // helpful hint instead of an iframe that just nags for a key.
  const hasKey = (() => { try { return !!localStorage.getItem("radar-geops-key"); } catch (_) { return false; } })();
  if (!hasKey) {
    els.focusMap.replaceChildren();
    els.focusMapHint.hidden = false;
    els.focusMapHint.innerHTML =
      `Add a free <a href="https://developer.geops.io" target="_blank" rel="noopener">geOps key</a> to the ` +
      `<a href="${radarSrc(conn, false)}">live map</a> once and it shows here too.`;
    return;
  }
  els.focusMapHint.hidden = true;
  const iframe = document.createElement("iframe");
  iframe.className = "focus__mapframe";
  iframe.title = "Live train radar";
  iframe.loading = "lazy";
  iframe.allow = "geolocation";
  iframe.src = radarSrc(conn, true);
  els.focusMap.replaceChildren(iframe);
}

function openFocus() {
  const conn = focusConn();
  if (!conn) return;
  focusOpen = true;
  els.focus.hidden = false;
  document.body.classList.add("focus-open");
  focusMapFor = null; // force a fresh mount for this train
  mountFocusMap();
  renderFocus();
}

function closeFocus() {
  focusOpen = false;
  els.focus.hidden = true;
  document.body.classList.remove("focus-open");
  els.focusMap.replaceChildren(); // tear down the iframe → stops its websocket
  focusMapFor = null;
}

function metaRow(term, val) {
  return val ? `<div class="focus__mrow"><dt>${term}</dt><dd>${val}</dd></div>` : "";
}

function renderFocus() {
  if (!focusOpen) return;
  const conn = focusConn();
  if (!conn) {
    els.focusTimer.textContent = "—";
    els.focusTimerLabel.textContent = "this train is no longer listed";
    els.focusStatus.innerHTML = "";
    els.focusMeta.innerHTML = "";
    return;
  }
  const p = path();
  const now = Date.now();
  const dep = departureDate(conn);
  const cancelled = isCancelled(conn);
  const delay = delayMinutes(conn);
  const msToDep = dep.getTime() - now;
  const leaveBy = new Date(dep.getTime() - p.origin.walk * 60000);
  const msToLeave = leaveBy.getTime() - now;
  const departed = msToDep <= 0;
  const isWalking = walking && !cancelled;

  const arrivalDate = conn.to && conn.to.arrival ? new Date(conn.to.arrival) : null;
  const atDest = arrivalDate ? new Date(arrivalDate.getTime() + p.dest.walk * 60000) : null;

  // header
  els.focusLine.textContent = lineOf(conn);
  els.focusFrom.textContent = p.origin.name;
  els.focusTo.textContent = p.dest.name;

  // big timer + label + state colour
  let timer, label, state;
  if (cancelled) {
    timer = "✕"; label = "cancelled — pick another train"; state = "cancelled";
  } else if (departed) {
    const agoMin = Math.round(-msToDep / 60000);
    timer = "gone"; label = agoMin >= 1 ? `left ${agoMin} min ago` : "just left"; state = "gone";
  } else if (isWalking) {
    timer = formatCountdown(msToDep); label = `until it leaves · 🚶 you're walking`; state = "walking";
  } else if (msToLeave > 0) {
    timer = formatCountdown(msToLeave); label = `until you leave ${p.origin.name}`; state = msToLeave <= 120000 ? "boarding" : "ok";
  } else {
    timer = formatCountdown(msToDep); label = `🏃 run — until it leaves`; state = "run";
  }
  els.focusTimer.textContent = timer;
  els.focusTimer.className = `focus__timer focus__timer--${state}`;
  els.focusTimerLabel.textContent = label;

  // status chip
  let chip = "";
  if (cancelled) chip = `<span class="chip chip--cancelled">✕ Cancelled</span>`;
  else if (delay > 0) chip = `<span class="chip chip--late">+${delay}′ late</span>`;
  else if (hasPrognosis(conn)) chip = `<span class="chip chip--ontime">on time</span>`;
  const dir = directionOf(conn);
  els.focusStatus.innerHTML = chip + (dir ? `<span class="focus__dir">→ ${dir}</span>` : "");

  // walk toggle (meaningless once cancelled/departed)
  const walkable = !cancelled && !departed;
  els.focusWalk.hidden = !walkable;
  els.focusWalk.classList.toggle("walk-toggle--on", isWalking);
  els.focusWalk.setAttribute("aria-pressed", String(isWalking));
  els.focusWalk.textContent = isWalking ? "I’m walking ✓" : "🚶 I’m walking";

  // details grid
  els.focusMeta.innerHTML =
    metaRow("Departs", `<strong>${formatClock(dep)}</strong>${arrivalDate ? ` → ${formatClock(arrivalDate)}` : ""}`) +
    metaRow("Leave by", cancelled ? "—" : `<strong>${formatClock(leaveBy)}</strong>`) +
    metaRow(`${p.dest.name} by`, atDest ? `<strong>${formatClock(atDest)}</strong>` : "") +
    metaRow("Platform", conn.from.platform ? `Pl. ${conn.from.platform}` : "") +
    metaRow("Trip", formatDuration(conn.duration));

  els.focus.classList.toggle("focus--cancelled", cancelled);

  // Keep the embedded map in sync if the focused train changed.
  mountFocusMap();
}

function cardHtml(conn, now) {
  const p = path();
  const dep = departureDate(conn);
  const line = lineOf(conn);
  const cancelled = isCancelled(conn);
  const quick = isQuick(conn) && !cancelled; // a cancelled train isn't a "quick" option
  const delay = delayMinutes(conn);
  const key = connKey(conn);
  const selected = key === selectedKey;
  const isWalking = selected && walking && !cancelled; // you've left → count to the train, calmly

  const msToDep = dep.getTime() - now;
  const minsToDep = Math.round(msToDep / 60000);
  const leaveBy = new Date(dep.getTime() - p.origin.walk * 60000);
  const minsToLeave = Math.round((leaveBy.getTime() - now) / 60000);

  // Catchability: comfortable → head out → go → run (past walk time) → gone.
  const departed = minsToDep <= 0;
  const pastWalk = !departed && minsToLeave < 0; // missed the leisurely leave-by → you'd have to run

  const platform = conn.from.platform ? `Pl. ${conn.from.platform}` : "";
  const arrivalDate = conn.to && conn.to.arrival ? new Date(conn.to.arrival) : null;
  const atDest = arrivalDate ? new Date(arrivalDate.getTime() + p.dest.walk * 60000) : null;
  const duration = formatDuration(conn.duration);
  const transfers = conn.transfers || 0;

  // Big countdown. Default = minutes until you must leave the origin door.
  // Once you're walking, switch to a calm count toward the train leaving and
  // drop the go!/run!/gone drama — you're already on your way.
  let cdClass = "countdown";
  let bigText, bigLabel;
  if (cancelled) {
    cdClass += " countdown--cancelled";
    bigText = "✕";
    bigLabel = "cancelled";
  } else if (isWalking) {
    cdClass += " countdown--walking";
    if (departed) { bigText = "now"; bigLabel = "train leaving"; }
    else { bigText = `${minsToDep}`; bigLabel = "min till it leaves"; }
  } else {
    bigText = `${minsToLeave}`;
    bigLabel = "min to leave";
    if (departed) {
      cdClass += " countdown--now"; bigText = "gone";
      const agoMin = Math.round(-msToDep / 60000);
      bigLabel = agoMin >= 1 ? `left ${agoMin} min ago` : "just left";
    } else if (pastWalk) {
      cdClass += " countdown--run"; bigText = "run!";
      bigLabel = `${minsToDep} min to catch`;
    } else if (minsToLeave <= 0) {
      cdClass += " countdown--now"; bigText = "go!"; bigLabel = "leave now";
    } else if (minsToLeave <= 2) {
      cdClass += " countdown--boarding";
      bigLabel = "min — head out!";
    }
  }

  let statusChip = "";
  if (cancelled) statusChip = `<span class="chip chip--cancelled">✕ Cancelled</span>`;
  else if (delay > 0) statusChip = `<span class="chip chip--late">+${delay}′ late</span>`;
  else if (hasPrognosis(conn)) statusChip = `<span class="chip chip--ontime">on time</span>`;

  // A cancelled train drops the leave-by/arrival planning (you must not head out
  // for it) and says so plainly; a running train shows the full door-to-door meta.
  const meta = (cancelled ? [
    `🚫 <strong>Cancelled</strong> — don't leave for this one`,
    `🚆 ${formatClock(dep)}${arrivalDate ? `→${formatClock(arrivalDate)}` : ""}`,
    platform,
  ] : [
    `🚶 leave by <strong>${formatClock(leaveBy)}</strong>`,
    `🚆 ${formatClock(dep)}${arrivalDate ? `→${formatClock(arrivalDate)}` : ""}`,
    atDest ? `🏁 ${p.dest.name} by <strong>${formatClock(atDest)}</strong>` : "",
    duration ? `⏱ ${duration}` : "",
    platform,
    transfers > 0 ? `${transfers} transfer${transfers > 1 ? "s" : ""}` : "direct",
  ]).filter(Boolean).join(`<span class="dot">·</span>`);

  // When you pick a train, show a live ticking timer (mm:ss to departure) plus
  // an "I'm walking" toggle. While walking we show the time the train is at
  // *your* (departing) station — the platform you're walking toward — so you
  // know when to be there. (The boarding stop only exposes a departure time,
  // which is when the train is at your platform.)
  // Opens the full-screen live view (big timer + status + the train on the map).
  const focusBtn = `<button type="button" class="focus-open-btn" data-action="focus">🛰 Live view</button>`;

  let catchTimer = "";
  if (selected && cancelled) {
    // No countdown and no "I'm walking" for a train that isn't running — just
    // say so and nudge you to the next one.
    catchTimer = `
      <div class="catch-timer catch-timer--cancelled">
        <div class="catch-timer__info">
          <div class="catch-timer__row">
            <span class="catch-timer__clock">✕</span>
            <span class="catch-timer__label">cancelled — pick another train</span>
          </div>
        </div>
        ${focusBtn}
      </div>`;
  } else if (selected) {
    let cls, clock, label, sub = "";
    if (isWalking) {
      cls = "catch-timer--walking";
      clock = departed ? "now" : formatCountdown(msToDep);
      label = departed ? "🚶 board now!" : "🚶 walking · until it leaves";
      sub = `🚉 arrive ${p.origin.station} <strong>${formatClock(dep)}</strong>`;
    } else {
      cls = departed ? "catch-timer--gone" : pastWalk ? "catch-timer--run" : "";
      clock = departed ? "—" : formatCountdown(msToDep);
      label = departed ? "departed" : pastWalk ? "🏃 run to catch it" : "time to catch";
    }
    const walkBtn = `<button type="button" class="walk-toggle ${isWalking ? "walk-toggle--on" : ""}"
        data-action="walk" aria-pressed="${isWalking}">${isWalking ? "I’m walking ✓" : "🚶 I’m walking"}</button>`;
    catchTimer = `
      <div class="catch-timer ${cls}">
        <div class="catch-timer__info">
          <div class="catch-timer__row">
            <span class="catch-timer__clock">${clock}</span>
            <span class="catch-timer__label">${label}</span>
          </div>
          ${sub ? `<div class="catch-timer__sub">${sub}</div>` : ""}
        </div>
        <div class="catch-timer__actions">${focusBtn}${walkBtn}</div>
      </div>`;
  }

  const cardClasses = [
    "card",
    quick ? "card--s2" : "",
    cancelled ? "card--cancelled" : "",
    selected ? "card--selected" : "",
    isWalking ? "card--walking" : "",
    (pastWalk && !isWalking && !cancelled) ? "card--run" : "",
    (departed && !isWalking && !cancelled) ? "card--gone" : "",
  ].filter(Boolean).join(" ");

  return `
    <article class="${cardClasses}" data-key="${encodeURIComponent(key)}"
             role="button" tabindex="0" aria-pressed="${selected}"
             aria-label="Select ${line} departing ${formatClock(dep)}">
      <div class="line">${line}</div>
      <div class="details">
        <div class="details__top">
          <span class="dep-time">${formatClock(dep)}</span>
          ${statusChip}
          ${quick ? `<span class="badge-quick">⚡ Quick S2</span>` : ""}
          ${isWalking ? `<span class="chip chip--walking">🚶 walking</span>` : ""}
          ${(pastWalk && !isWalking) ? `<span class="chip chip--run">past walk time</span>` : ""}
        </div>
        <div class="details__meta">${meta}</div>
      </div>
      <div class="${cdClass}">
        <span class="countdown__min">${bigText}</span>
        <span class="countdown__label">${bigLabel}</span>
      </div>
      ${catchTimer}
    </article>`;
}

/* ---------- timers & events ---------- */

function startTimers() {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  refreshTimer = setInterval(() => { loadDepartures(); loadWeather(); }, REFRESH_MS);
  tickTimer = setInterval(() => {
    if (connections.length && lastFetchOk) render();
  }, TICK_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { loadDepartures(); loadWeather(); }
});
window.addEventListener("online", () => { loadDepartures(); loadWeather(true); });
window.addEventListener("offline", () => setLive("error"));

els.refreshBtn.addEventListener("click", () => { loadDepartures(); loadWeather(true); });
els.presets.addEventListener("click", (e) => {
  const btn = e.target.closest(".preset");
  if (btn && btn.dataset.preset !== activeId) applyPreset(btn.dataset.preset);
});
[els.walkOriginInput, els.walkDestInput].forEach((input) =>
  input.addEventListener("input", () => { persist(); if (connections.length) render(); })
);

// Pick / un-pick a train to focus its catch timer. Changing the pick clears
// any "walking" state — it belongs to the train you were heading for.
function toggleSelect(card) {
  const key = decodeURIComponent(card.dataset.key);
  selectedKey = selectedKey === key ? null : key;
  walking = false;
  render();
}
els.board.addEventListener("click", (e) => {
  // The in-card buttons ("I'm walking", "Live view") must act without also
  // toggling the card's selection.
  const walkBtn = e.target.closest("[data-action='walk']");
  if (walkBtn) { e.stopPropagation(); walking = !walking; render(); return; }
  const focusBtn = e.target.closest("[data-action='focus']");
  if (focusBtn) { e.stopPropagation(); openFocus(); return; }
  const card = e.target.closest(".card");
  if (card) toggleSelect(card);
});
els.board.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.target.closest("[data-action]")) return; // in-card buttons handle themselves
  const card = e.target.closest(".card");
  if (card) { e.preventDefault(); toggleSelect(card); }
});

/* ---------- focus screen events ---------- */

els.focusClose.addEventListener("click", closeFocus);
els.focusWalk.addEventListener("click", () => { walking = !walking; renderFocus(); render(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && focusOpen) closeFocus();
});

/* ---------- init ---------- */

function buildPresetButtons() {
  els.presets.innerHTML = Object.entries(PRESETS)
    .map(([id, p]) =>
      `<button class="preset" type="button" data-preset="${id}" role="tab">${p.pill}</button>`)
    .join("");
}

function init() {
  loadPrefs();
  buildPresetButtons();
  applyPreset(defaultPresetId()); // before noon → work, noon onward → home
  startTimers();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("sw.js").catch((e) => console.error("SW", e))
    );
  }
}

init();
