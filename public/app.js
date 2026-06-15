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
const GEO_API = "https://geocoding-api.open-meteo.com/v1/search";
const WX_API = "https://api.open-meteo.com/v1/forecast";
const QUICK_LINE = "S2";
const LIMIT = 5;
const REFRESH_MS = 60_000;
const TICK_MS = 1_000;
const WX_MS = 10 * 60_000;
const STORE_KEY = "commute-prefs-v3";

// --- Predefined commute paths -------------------------------------------------
// Each leg endpoint: { name, place, station, walk } where `walk` is the default
// minutes between the address and that path's *boarding/alighting* station.
const PRESETS = {
  toWork: {
    label: "To work",
    origin: { name: "Home", place: "Brunnenwiesliweg 8, Horgen", station: "Horgen", walk: 5 },
    dest: { name: "Office", place: "Bleicherweg 21, 8002 Zürich", station: "Zürich Enge", walk: 8 },
  },
  toHome: {
    label: "To home",
    origin: { name: "Office", place: "Bleicherweg 21, 8002 Zürich", station: "Zürich Enge", walk: 8 },
    dest: { name: "Home", place: "Brunnenwiesliweg 8, Horgen", station: "Horgen", walk: 5 },
  },
};

// Built-in coordinates so the weather works out of the box.
const KNOWN_COORDS = {
  "Horgen": { lat: 47.2597, lon: 8.5958, label: "Horgen" },
  "Zürich Enge": { lat: 47.3642, lon: 8.5315, label: "Zürich Enge" },
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
};

let connections = [];
let refreshTimer = null;
let tickTimer = null;
let lastFetchOk = false;
let lastWeatherAt = 0;
let activeId = "toWork";
let prefs = { walks: {}, coords: {} };

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
  const p = path();

  // walk inputs + labels
  els.walkOriginInput.value = p.origin.walk;
  els.walkDestInput.value = p.dest.walk;
  els.walkOriginLabel.textContent = `🚶 ${p.origin.name} → ${p.origin.station}`;
  els.walkDestLabel.textContent = `🚶 ${p.dest.station} → ${p.dest.name}`;

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
  // direct=1 → only connections without a transfer. Request a few extra so the
  // client-side guard still leaves enough to show.
  const params = new URLSearchParams({
    from, to, direct: "1", limit: String(LIMIT + 3),
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

function departureDate(conn) {
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  return new Date(prog || planned);
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
    render();
    const offline = !navigator.onLine;
    setLive(offline ? "error" : "ok");
    els.status.classList.remove("status--error");
    els.updated.textContent = `updated ${formatClockSec(new Date())}`;
    els.status.textContent = offline
      ? `${connections.length} trains · offline (cached)`
      : `${connections.length} trains · auto-refresh 60s`;
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
  const walkMs = path().origin.walk * 60000;
  // Only trains you can still catch: leave-by time (departure − walk) must not
  // have passed (small 30s grace so the one you should run for lingers briefly).
  const upcoming = connections
    .filter((c) => departureDate(c).getTime() - walkMs - now > -30_000)
    .sort((a, b) => departureDate(a) - departureDate(b))
    .slice(0, LIMIT);

  if (upcoming.length === 0) {
    els.board.innerHTML = `<div class="empty">No trains you can still catch — check back soon.</div>`;
    return;
  }
  els.board.innerHTML = upcoming.map((conn) => cardHtml(conn, now)).join("");
}

function cardHtml(conn, now) {
  const p = path();
  const dep = departureDate(conn);
  const line = lineOf(conn);
  const quick = isQuick(conn);
  const delay = delayMinutes(conn);

  const minsToDep = Math.round((dep.getTime() - now) / 60000);
  const leaveBy = new Date(dep.getTime() - p.origin.walk * 60000);
  const minsToLeave = Math.round((leaveBy.getTime() - now) / 60000);

  const platform = conn.from.platform ? `Pl. ${conn.from.platform}` : "";
  const arrivalDate = conn.to && conn.to.arrival ? new Date(conn.to.arrival) : null;
  const atDest = arrivalDate ? new Date(arrivalDate.getTime() + p.dest.walk * 60000) : null;
  const duration = formatDuration(conn.duration);
  const transfers = conn.transfers || 0;

  // Big countdown = minutes until you must leave the origin door.
  const primaryMins = minsToLeave;
  let cdClass = "countdown";
  let bigText = `${primaryMins}`;
  let bigLabel = "min to leave";
  if (primaryMins <= 0) {
    if (minsToDep <= 0) { cdClass += " countdown--now"; bigText = "gone"; bigLabel = "departed"; }
    else { cdClass += " countdown--now"; bigText = "go!"; bigLabel = "leave now"; }
  } else if (primaryMins <= 2) {
    cdClass += " countdown--boarding";
    bigLabel = "min — head out!";
  }

  let statusChip = "";
  if (delay > 0) statusChip = `<span class="chip chip--late">+${delay}′ late</span>`;
  else if (hasPrognosis(conn)) statusChip = `<span class="chip chip--ontime">on time</span>`;

  const meta = [
    `🚶 leave by <strong>${formatClock(leaveBy)}</strong>`,
    `🚆 ${formatClock(dep)}${arrivalDate ? `→${formatClock(arrivalDate)}` : ""}`,
    atDest ? `🏁 ${p.dest.name} by <strong>${formatClock(atDest)}</strong>` : "",
    duration ? `⏱ ${duration}` : "",
    platform,
    transfers > 0 ? `${transfers} transfer${transfers > 1 ? "s" : ""}` : "direct",
  ].filter(Boolean).join(`<span class="dot">·</span>`);

  return `
    <article class="card ${quick ? "card--s2" : ""}">
      <div class="line">${line}</div>
      <div class="details">
        <div class="details__top">
          <span class="dep-time">${formatClock(dep)}</span>
          ${statusChip}
          ${quick ? `<span class="badge-quick">⚡ Quick S2</span>` : ""}
        </div>
        <div class="details__meta">${meta}</div>
      </div>
      <div class="${cdClass}">
        <span class="countdown__min">${bigText}</span>
        <span class="countdown__label">${bigLabel}</span>
      </div>
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

/* ---------- init ---------- */

function init() {
  loadPrefs();
  applyPreset(defaultPresetId()); // morning → work, afternoon → home
  startTimers();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("sw.js").catch((e) => console.error("SW", e))
    );
  }
}

init();
