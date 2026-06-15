/**
 * Horgen → Zürich Enge departure board.
 *
 * Uses the free, CORS-enabled Swiss public-transport API:
 *   https://transport.opendata.ch/v1/connections
 * Weather comes from the free Open-Meteo API (no key).
 *
 * Shows the next 5 connections, highlights the "quick" S2, factors in your
 * walking time to the station, surfaces real-time delays, supports a direction
 * swap for the evening commute, warns about the weather on your walk, and works
 * offline / installs as a PWA.
 */

const API = "https://transport.opendata.ch/v1/connections";
const GEO_API = "https://geocoding-api.open-meteo.com/v1/search";
const WX_API = "https://api.open-meteo.com/v1/forecast";
const QUICK_LINE = "S2";
const LIMIT = 5;
const REFRESH_MS = 60_000; // refresh data every 60s
const TICK_MS = 1_000; // re-tick countdowns every second
const WX_MS = 10 * 60_000; // re-fetch weather every 10 min
const STORE_KEY = "horgen-enge-prefs";
const DEFAULT_HOME = "Horgen";
const DEFAULT_WORK = "Zürich Enge";
const DEFAULT_WALK = 12;

// Built-in coordinates so weather works out of the box for the usual stations.
const KNOWN_COORDS = {
  "Horgen": { lat: 47.2597, lon: 8.5958, label: "Horgen" },
  "Horgen Oberdorf": { lat: 47.2647, lon: 8.6010, label: "Horgen Oberdorf" },
  "Zürich Enge": { lat: 47.3642, lon: 8.5315, label: "Zürich Enge" },
  "Zürich HB": { lat: 47.3779, lon: 8.5403, label: "Zürich HB" },
};

