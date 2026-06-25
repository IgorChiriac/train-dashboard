# 🚆 Horgen → Zürich Enge Departure Dashboard

A tiny, zero-dependency dashboard that shows the **next 5 train departures**
from your home station (Horgen, near Brunnenwiesliweg 8) to **Zürich Enge**,
and highlights the **quick S2** so you can spot it at a glance.

![route: Horgen → Zürich Enge](https://img.shields.io/badge/Horgen-%E2%86%92%20Z%C3%BCrich%20Enge-ffd23f)

## Features

- ⚡ **S2 highlighting** — the fast S2 connections get a green card and a "Quick S2" badge.
- ⏱ **Live countdowns** — each departure shows minutes-to-go, ticking every second, with a "go!" warning at ≤ 2 min and "now" when departing.
- 🎯 **Pick a train** — tap any departure to focus it and watch a live `mm:ss` timer of the time left to catch it.
- 🏃 **Run-for-it / history** — trains past your leave-by time are no longer hidden; they stay on the board flagged "past walk time" (with a "run!" countdown) so you can still sprint for them or see what was available.
- 🚉 Departure & arrival times, platform, trip duration, transfers, and real-time delays.
- 🔄 Auto-refreshes every 60s and whenever you return to the tab.
- ✏️ Editable **From / To** fields if you ever start from a different station.
- 📱 Responsive — works on phone and desktop.

## How to run

It's a static site — no build step, no install.

**Option A — just open it**

Open `index.html` in your browser. (Most browsers allow the API call directly.)

**Option B — serve it locally** (recommended)

```bash
cd train-dashboard
python3 -m http.server 8000
# then open http://localhost:8000
```

## Data source

Departures come from the free, CORS-enabled
[Swiss public-transport API](https://transport.opendata.ch) (`/v1/connections`),
which is backed by official SBB / opendata.swiss timetables. No API key required.

## Notes

- The default origin is **Horgen** (the lakeside station nearest Brunnenwiesliweg 8).
  If you prefer **Horgen Oberdorf**, just type it in the "From" field.
- The S2 on the left-bank Zürichsee line runs Pfäffikon SZ / Ziegelbrücke ↔ Zürich
  and stops at **Zürich Enge** — that's the quick one this board flags for you.
