// ============================================================
// js/strava.js
// Strava OAuth 2.0 Flow, Aktivitäten-Abruf & Master-Detail Ansicht
// ============================================================

import { db }              from "./firebase-config.js";
import { getSecrets }      from "./config.js";
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast }       from "./ui-helpers.js";
import { publishUserStatsToHub } from "./hub.js";

// ── Strava-Konstanten ──────────────────────────────────────
const STRAVA_REDIRECT_URI = window.location.origin + window.location.pathname;
const STRAVA_SCOPE        = "read,activity:read";
const STRAVA_API_BASE     = "https://www.strava.com/api/v3";

/** Gibt die Strava-Config mit Secrets zurück (nach loadSecrets()). */
function getStravaConfig() {
  const s = getSecrets();
  return {
    clientId:     s.stravaClientId,
    clientSecret: s.stravaClientSecret,
    redirectUri:  STRAVA_REDIRECT_URI,
    scope:        STRAVA_SCOPE,
  };
}

// ── Zustand ────────────────────────────────────────────────
let currentUser         = null;
let stravaTokens        = null;
let allActivities       = [];
let filteredActivities  = [];
let selectedActivityId  = null;
let currentFilterSport  = "all";
let currentSearchQuery  = "";
let syncDaysSetting     = 30; // Standard: 30 Tage
let detailChartInstance = null;

// ── Initialisierung ────────────────────────────────────────
export async function initStrava(user) {
  currentUser = user;
  renderStravaSkeleton();

  // Prüfe ob wir gerade vom Strava-OAuth-Callback kommen
  const urlParams = new URLSearchParams(window.location.search);
  const code      = urlParams.get("code");
  const state     = urlParams.get("state");

  if (code && state === "strava_oauth") {
    window.history.replaceState({}, document.title, window.location.pathname);
    await handleStravaCallback(code);
    return;
  }

  // Vorhandene Tokens aus Firestore laden
  await loadStravaTokens();

  if (stravaTokens?.accessToken) {
    // Vorhandene gecachte Aktivitäten laden oder frisch abrufen
    const cached = await loadCachedActivities();
    if (cached.length > 0) {
      allActivities = cached;
      selectedActivityId = allActivities[0]?.id || null;
      renderActivitiesView();
      // Im Hintergrund Hub synchronisieren
      publishUserStatsToHub(allActivities, stravaTokens);
    } else {
      await fetchAndDisplayActivities(syncDaysSetting);
    }
  } else {
    showConnectButton();
  }
}

// ── OAuth Flow ─────────────────────────────────────────────
export function connectToStrava() {
  let cfg;
  try {
    cfg = getStravaConfig();
  } catch (err) {
    showToast("Secrets nicht geladen – bitte erst einloggen.", "error");
    return;
  }

  const params = new URLSearchParams({
    client_id:       cfg.clientId,
    redirect_uri:    cfg.redirectUri,
    response_type:   "code",
    approval_prompt: "auto",
    scope:           cfg.scope,
    state:           "strava_oauth",
  });

  window.location.href = `https://www.strava.com/oauth/authorize?${params}`;
}

async function handleStravaCallback(code) {
  showStravaLoading("Verbinde mit Strava…");

  try {
    const cfg      = getStravaConfig();
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type:    "authorization_code",
      }),
    });

    if (!response.ok) throw new Error(`Strava Token-Fehler: ${response.status}`);

    const data = await response.json();

    stravaTokens = {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:    data.expires_at,
      athleteId:    data.athlete?.id,
      athleteName:  data.athlete ? `${data.athlete.firstname} ${data.athlete.lastname}` : "Strava Athlet",
      athleteProfile: data.athlete?.profile || null,
    };

    await saveStravaTokens(stravaTokens);
    showToast(`Strava verbunden: ${stravaTokens.athleteName} 🎉`, "success");
    await fetchAndDisplayActivities(syncDaysSetting);

  } catch (err) {
    console.error("Strava Callback Fehler:", err);
    showToast("Strava-Verbindung fehlgeschlagen.", "error");
    showConnectButton();
  }
}

