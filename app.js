/**
 * Horgen → Zürich Enge departure board.
 *
 * Uses the free, CORS-enabled Swiss public-transport API:
 *   https://transport.opendata.ch/v1/connections
 *
 * Shows the next 5 connections and highlights the "quick" S2.
 */

const API = "https://transport.opendata.ch/v1/connections";
const QUICK_LINE = "S2";
const LIMIT = 5;
const REFRESH_MS = 60_000; // refresh data every 60s
const TICK_MS = 1_000; // re-tick countdowns every second

const els = {
  board: document.getElementById("board"),
  status: document.getElementById("status"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  fromLabel: document.getElementById("fromLabel"),
  toLabel: document.getElementById("toLabel"),
  refreshBtn: document.getElementById("refreshBtn"),
};

let connections = [];
let refreshTimer = null;
let tickTimer = null;

/** Build the API URL for the current from/to. */
function buildUrl(from, to) {
  const params = new URLSearchParams({
    from,
    to,
    limit: String(LIMIT),
  });
  return `${API}?${params.toString()}`;
}

/** The line label for a connection, e.g. "S2", "S8", "IR". */
function lineOf(conn) {
  const p = conn.products && conn.products[0];
  return (p || "?").trim();
}

function isQuick(conn) {
  return lineOf(conn).toUpperCase() === QUICK_LINE;
}

/** Effective departure date, accounting for live prognosis if present. */
function departureDate(conn) {
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  return new Date(prog || planned);
}

/** Delay in minutes vs. the planned time (0 if none / on time). */
function delayMinutes(conn) {
  const prog = conn.from && conn.from.prognosis && conn.from.prognosis.departure;
  const planned = conn.from && conn.from.departure;
  if (!prog || !planned) return 0;
  return Math.round((new Date(prog) - new Date(planned)) / 60000);
}

/** "00d00:14:00" → "14 min". */
function formatDuration(iso) {
  if (!iso) return "";
  const m = iso.match(/(\d+)d(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return "";
  const [, d, hh, mm] = m;
  const total = Number(d) * 1440 + Number(hh) * 60 + Number(mm);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  return `${h}h ${total % 60}min`;
}

function formatClock(date) {
  return date.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

async function loadDepartures() {
  const from = els.fromInput.value.trim() || "Horgen";
  const to = els.toInput.value.trim() || "Zürich Enge";
  els.fromLabel.textContent = from;
  els.toLabel.textContent = to;

  setStatus("Loading departures…");
  try {
    const res = await fetch(buildUrl(from, to));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    connections = (data.connections || []).filter((c) => c.from && c.from.departure);
    render();
    setStatus(`Updated ${formatClock(new Date())}`);
  } catch (err) {
    console.error(err);
    setStatus(`Could not load departures (${err.message}). Retrying…`, true);
  }
}

function render() {
  const now = Date.now();
  // Keep only upcoming departures, soonest first.
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
  const line = lineOf(conn);
  const quick = isQuick(conn);
  const minsToGo = Math.round((dep.getTime() - now) / 60000);
  const delay = delayMinutes(conn);
  const platform = conn.from.platform ? `Pl. ${conn.from.platform}` : "";
  const arrival = conn.to && conn.to.arrival ? formatClock(new Date(conn.to.arrival)) : "";
  const duration = formatDuration(conn.duration);
  const transfers = conn.transfers || 0;

  let countdownClass = "countdown";
  let minText = `${minsToGo}`;
  let label = "min";
  if (minsToGo <= 0) {
    countdownClass += " countdown--now";
    minText = "now";
    label = "departing";
  } else if (minsToGo <= 2) {
    countdownClass += " countdown--boarding";
    label = "min — go!";
  }

  const meta = [
    `🕑 ${formatClock(dep)}`,
    arrival ? `→ ${arrival}` : "",
    duration ? `⏱ ${duration}` : "",
    platform,
    transfers > 0 ? `${transfers} transfer${transfers > 1 ? "s" : ""}` : "direct",
    delay > 0 ? `<span class="delay">+${delay}′</span>` : "",
  ].filter(Boolean).join("<span>·</span> ");

  return `
    <article class="card ${quick ? "card--s2" : ""}">
      <div class="line">${line}</div>
      <div class="details">
        <div class="details__top">
          <span class="dep-time">${formatClock(dep)}</span>
          ${quick ? `<span class="badge-quick">⚡ Quick S2</span>` : ""}
        </div>
        <div class="details__meta">${meta}</div>
      </div>
      <div class="${countdownClass}">
        <span class="countdown__min">${minText}</span>
        <span class="countdown__label">${label}</span>
      </div>
    </article>`;
}

function setStatus(text, isError = false) {
  els.status.innerHTML = text;
  els.status.classList.toggle("status--error", isError);
}

function startTimers() {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  refreshTimer = setInterval(loadDepartures, REFRESH_MS);
  // Re-render every second so countdowns stay live between fetches.
  tickTimer = setInterval(() => {
    if (connections.length) render();
  }, TICK_MS);
}

// Refresh when the user comes back to the tab.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadDepartures();
});

els.refreshBtn.addEventListener("click", loadDepartures);
[els.fromInput, els.toInput].forEach((input) =>
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadDepartures();
  })
);

loadDepartures();
startTimers();