const els = {
  board: document.getElementById("board"),
  status: document.getElementById("status"),
  updated: document.getElementById("updated"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  walkInput: document.getElementById("walkInput"),
  walkLabelText: document.getElementById("walkLabelText"),
  swapBtn: document.getElementById("swapBtn"),
  fromLabel: document.getElementById("fromLabel"),
  toLabel: document.getElementById("toLabel"),
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
  prefs.from = els.fromInput.value.trim();
  prefs.to = els.toInput.value.trim();
  prefs.walks[originName()] = walkMinutes();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch (_) { /* ignore */ }
}

function originName() {
  return els.fromInput.value.trim() || DEFAULT_HOME;
}

function walkMinutes() {
  const n = parseInt(els.walkInput.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Point the walk input + label at the current origin's saved value. */
function applyOriginWalk() {
  const saved = prefs.walks[originName()];
  els.walkInput.value = saved != null ? saved : DEFAULT_WALK;
  els.walkLabelText.textContent = `🚶 Walk from ${originName()} (min)`;
}

/* ---------- API helpers ---------- */

function buildUrl(from, to) {
  const params = new URLSearchParams({ from, to, limit: String(LIMIT) });
  return `${API}?${params.toString()}`;
}

function lineOf(conn) {
  const p = conn.products && conn.products[0];
  return (p || "?").trim();
}

function isQuick(conn) {
  return lineOf(conn).toUpperCase() === QUICK_LINE;
}

/** Live prognosis departure if available, else the planned one. */
function departureDate(conn) {
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  return new Date(prog || planned);
}

/**
 * Real-time delay in minutes. The API exposes this either as a numeric
 * `from.delay` (minutes) or implicitly via the prognosis departure time.
 */
function delayMinutes(conn) {
  if (conn.from && typeof conn.from.delay === "number") return conn.from.delay;
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  if (!prog || !planned) return 0;
  return Math.max(0, Math.round((new Date(prog) - new Date(planned)) / 60000));
}

/** True when we have a live prognosis to trust (so "on time" is meaningful). */
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
  // state: "ok" | "loading" | "error"
  els.liveDot.classList.remove("live--ok", "live--loading", "live--error");
  els.liveDot.classList.add(`live--${state}`);
  els.liveText.textContent =
    state === "loading" ? "SYNCING" : state === "error" ? "OFFLINE" : "LIVE";
  els.refreshBtn.classList.toggle("btn--loading", state === "loading");
}

/** Restart the depleting top progress bar (one full sweep per refresh cycle). */
function restartRefreshBar() {
  const bar = els.refreshBar;
  bar.style.animation = "none";
  // force reflow so the animation can restart
  void bar.offsetWidth;
  bar.style.animation = `deplete ${REFRESH_MS}ms linear forwards`;
}

/* ---------- weather ---------- */

/** WMO weather code → emoji + short text. */
function weatherInfo(code) {
  if (code === 0) return { emoji: "☀️", text: "clear" };
  if ([1, 2].includes(code)) return { emoji: "🌤️", text: "mostly sunny" };
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
  // Strip a leading city prefix like "Zürich " for a better geocoder hit.
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

async function loadWeather(force = false) {
  if (!force && Date.now() - lastWeatherAt < WX_MS) return;
  try {
    const c = await resolveCoords(originName());
    const url = `${WX_API}?latitude=${c.lat}&longitude=${c.lon}` +
      `&current=temperature_2m,precipitation,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
    const d = await res.json();
    if (d.current) {
      renderWeather(d.current, c.label);
      lastWeatherAt = Date.now();
    }
  } catch (err) {
    console.error(err);
  }
}

function renderWeather(cur, label) {
  const code = cur.weather_code;
  const temp = Math.round(cur.temperature_2m);
  const info = weatherInfo(code);

  let warn = "";
  if (RAIN_CODES.includes(code) || (cur.precipitation || 0) > 0) {
    warn = `<span class="wchip__warn">☔ take an umbrella</span>`;
  } else if (SNOW_CODES.includes(code)) {
    warn = `<span class="wchip__warn">🧥 snow — dress warm</span>`;
  }

  els.weather.innerHTML =
    `<span class="wchip__main">${info.emoji} ${temp}°C</span>` +
    `<span class="wchip__desc">${info.text}${label ? ` · ${label}` : ""}</span>` +
    warn;
  els.weather.hidden = false;
}

/* ---------- fetch + render departures ---------- */

async function loadDepartures() {
  const from = els.fromInput.value.trim() || DEFAULT_HOME;
  const to = els.toInput.value.trim() || DEFAULT_WORK;
  els.fromLabel.textContent = from;
  els.toLabel.textContent = to;
  persist();

  setLive("loading");
  els.status.textContent = "Syncing departures…";
  try {
    const res = await fetch(buildUrl(from, to));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    connections = (data.connections || []).filter((c) => c.from && c.from.departure);
    lastFetchOk = true;
    render();
    const offline = !navigator.onLine;
    setLive(offline ? "error" : "ok");
    els.status.classList.remove("status--error");
    els.updated.textContent = `updated ${formatClockSec(new Date())}`;
    els.status.textContent = offline
      ? `${connections.length} connections · offline (cached)`
      : `${connections.length} connections · auto-refresh 60s`;
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
  const upcoming = connections
    .filter((c) => departureDate(c).getTime() - now > -60_000)
    .sort((a, b) => departureDate(a) - departureDate(b))
    .slice(0, LIMIT);

  if (upcoming.length === 0) {
    els.board.innerHTML = `<div class="empty">No upcoming departures found.</div>`;
    return;
  }

  els.board.innerHTML = upcoming.map((conn) => cardHtml(conn, now)).join("");
}

function cardHtml(conn, now) {
  const dep = departureDate(conn);
  const walk = walkMinutes();
  const line = lineOf(conn);
  const quick = isQuick(conn);
  const delay = delayMinutes(conn);

  const minsToDep = Math.round((dep.getTime() - now) / 60000);
  const leaveBy = new Date(dep.getTime() - walk * 60000);
  const minsToLeave = Math.round((leaveBy.getTime() - now) / 60000);

  const platform = conn.from.platform ? `Pl. ${conn.from.platform}` : "";
  const arrival = conn.to && conn.to.arrival ? formatClock(new Date(conn.to.arrival)) : "";
  const duration = formatDuration(conn.duration);
  const transfers = conn.transfers || 0;

  // The big countdown = time until you must leave home (if a walk is set),
  // otherwise time until the train departs.
  const primaryMins = walk > 0 ? minsToLeave : minsToDep;
  let cdClass = "countdown";
  let bigText = `${primaryMins}`;
  let bigLabel = walk > 0 ? "min to leave" : "min";
  if (primaryMins <= 0) {
    if (minsToDep <= 0) { cdClass += " countdown--now"; bigText = "now"; bigLabel = "departing"; }
    else { cdClass += " countdown--now"; bigText = "go!"; bigLabel = "leave now"; }
  } else if (primaryMins <= 2) {
    cdClass += " countdown--boarding";
    bigLabel = walk > 0 ? "min — head out!" : "min — go!";
  }

  // Delay / punctuality chip.
  let statusChip = "";
  if (delay > 0) {
    statusChip = `<span class="chip chip--late">+${delay}′ late</span>`;
  } else if (hasPrognosis(conn)) {
    statusChip = `<span class="chip chip--ontime">on time</span>`;
  }

  const meta = [
    walk > 0 ? `🚶 leave by <strong>${formatClock(leaveBy)}</strong>` : "",
    `🚆 dep ${formatClock(dep)}`,
    arrival ? `→ arr ${arrival}` : "",
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

/* ---------- direction swap ---------- */

function swapDirection() {
  const from = els.fromInput.value;
  els.fromInput.value = els.toInput.value;
  els.toInput.value = from;
  applyOriginWalk();
  loadDepartures();
  loadWeather(true);
}

/* ---------- timers & events ---------- */

function startTimers() {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  refreshTimer = setInterval(() => {
    loadDepartures();
    loadWeather();
  }, REFRESH_MS);
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
els.swapBtn.addEventListener("click", swapDirection);
els.walkInput.addEventListener("input", () => { persist(); if (connections.length) render(); });
[els.fromInput, els.toInput].forEach((input) =>
  input.addEventListener("change", () => { applyOriginWalk(); loadWeather(true); })
);
[els.fromInput, els.toInput].forEach((input) =>
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") loadDepartures(); })
);

/* ---------- init ---------- */

function init() {
  const hadPrefs = !!localStorage.getItem(STORE_KEY);
  loadPrefs();

  if (hadPrefs && prefs.from && prefs.to) {
    els.fromInput.value = prefs.from;
    els.toInput.value = prefs.to;
  } else {
    // First visit: orient by time of day (morning = to work, else to home).
    const h = new Date().getHours();
    const toWork = h >= 3 && h < 14;
    els.fromInput.value = toWork ? DEFAULT_HOME : DEFAULT_WORK;
    els.toInput.value = toWork ? DEFAULT_WORK : DEFAULT_HOME;
  }
  applyOriginWalk();

  loadDepartures();
  loadWeather(true);
  startTimers();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("sw.js").catch((e) => console.error("SW", e))
    );
  }
}

init();