// ── Token-Management ───────────────────────────────────────
async function loadStravaTokens() {
  try {
    const ref  = doc(db, "users", currentUser.uid, "profile", "strava");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      stravaTokens = snap.data();
    }
  } catch (err) {
    console.error("Fehler beim Laden der Strava-Tokens:", err);
  }
}

async function saveStravaTokens(tokens) {
  const ref = doc(db, "users", currentUser.uid, "profile", "strava");
  await setDoc(ref, tokens);
}

async function getValidAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (stravaTokens.expiresAt > now + 300) {
    return stravaTokens.accessToken;
  }

  console.log("Strava Access Token abgelaufen – erneuere…");
  const cfg      = getStravaConfig();
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type:    "refresh_token",
      refresh_token: stravaTokens.refreshToken,
    }),
  });

  if (!response.ok) throw new Error("Token-Refresh fehlgeschlagen");

  const data = await response.json();
  stravaTokens.accessToken  = data.access_token;
  stravaTokens.refreshToken = data.refresh_token;
  stravaTokens.expiresAt    = data.expires_at;

  await saveStravaTokens(stravaTokens);
  return stravaTokens.accessToken;
}

// ── Aktivitäten abrufen mit konfigurierbarem Zeitraum ──────
/**
 * Ruft Aktivitäten von Strava ab, die nicht älter als `days` Tage sind.
 * @param {number} days Anzahl Tage in die Vergangenheit
 */
