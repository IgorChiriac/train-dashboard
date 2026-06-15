/**
 * Horgen → Zürich Enge departure board.
 *
 * Uses the free, CORS-enabled Swiss public-transport API:
 *   https://transport.opendata.ch/v1/connections
 *
 * Shows the next 5 connections, highlights the "quick" S2, factors in your
 * walking time to the station, and surfaces real-time delays.
 */

const API = "https://transport.opendata.ch/v1/connections";
const QUICK_LINE = "S2";
const LIMIT = 5;
const REFRESH_MS = 60_000; // refresh data every 60s
const TICK_MS = 1_000; // re-tick countdowns every second
const STORE_KEY = "horgen-enge-prefs";

const els = {
  board: document.getElementById("board"),
  status: document.getElementById("status"),
  updated: document.getElementById("updated"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  walkInput: document.getElementById("walkInput"),
  fromLabel: document.getElementById("fromLabel"),
  toLabel: document.getElementById("toLabel"),
  refreshBtn: document.getElementById("refreshBtn"),
  refreshBar: document.getElementById("refreshBar"),
  liveDot: document.getElementById("liveDot"),
  liveText: document.getElementById("liveText"),
};

let connections = [];
let refreshTimer = null;
let tickTimer = null;
let lastFetchOk = false;

/* ---------- preferences ---------- */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (p.from) els.fromInput.value = p.from;
    if (p.to) els.toInput.value = p.to;
    if (p.walk != null) els.walkInput.value = p.walk;
  } catch (_) { /* ignore */ }
}

function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      from: els.fromInput.value.trim(),
      to: els.toInput.value.trim(),
      walk: walkMinutes(),
    }));
  } catch (_) { /* ignore */ }
}

function walkMinutes() {
  const n = parseInt(els.walkInput.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
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

/* ---------- fetch + render ---------- */

async function loadDepartures() {
  const from = els.fromInput.value.trim() || "Horgen";
  const to = els.toInput.value.trim() || "Zürich Enge";
  els.fromLabel.textContent = from;
  els.toLabel.textContent = to;
  savePrefs();

  setLive("loading");
  els.status.textContent = "Syncing departures…";
  try {
    const res = await fetch(buildUrl(from, to));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    connections = (data.connections || []).filter((c) => c.from && c.from.departure);
    lastFetchOk = true;
    render();
    setLive("ok");
    els.updated.textContent = `updated ${formatClockSec(new Date())}`;
    els.status.textContent = `${connections.length} connections · auto-refresh 60s`;
    restartRefreshBar();
  } catch (err) {
    console.error(err);
    lastFetchOk = false;
    setLive("error");
    els.status.classList.add("status--error");
    els.status.textContent = `Couldn't reach the timetable (${err.message}). Retrying…`;
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

  els.status.classList.remove("status--error");
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

/* ---------- timers & events ---------- */

function startTimers() {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  refreshTimer = setInterval(loadDepartures, REFRESH_MS);
  tickTimer = setInterval(() => {
    if (connections.length && lastFetchOk) render();
  }, TICK_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadDepartures();
});

els.refreshBtn.addEventListener("click", loadDepartures);
els.walkInput.addEventListener("input", () => { savePrefs(); if (connections.length) render(); });
[els.fromInput, els.toInput].forEach((input) =>
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") loadDepartures(); })
);

loadPrefs();
loadDepartures();
startTimers();