export async function fetchAndDisplayActivities(days = syncDaysSetting) {
  syncDaysSetting = parseInt(days, 10) || 30;
  showStravaLoading(`Synchronisiere Aktivitäten der letzten ${syncDaysSetting} Tage…`);

  try {
    const token = await getValidAccessToken();
    const afterEpoch = Math.floor(Date.now() / 1000) - (syncDaysSetting * 24 * 3600);

    let fetched = [];
    let page = 1;
    let hasMore = true;

    // Paginierung: Bis zu 200 Aktivitäten laden
    while (hasMore && page <= 2) {
      const url = `${STRAVA_API_BASE}/athlete/activities?after=${afterEpoch}&per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) throw new Error(`Strava API Fehler: ${response.status}`);
      const pageActs = await response.json();

      if (Array.isArray(pageActs) && pageActs.length > 0) {
        fetched = fetched.concat(pageActs);
        if (pageActs.length < 100) hasMore = false;
        page++;
      } else {
        hasMore = false;
      }
    }

    allActivities = fetched;
    if (allActivities.length > 0) {
      selectedActivityId = allActivities[0].id;
    }

    // In Firestore cachen
    await cacheActivities(allActivities);

    // Eigene Stats für den Hub aktualisieren
    await publishUserStatsToHub(allActivities, stravaTokens);

    showToast(`✅ ${allActivities.length} Aktivitäten synchronisiert!`, "success");
    renderActivitiesView();

  } catch (err) {
    console.error("Fehler beim Laden der Aktivitäten:", err);
    showToast(`Synchronisation fehlgeschlagen: ${err.message}`, "error");
    if (allActivities.length === 0) {
      showConnectButton();
    } else {
      renderActivitiesView();
    }
  }
}

async function cacheActivities(activities) {
  const ref = doc(db, "users", currentUser.uid, "cache", "activities");
  await setDoc(ref, {
    data:      activities,
    updatedAt: new Date().toISOString(),
    syncDays:  syncDaysSetting,
  });
}

async function loadCachedActivities() {
  try {
    const ref  = doc(db, "users", currentUser.uid, "cache", "activities");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data().data || [];
    }
  } catch (err) {
    console.error("Fehler beim Laden der Cache-Aktivitäten:", err);
  }
  return [];
}

// ── Rendering der Aktivitäten-Ansicht (Master-Detail) ──────
export function renderActivitiesView() {
  const container = document.getElementById("strava-content");
  if (!container) return;

  // Filter anwenden
  applyFilters();

  const totalKm    = allActivities.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
  const totalHours = allActivities.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;
  const totalCount = allActivities.length;

  const swimKm = allActivities.filter(a => a.type === "Swim").reduce((s, a) => s + (a.distance || 0), 0) / 1000;
  const bikeKm = allActivities.filter(a => a.type === "Ride").reduce((s, a) => s + (a.distance || 0), 0) / 1000;
  const runKm  = allActivities.filter(a => a.type === "Run").reduce((s, a) => s + (a.distance || 0), 0) / 1000;

  container.innerHTML = `
    <!-- ── Synchronisations-Toolbar ──────────────────────── -->
    <div class="sync-toolbar">
      <div class="sync-toolbar-left">
        <label for="sync-timeframe-select">Aktivitäten synchronisieren ab:</label>
        <div class="sync-select-group">
          <select id="sync-timeframe-select" class="form-select">
            <option value="7"   ${syncDaysSetting === 7 ? 'selected' : ''}>Letzte 7 Tage (1 Woche)</option>
            <option value="14"  ${syncDaysSetting === 14 ? 'selected' : ''}>Letzte 14 Tage (2 Wochen)</option>
            <option value="30"  ${syncDaysSetting === 30 ? 'selected' : ''}>Letzte 30 Tage (~1 Monat)</option>
            <option value="60"  ${syncDaysSetting === 60 ? 'selected' : ''}>Letzte 60 Tage (~2 Monate)</option>
            <option value="90"  ${syncDaysSetting === 90 ? 'selected' : ''}>Letzte 90 Tage (~3 Monate)</option>
            <option value="180" ${syncDaysSetting === 180 ? 'selected' : ''}>Letzte 6 Monate (180 Tage)</option>
            <option value="365" ${syncDaysSetting === 365 ? 'selected' : ''}>Letztes Jahr (365 Tage)</option>
            <option value="custom" ${![7,14,30,60,90,180,365].includes(syncDaysSetting) ? 'selected' : ''}>Benutzerdefiniert...</option>
          </select>

          <!-- Benutzerdefinierte Eingabe (falls 'custom') -->
          <div id="custom-sync-inputs" class="custom-inputs ${[7,14,30,60,90,180,365].includes(syncDaysSetting) ? 'hidden' : ''}">
            <input type="number" id="custom-sync-val" min="1" max="730" value="${syncDaysSetting}" class="form-input-sm" />
            <select id="custom-sync-unit" class="form-select-sm">
              <option value="days" selected>Tage</option>
              <option value="weeks">Wochen</option>
            </select>
          </div>

          <button id="btn-sync-trigger" class="btn btn-secondary btn-sync">
            🔄 Jetzt aktualisieren
          </button>
        </div>
      </div>

      <div class="sync-toolbar-right">
        <span class="sync-badge">
          ✅ Verbunden mit Strava: <strong>${stravaTokens?.athleteName || "Athlet"}</strong>
        </span>
      </div>
    </div>

    <!-- ── Schnell-Übersicht KPI-Kacheln ──────────────────── -->
    <div class="activities-kpi-grid">
      <div class="stat-box">
        <div class="stat-value">${totalKm.toFixed(0)}</div>
        <div class="stat-label">Gesamt-Kilometer</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${totalHours.toFixed(1)}</div>
        <div class="stat-label">Trainingsstunden</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${swimKm.toFixed(1)}</div>
        <div class="stat-label">🏊 Schwimmen (km)</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${bikeKm.toFixed(1)}</div>
        <div class="stat-label">🚴 Rad (km)</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${runKm.toFixed(1)}</div>
        <div class="stat-label">🏃 Laufen (km)</div>
      </div>
    </div>

    <!-- ── Master-Detail Layout ───────────────────────────── -->
    <div class="activities-master-detail">
      
      <!-- Linke Spalte: Aktivitäten-Liste & Filter -->
      <div class="activities-list-pane">
        <div class="list-filters-header">
          <div class="sport-filter-chips">
            <button class="chip ${currentFilterSport === 'all' ? 'active' : ''}" data-sport="all">Alle (${allActivities.length})</button>
            <button class="chip ${currentFilterSport === 'Run' ? 'active' : ''}" data-sport="Run">🏃 Laufen</button>
            <button class="chip ${currentFilterSport === 'Ride' ? 'active' : ''}" data-sport="Ride">🚴 Rad</button>
            <button class="chip ${currentFilterSport === 'Swim' ? 'active' : ''}" data-sport="Swim">🏊 Schwimmen</button>
          </div>
          
          <input 
            type="text" 
            id="activity-search-input" 
            placeholder="Aktivität suchen..." 
            value="${currentSearchQuery}" 
            class="activity-search-box"
          />
        </div>

        <div class="activities-scrollable-list" id="activities-scroll-container">
          <!-- Wird per renderActivityListItems() befüllt -->
        </div>
      </div>

      <!-- Rechte Spalte: Detail- & Info-Panel mit Diagramm -->
      <div class="activity-detail-pane" id="activity-detail-container">
        <!-- Wird per renderActivityDetail() befüllt -->
      </div>

    </div>
  `;

  setupSyncToolbarListeners();
  setupFilterListeners();
  renderActivityListItems();
  renderSelectedActivityDetail();
}

/** Event-Listener für die Synchronisations-Leiste */
function setupSyncToolbarListeners() {
  const select = document.getElementById("sync-timeframe-select");
  const customBox = document.getElementById("custom-sync-inputs");
  const triggerBtn = document.getElementById("btn-sync-trigger");

  select?.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      customBox?.classList.remove("hidden");
    } else {
      customBox?.classList.add("hidden");
    }
  });

  triggerBtn?.addEventListener("click", () => {
    let days = 30;
    if (select.value === "custom") {
      const val = parseInt(document.getElementById("custom-sync-val")?.value, 10) || 30;
      const unit = document.getElementById("custom-sync-unit")?.value || "days";
      days = unit === "weeks" ? val * 7 : val;
    } else {
      days = parseInt(select.value, 10);
    }
    fetchAndDisplayActivities(days);
  });
}

/** Filter- und Suche-Listener einrichten */
function setupFilterListeners() {
  const chips = document.querySelectorAll(".sport-filter-chips .chip");
  chips.forEach((c) => {
    c.addEventListener("click", () => {
      chips.forEach(chip => chip.classList.remove("active"));
      c.classList.add("active");
      currentFilterSport = c.dataset.sport;
      applyFilters();
      renderActivityListItems();
    });
  });

  const searchInput = document.getElementById("activity-search-input");
  searchInput?.addEventListener("input", (e) => {
    currentSearchQuery = e.target.value.toLowerCase().trim();
    applyFilters();
    renderActivityListItems();
  });
}

/** Filter auf die Aktivitäten anwenden */
function applyFilters() {
  filteredActivities = allActivities.filter((a) => {
    const matchesSport = currentFilterSport === "all" || a.type === currentFilterSport;
    const matchesSearch = !currentSearchQuery || a.name.toLowerCase().includes(currentSearchQuery);
    return matchesSport && matchesSearch;
  });

  // Falls die aktuell ausgewählte Aktivität nicht mehr im Filter liegt, erste nehmen
  if (filteredActivities.length > 0 && !filteredActivities.some(a => a.id === selectedActivityId)) {
    selectedActivityId = filteredActivities[0].id;
  }
}

/** Rendert die scrollbare Liste der Aktivitäten in der linken Spalte */
function renderActivityListItems() {
  const container = document.getElementById("activities-scroll-container");
  if (!container) return;

  if (filteredActivities.length === 0) {
    container.innerHTML = `
      <div class="empty-list-notice">
        <span>🔍</span>
        <p>Keine Aktivitäten für die aktuellen Filter gefunden.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filteredActivities.map((a) => {
    const isSelected = a.id === selectedActivityId;
    const icon = getSportIcon(a.type);
    const dateStr = new Date(a.start_date_local).toLocaleDateString("de-DE", {
      day: "2-digit", month: "short", year: "numeric"
    });
    const distKm = (a.distance / 1000).toFixed(1);
    const durationMin = Math.round(a.moving_time / 60);

    return `
      <div class="activity-card-item ${isSelected ? 'selected' : ''}" data-id="${a.id}">
        <span class="item-icon">${icon}</span>
        <div class="item-content">
          <div class="item-name">${escapeHtml(a.name)}</div>
          <div class="item-meta">
            ${dateStr} &bull; ${durationMin} Min.
            ${a.total_elevation_gain ? `&bull; ↑ ${Math.round(a.total_elevation_gain)} hm` : ''}
          </div>
        </div>
        <div class="item-right">
          <div class="item-dist">${distKm} km</div>
          <span class="item-badge badge-${(a.type || 'other').toLowerCase()}">${a.type}</span>
        </div>
      </div>
    `;
  }).join("");

  // Klick-Handler für Selektion
  container.querySelectorAll(".activity-card-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = parseInt(el.dataset.id, 10);
      selectedActivityId = id;
      container.querySelectorAll(".activity-card-item").forEach(i => i.classList.remove("selected"));
      el.classList.add("selected");
      renderSelectedActivityDetail();
    });
  });
}

/** Rendert das Detail- & Infofeld für die ausgewählte Aktivität */
function renderSelectedActivityDetail() {
  const container = document.getElementById("activity-detail-container");
  if (!container) return;

  const activity = allActivities.find(a => a.id === selectedActivityId);
  if (!activity) {
    container.innerHTML = `
      <div class="detail-placeholder">
        <span style="font-size:3rem;">👈</span>
        <h3>Wähle eine Aktivität aus</h3>
        <p>Klicke links in der Liste auf eine Einheit, um erweiterte Details und Leistungsdiagramme anzuzeigen.</p>
      </div>
    `;
    return;
  }

  const icon = getSportIcon(activity.type);
  const dateObj = new Date(activity.start_date_local);
  const formattedDate = dateObj.toLocaleDateString("de-DE", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric"
  });
  const formattedTime = dateObj.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  const distKm = (activity.distance / 1000).toFixed(2);
  const movingTimeStr = formatSeconds(activity.moving_time);
  const elapsedTimeStr = formatSeconds(activity.elapsed_time);

  // Tempo / Pace berechnen
  const paceStr = calculatePace(activity.type, activity.distance, activity.moving_time);
  const maxSpeedKmH = (activity.max_speed * 3.6).toFixed(1);
  const avgSpeedKmH = (activity.average_speed * 3.6).toFixed(1);

  container.innerHTML = `
    <div class="detail-card">
      
      <!-- Detail Header -->
      <div class="detail-header">
        <div class="detail-title-group">
          <span class="detail-type-icon">${icon}</span>
          <div>
            <h2 class="detail-activity-name">${escapeHtml(activity.name)}</h2>
            <div class="detail-date-time">
              📅 ${formattedDate} um ${formattedTime} Uhr
            </div>
          </div>
        </div>
        
        <div class="detail-actions">
          <a href="https://www.strava.com/activities/${activity.id}" target="_blank" rel="noopener" class="btn btn-strava-link">
            Auf Strava ansehen ↗
          </a>
        </div>
      </div>

      <!-- Haupt-KPIs -->
      <div class="detail-kpis">
        <div class="detail-kpi-card">
          <div class="kpi-label">DISTANZ</div>
          <div class="kpi-val">${distKm} <span class="kpi-unit">km</span></div>
        </div>
        <div class="detail-kpi-card">
          <div class="kpi-label">BEWEGUNGSZEIT</div>
          <div class="kpi-val">${movingTimeStr}</div>
        </div>
        <div class="detail-kpi-card">
          <div class="kpi-label">Ø TEMPO / PACE</div>
          <div class="kpi-val">${paceStr}</div>
        </div>
        <div class="detail-kpi-card">
          <div class="kpi-label">HÖHENMETER</div>
          <div class="kpi-val">${Math.round(activity.total_elevation_gain || 0)} <span class="kpi-unit">↑ hm</span></div>
        </div>
      </div>

      <!-- Erweiterte Metriken -->
      <div class="detail-metrics-grid">
        <div class="metric-row">
          <span class="m-label">⏱️ Bruttozeit (Elapsed)</span>
          <span class="m-val">${elapsedTimeStr}</span>
        </div>
        <div class="metric-row">
          <span class="m-label">⚡ Max. Geschwindigkeit</span>
          <span class="m-val">${maxSpeedKmH} km/h</span>
        </div>
        <div class="metric-row">
          <span class="m-label">🚀 Ø Geschwindigkeit</span>
          <span class="m-val">${avgSpeedKmH} km/h</span>
        </div>
        <div class="metric-row">
          <span class="m-label">❤️ Ø Herzfrequenz</span>
          <span class="m-val">${activity.average_heartrate ? `${Math.round(activity.average_heartrate)} bpm` : '–'}</span>
        </div>
        <div class="metric-row">
          <span class="m-label">🔥 Max. Herzfrequenz</span>
          <span class="m-val">${activity.max_heartrate ? `${Math.round(activity.max_heartrate)} bpm` : '–'}</span>
        </div>
        <div class="metric-row">
          <span class="m-label">🔄 Tritt-/Schrittfrequenz</span>
          <span class="m-val">${activity.average_cadence ? `${Math.round(activity.average_cadence * (activity.type === 'Run' ? 2 : 1))} spm` : '–'}</span>
        </div>
        <div class="metric-row">
          <span class="m-label">⚡ Ø Leistung (Watt)</span>
          <span class="m-val">${activity.average_watts ? `${Math.round(activity.average_watts)} W` : '–'}</span>
        </div>
        <div class="metric-row">
          <span class="m-label">🍕 Kalorienverbrauch</span>
          <span class="m-val">${activity.calories ? `${Math.round(activity.calories)} kcal` : (activity.kilojoules ? `${Math.round(activity.kilojoules * 0.239)} kcal` : '–')}</span>
        </div>
      </div>

      <!-- Diagramm-Bereich für diese Aktivität -->
      <div class="detail-chart-section">
        <div class="detail-chart-title">
          <span>📈 Leistungs-Profil dieser Einheit</span>
          <span class="chart-subtitle">Verhältnis der Metriken zu deinen Einheiten</span>
        </div>
        <div class="detail-chart-wrapper">
          <canvas id="activity-detail-chart"></canvas>
        </div>
      </div>

    </div>
  `;

  renderActivityDetailChart(activity);
}

/** Erstellt ein Chart.js Diagramm für die spezifische Aktivität */
function renderActivityDetailChart(activity) {
  if (typeof Chart === "undefined") return;

  if (detailChartInstance) {
    detailChartInstance.destroy();
  }

  const ctx = document.getElementById("activity-detail-chart")?.getContext("2d");
  if (!ctx) return;

  // Ähnliche Aktivitäten desselben Typs für den Vergleich berechnen
  const sameTypeActs = allActivities.filter(a => a.type === activity.type);
  const avgDist = sameTypeActs.reduce((s, a) => s + a.distance, 0) / (sameTypeActs.length || 1) / 1000;
  const avgDuration = sameTypeActs.reduce((s, a) => s + a.moving_time, 0) / (sameTypeActs.length || 1) / 60;
  const avgElev = sameTypeActs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0) / (sameTypeActs.length || 1);

  const thisDist = activity.distance / 1000;
  const thisDuration = activity.moving_time / 60;
  const thisElev = activity.total_elevation_gain || 0;

  detailChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Distanz (km)", "Dauer (Min)", "Höhenmeter (hm)"],
      datasets: [
        {
          label: "Diese Aktivität",
          data: [Math.round(thisDist * 10) / 10, Math.round(thisDuration), Math.round(thisElev)],
          backgroundColor: "rgba(232, 57, 30, 0.85)",
          borderColor: "#e8391e",
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: `Dein Ø (${sameTypeActs.length} ${activity.type}-Einheiten)`,
          data: [Math.round(avgDist * 10) / 10, Math.round(avgDuration), Math.round(avgElev)],
          backgroundColor: "rgba(100, 116, 139, 0.5)",
          borderColor: "#64748b",
          borderWidth: 1,
          borderRadius: 4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#94a3b8", font: { family: "Inter", size: 11 } }
        },
        tooltip: {
          backgroundColor: "#111420",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "#252a40",
          borderWidth: 1,
          padding: 8,
        }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", font: { family: "Inter", size: 11 } },
          grid: { color: "rgba(37, 42, 64, 0.3)" }
        },
        y: {
          ticks: { color: "#94a3b8", font: { family: "Inter", size: 11 } },
          grid: { color: "rgba(37, 42, 64, 0.3)" }
        }
      }
    }
  });
}

// ── Hilfsfunktionen ────────────────────────────────────────
function getSportIcon(type) {
  const map = {
    Run: "🏃", Ride: "🚴", Swim: "🏊", Walk: "🚶",
    Hike: "🥾", Workout: "🏋️", VirtualRide: "🚴", VirtualRun: "🏃"
  };
  return map[type] || "🏅";
}

function calculatePace(type, distanceMeters, movingTimeSeconds) {
  if (!distanceMeters || !movingTimeSeconds) return "–";

  if (type === "Run") {
    // min/km
    const paceSeconds = movingTimeSeconds / (distanceMeters / 1000);
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.round(paceSeconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs} min/km`;
  } else if (type === "Swim") {
    // min/100m
    const paceSeconds = movingTimeSeconds / (distanceMeters / 100);
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.round(paceSeconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs} min/100m`;
  } else {
    // km/h
    const kmh = (distanceMeters / 1000) / (movingTimeSeconds / 3600);
    return `${kmh.toFixed(1)} km/h`;
  }
}

function formatSeconds(totalSeconds) {
  if (!totalSeconds) return "0:00";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")} h`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")} min`;
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function showConnectButton() {
  const container = document.getElementById("strava-content");
  if (!container) return;
  container.innerHTML = `
    <div class="strava-connect-card">
      <span class="connect-icon">🚴‍♂️</span>
      <h3>Verbinde deinen Strava-Account</h3>
      <p>Synchronisiere deine Trainingseinheiten automatisch für die Leistungsanalyse, den KI-Trainingsplan und den Team-Hub.</p>
      <button class="btn btn-strava" onclick="window.stravaConnect()">
        🚴 Mit Strava verbinden
      </button>
    </div>
  `;
}

function showStravaLoading(text = "Laden…") {
  const container = document.getElementById("strava-content");
  if (!container) return;
  container.innerHTML = `
    <div class="strava-loading-box">
      <div class="spinner"></div>
      <span>${text}</span>
    </div>
  `;
}

function renderStravaSkeleton() {
  const container = document.getElementById("strava-content");
  if (!container) return;
  container.innerHTML = `
    <div class="skeleton" style="height:70px; margin-bottom:1rem; border-radius:12px;"></div>
    <div class="skeleton" style="height:320px; border-radius:12px;"></div>
  `;
}

window.stravaConnect = connectToStrava;
window.stravaSync = () => fetchAndDisplayActivities(syncDaysSetting);

/** Gibt die aktuell geladenen Aktivitäten zurück */
export function getActivities() {
  return allActivities;
}

/** Gibt die aktuellen Strava-Tokens / Athleteninfos zurück */
export function getStravaTokens() {
  return stravaTokens;
}
