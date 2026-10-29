// ============================================================
// js/strava.js
// Strava OAuth 2.0 Flow, Aktivitäten-Abruf & Master-Detail Ansicht
// ============================================================

import { db } from "./firebase-config.js";
import { getSecrets } from "./config.js";
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";
import { publishUserStatsToHub } from "./hub.js";

// ── Strava-Konstanten ──────────────────────────────────────
const STRAVA_REDIRECT_URI = window.location.origin + window.location.pathname;
const STRAVA_SCOPE = "read,activity:read";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";

/** Gibt die Strava-Config mit Secrets zurück (nach loadSecrets()). */
function getStravaConfig() {
  const s = getSecrets();
  return {
    clientId: s.stravaClientId,
    clientSecret: s.stravaClientSecret,
    redirectUri: STRAVA_REDIRECT_URI,
    scope: STRAVA_SCOPE,
  };
}

// ── Zustand ────────────────────────────────────────────────
let currentUser = null;
let stravaTokens = null;
let allActivities = [];
let filteredActivities = [];
let selectedActivityId = null;
let currentFilterSport = "all";
let currentSearchQuery = "";
let syncDaysSetting = 30; // Standard: 30 Tage
let detailChartInstance = null;
const activitySpeedProfileCache = new Map(); // id -> Array<{ min: number, kmh: number | null, watts: number | null, hr: number | null }> | null

// ── Hilfsfunktion: Sortierung nach Datum (neueste zuerst) ──
/**
 * Extrahiert den Zeitstempel einer Aktivität zuverlässig (start_date_local bevorzugt).
 * @param {Object} a
 * @returns {number}
 */
export function parseActivityDate(a) {
  if (!a) return 0;
  const raw = a.start_date_local || a.start_date || a.date;
  if (!raw) return 0;
  if (typeof raw === "number") {
    return raw < 1e11 ? raw * 1000 : raw;
  }
  const t = new Date(raw).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Sortiert Aktivitäten absteigend nach Datum (neueste Aktivität zuerst).
 * @param {Array} activities
 * @returns {Array}
 */
export function sortActivitiesDesc(activities = []) {
  return [...activities].sort((a, b) => {
    const timeA = parseActivityDate(a);
    const timeB = parseActivityDate(b);
    return timeB - timeA;
  });
}

// ── Initialisierung ────────────────────────────────────────
export async function initStrava(user) {
  currentUser = user;
  renderStravaSkeleton();

  // Prüfe ob wir gerade vom Strava-OAuth-Callback kommen
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");

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
      allActivities = sortActivitiesDesc(cached);
      window.stravaActivities = allActivities;
      window.stravaTokens = stravaTokens;
      selectedActivityId = allActivities[0]?.id || null;
      renderActivitiesView();
      // Im Hintergrund Hub synchronisieren
      await publishUserStatsToHub(allActivities, stravaTokens);
      // KI-Vorschau im Trainingsplan aktualisieren
      window.updateAiPreview?.();
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
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: cfg.scope,
    state: "strava_oauth",
  });

  window.location.href = `https://www.strava.com/oauth/authorize?${params}`;
}

async function handleStravaCallback(code) {
  showStravaLoading("Verbinde mit Strava…");

  try {
    const cfg = getStravaConfig();
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) throw new Error(`Strava Token-Fehler: ${response.status}`);

    const data = await response.json();

    stravaTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      athleteId: data.athlete?.id,
      athleteName: data.athlete ? `${data.athlete.firstname} ${data.athlete.lastname}` : "Strava Athlet",
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
    const ref = doc(db, "users", currentUser.uid, "profile", "strava");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      stravaTokens = snap.data();
      window.stravaTokens = stravaTokens;
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
  const cfg = getStravaConfig();
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: stravaTokens.refreshToken,
    }),
  });

  if (!response.ok) throw new Error("Token-Refresh fehlgeschlagen");

  const data = await response.json();
  stravaTokens.accessToken = data.access_token;
  stravaTokens.refreshToken = data.refresh_token;
  stravaTokens.expiresAt = data.expires_at;

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

    allActivities = sortActivitiesDesc(fetched);
    window.stravaActivities = allActivities;
    window.stravaTokens = stravaTokens;
    if (allActivities.length > 0) {
      selectedActivityId = allActivities[0].id;
    }

    // In Firestore cachen
    await cacheActivities(allActivities);

    // Eigene Stats für den Hub aktualisieren
    await publishUserStatsToHub(allActivities, stravaTokens);

    showToast(`✅ ${allActivities.length} Aktivitäten synchronisiert!`, "success");
    renderActivitiesView();
    // KI-Vorschau im Trainingsplan aktualisieren
    window.updateAiPreview?.();

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
    data: activities,
    updatedAt: new Date().toISOString(),
    syncDays: syncDaysSetting,
  });
}

async function loadCachedActivities() {
  try {
    const ref = doc(db, "users", currentUser.uid, "cache", "activities");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data().data || [];
    }
  } catch (err) {
    console.error("Fehler beim Laden der Cache-Aktivitäten:", err);
  }
  return [];
}

// ── Sport-Typ Erkennung ────────────────────────────────────
export const isBike = (a) => ["Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide", "Handcycle"].includes(a?.type || a?.sport_type);
export const isRun = (a) => ["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(a?.type || a?.sport_type);
export const isSwim = (a) => ["Swim", "OpenWaterSwim"].includes(a?.type || a?.sport_type);

// ── Rendering der Aktivitäten-Ansicht (Master-Detail) ──────
export function renderActivitiesView() {
  const container = document.getElementById("strava-content");
  if (!container) return;

  // Filter anwenden
  applyFilters();

  const totalKm = allActivities.reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000;
  const totalHours = allActivities.reduce((s, a) => s + (parseFloat(a.moving_time) || 0), 0) / 3600;
  const totalCount = allActivities.length;

  const swimKm = allActivities.filter(isSwim).reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000;
  const bikeKm = allActivities.filter(isBike).reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000;
  const runKm = allActivities.filter(isRun).reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000;

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
            <option value="custom" ${![7, 14, 30, 60, 90, 180, 365].includes(syncDaysSetting) ? 'selected' : ''}>Benutzerdefiniert...</option>
          </select>

          <!-- Benutzerdefinierte Eingabe (falls 'custom') -->
          <div id="custom-sync-inputs" class="custom-inputs ${[7, 14, 30, 60, 90, 180, 365].includes(syncDaysSetting) ? 'hidden' : ''}">
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
  filteredActivities = sortActivitiesDesc(allActivities).filter((a) => {
    let matchesSport = currentFilterSport === "all";
    if (!matchesSport) {
      if (currentFilterSport === "Ride") {
        matchesSport = isBike(a);
      } else if (currentFilterSport === "Run") {
        matchesSport = isRun(a);
      } else if (currentFilterSport === "Swim") {
        matchesSport = isSwim(a);
      } else {
        matchesSport = (a.type === currentFilterSport || a.sport_type === currentFilterSport);
      }
    }
    const matchesSearch = !currentSearchQuery || (a.name || "").toLowerCase().includes(currentSearchQuery);
    return matchesSport && matchesSearch;
  });

  // Falls die aktuell ausgewählte Aktivität nicht mehr im Filter liegt, erste nehmen (neueste)
  if (filteredActivities.length > 0 && !filteredActivities.some(a => a.id === selectedActivityId)) {
    selectedActivityId = filteredActivities[0].id;
  }
}

/** Rendert die scrollbare Liste der Aktivitäten in der linken Spalte */
function renderActivityListItems() {
  const container = document.getElementById("activities-scroll-container");
  if (!container) return;

  const sortedList = sortActivitiesDesc(filteredActivities);

  if (sortedList.length === 0) {
    container.innerHTML = `
      <div class="empty-list-notice">
        <span>🔍</span>
        <p>Keine Aktivitäten für die aktuellen Filter gefunden.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = sortedList.map((a) => {
    const isSelected = a.id === selectedActivityId;
    const icon = getSportIcon(a.type);
    const dateStr = new Date(a.start_date_local).toLocaleDateString("de-DE", {
      day: "2-digit", month: "short", year: "numeric"
    });
    const distKm = (a.distance / 1000).toFixed(1);
    const durationMin = Math.round(a.moving_time / 60);
    const badgeClass = isBike(a) ? "badge-ride" : (isRun(a) ? "badge-run" : (isSwim(a) ? "badge-swim" : "badge-other"));
    const badgeText = a.type === "VirtualRide" ? "VirtualRide" : (a.type || "Other");

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
          <span class="item-badge ${badgeClass}">${badgeText}</span>
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
          <span id="activity-chart-main-title">📈 ${isBike(activity) ? 'Leistungs- &amp; Herzfrequenzverlauf' : 'Geschwindigkeits- &amp; Herzfrequenzverlauf'} dieser Einheit</span>
          <span class="chart-subtitle" id="activity-chart-subtitle">Verlauf über die Dauer &amp; Vergleich mit gleichen Einheiten</span>
        </div>
        <div class="detail-chart-wrapper">
          <canvas id="activity-detail-chart"></canvas>
        </div>
      </div>

    </div>
  `;

  renderActivityDetailChart(activity);
}

/**
 * Berechnet die durchschnittliche Geschwindigkeit einer Aktivität in km/h.
 */
function getActivityAvgKmh(a) {
  if (!a) return 0;
  if (typeof a.average_speed === "number" && a.average_speed > 0) {
    return a.average_speed * 3.6;
  }
  const distKm = (parseFloat(a.distance) || 0) / 1000;
  const hours = (parseFloat(a.moving_time) || parseFloat(a.elapsed_time) || 0) / 3600;
  return hours > 0 ? distKm / hours : 0;
}

/**
 * Gibt die durchschnittliche Leistung (Watt) einer Aktivität zurück (oder null, falls keine Daten).
 */
function getActivityAvgWatts(a) {
  if (!a) return null;
  const w = parseFloat(a.average_watts ?? a.weighted_average_watts);
  return !isNaN(w) && w > 0 ? w : null;
}

/**
 * Gibt die durchschnittliche Herzfrequenz (bpm) einer Aktivität zurück (oder null, falls keine Daten).
 */
function getActivityAvgHr(a) {
  if (!a) return null;
  const hr = parseFloat(a.average_heartrate);
  return !isNaN(hr) && hr > 0 ? hr : null;
}

/**
 * Extrahiert ein Zeit-Profil (Array aus { min, kmh, watts, hr }) aus Stream-, Split- oder Lap-Daten.
 * Gibt null zurück, falls nur die Durchschnittswerte vorliegen.
 */
function extractProfileFromData(activity, streamsData = null, detailData = null) {
  // 1. Aus Streams (time + velocity_smooth / distance / watts / heartrate)
  const timeStream = streamsData?.time?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "time")?.data : null);
  const velStream = streamsData?.velocity_smooth?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "velocity_smooth")?.data : null);
  const distStream = streamsData?.distance?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "distance")?.data : null);
  const wattsStream = streamsData?.watts?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "watts")?.data : null);
  const hrStream = streamsData?.heartrate?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "heartrate")?.data : null);

  const hasAnyMetricStream = Array.isArray(velStream) || Array.isArray(distStream) || Array.isArray(wattsStream) || Array.isArray(hrStream);

  if (Array.isArray(timeStream) && timeStream.length > 1 && hasAnyMetricStream) {
    const rawPoints = [];
    for (let i = 0; i < timeStream.length; i++) {
      const tMin = (timeStream[i] || 0) / 60;
      let kmh = null;
      if (Array.isArray(velStream) && velStream[i] != null) {
        kmh = Math.max(0, velStream[i] * 3.6);
      } else if (Array.isArray(distStream) && i > 0) {
        const dt = timeStream[i] - timeStream[i - 1];
        const dd = distStream[i] - distStream[i - 1];
        kmh = dt > 0 ? Math.max(0, (dd / dt) * 3.6) : 0;
      } else if (Array.isArray(distStream) && i === 0) {
        kmh = 0;
      }

      const watts = Array.isArray(wattsStream) && wattsStream[i] != null ? Math.max(0, parseFloat(wattsStream[i])) : null;
      const hr = Array.isArray(hrStream) && hrStream[i] != null && hrStream[i] > 0 ? parseFloat(hrStream[i]) : null;

      rawPoints.push({ min: tMin, kmh, watts, hr });
    }

    const avgBucketField = (arr, startIdx, endIdx, field) => {
      let sum = 0;
      let count = 0;
      for (let j = startIdx; j < endIdx; j++) {
        const v = arr[j][field];
        if (typeof v === "number" && !isNaN(v)) {
          sum += v;
          count++;
        }
      }
      return count > 0 ? Math.round((sum / count) * 100) / 100 : null;
    };

    // Auf ca. 40 Stützpunkte glätten / herunterbrechen für saubere Darstellung
    const targetBuckets = 40;
    if (rawPoints.length <= targetBuckets) {
      return rawPoints.map(p => ({
        min: Math.round(p.min * 10) / 10,
        kmh: p.kmh != null ? Math.round(p.kmh * 100) / 100 : null,
        watts: p.watts != null ? Math.round(p.watts * 10) / 10 : null,
        hr: p.hr != null ? Math.round(p.hr * 10) / 10 : null,
      }));
    }
    const step = rawPoints.length / targetBuckets;
    const sampled = [];
    for (let b = 0; b < targetBuckets; b++) {
      const startIdx = Math.floor(b * step);
      const endIdx = Math.min(rawPoints.length, Math.floor((b + 1) * step));
      if (endIdx <= startIdx) continue;
      const midMin = rawPoints[Math.floor((startIdx + endIdx - 1) / 2)].min;
      sampled.push({
        min: Math.round(midMin * 10) / 10,
        kmh: avgBucketField(rawPoints, startIdx, endIdx, "kmh"),
        watts: avgBucketField(rawPoints, startIdx, endIdx, "watts"),
        hr: avgBucketField(rawPoints, startIdx, endIdx, "hr"),
      });
    }
    // Startpunkt bei 0 Min ergänzen, falls nötig
    if (sampled.length > 0 && sampled[0].min > 0) {
      sampled.unshift({
        min: 0,
        kmh: sampled[0].kmh,
        watts: sampled[0].watts,
        hr: sampled[0].hr,
      });
    }
    return sampled;
  }

  // 2. Aus Splits oder Laps (falls vorhanden; Laps enthalten oft auch average_watts und average_heartrate)
  const splits = (Array.isArray(detailData?.laps) && detailData.laps.length > 1 ? detailData.laps : null)
    || (Array.isArray(detailData?.splits_metric) && detailData.splits_metric.length > 1 ? detailData.splits_metric : null)
    || (Array.isArray(activity?.laps) && activity.laps.length > 1 ? activity.laps : null)
    || (Array.isArray(activity?.splits_metric) && activity.splits_metric.length > 1 ? activity.splits_metric : null);

  if (Array.isArray(splits) && splits.length > 1) {
    const points = [];
    let cumSec = 0;
    splits.forEach((s, idx) => {
      const dur = parseFloat(s.moving_time) || parseFloat(s.elapsed_time) || 0;
      const spd = typeof s.average_speed === "number" && s.average_speed > 0
        ? s.average_speed * 3.6
        : (dur > 0 ? ((parseFloat(s.distance) || 0) / dur) * 3.6 : 0);
      const w = s.average_watts != null && !isNaN(parseFloat(s.average_watts)) ? Math.round(parseFloat(s.average_watts) * 10) / 10 : null;
      const hr = s.average_heartrate != null && !isNaN(parseFloat(s.average_heartrate)) && parseFloat(s.average_heartrate) > 0
        ? Math.round(parseFloat(s.average_heartrate) * 10) / 10
        : null;

      if (idx === 0) {
        points.push({ min: 0, kmh: Math.round(spd * 100) / 100, watts: w, hr });
      }
      cumSec += dur;
      points.push({ min: Math.round((cumSec / 60) * 10) / 10, kmh: Math.round(spd * 100) / 100, watts: w, hr });
    });
    if (points.length > 1) return points;
  }

  return null;
}

/**
 * Versucht für eine Aktivität echte Verlaufsdaten (Streams oder Splits/Laps) von Strava zu laden und zu cachen.
 */
async function fetchActivitySpeedProfile(activity) {
  if (!activity?.id) return null;
  if (activitySpeedProfileCache.has(activity.id)) {
    return activitySpeedProfileCache.get(activity.id);
  }

  // Prüfen ob bereits im Objekt selbst Splits/Laps vorhanden sind
  const localProfile = extractProfileFromData(activity);
  if (localProfile) {
    activitySpeedProfileCache.set(activity.id, localProfile);
    return localProfile;
  }

  if (!stravaTokens?.accessToken) {
    activitySpeedProfileCache.set(activity.id, null);
    return null;
  }

  try {
    const token = await getValidAccessToken();
    // 1. Versuch: Strava Streams API (time, velocity_smooth, distance, watts, heartrate)
    const streamUrl = `${STRAVA_API_BASE}/activities/${activity.id}/streams?keys=time,velocity_smooth,distance,watts,heartrate&key_by_type=true`;
    const res = await fetch(streamUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.ok) {
      const streamsData = await res.json();
      const profile = extractProfileFromData(activity, streamsData, null);
      if (profile && profile.length > 1) {
        activitySpeedProfileCache.set(activity.id, profile);
        return profile;
      }
    }

    // 2. Versuch: Einzelne Aktivität abrufen für laps / splits_metric
    const detailUrl = `${STRAVA_API_BASE}/activities/${activity.id}`;
    const detailRes = await fetch(detailUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (detailRes.ok) {
      const detailData = await detailRes.json();
      const profile = extractProfileFromData(activity, null, detailData);
      if (profile && profile.length > 1) {
        activitySpeedProfileCache.set(activity.id, profile);
        return profile;
      }
    }
  } catch (err) {
    console.warn("[strava] Konnte Detail-Verlauf nicht laden, nutze Durchschnittsgerade:", err);
  }

  activitySpeedProfileCache.set(activity.id, null);
  return null;
}

/**
 * Interpoliert einen Messwert (field: 'kmh' | 'watts' | 'hr') an einem Zeitpunkt tMin aus einem Profil.
 */
function interpolateFieldAtMinute(profile, tMin, field, fallbackVal = null) {
  if (!Array.isArray(profile) || profile.length === 0) return fallbackVal;
  const validPoints = profile.filter(p => typeof p[field] === "number" && !isNaN(p[field]));
  if (validPoints.length === 0) return fallbackVal;

  if (tMin <= validPoints[0].min) return validPoints[0][field];
  const last = validPoints[validPoints.length - 1];
  if (tMin >= last.min) return last[field];

  for (let i = 0; i < validPoints.length - 1; i++) {
    const p0 = validPoints[i];
    const p1 = validPoints[i + 1];
    if (tMin >= p0.min && tMin <= p1.min) {
      const span = p1.min - p0.min;
      if (span <= 0) return p0[field];
      const ratio = (tMin - p0.min) / span;
      return p0[field] + ratio * (p1[field] - p0[field]);
    }
  }
  return fallbackVal;
}

/** Erstellt ein Chart.js Liniendiagramm für Geschwindigkeit/Watt sowie Herzfrequenz über die Dauer */
async function renderActivityDetailChart(activity) {
  if (typeof Chart === "undefined" || !activity) return;

  const subtitleEl = document.getElementById("activity-chart-subtitle");

  // Ähnliche Aktivitäten derselben Sportart finden
  const sameTypeActs = allActivities.filter(a => {
    if (isBike(activity)) return isBike(a);
    if (isRun(activity)) return isRun(a);
    if (isSwim(activity)) return isSwim(a);
    return a.type === activity.type;
  });
  const typeLabel = isBike(activity) ? "Rad" : (isRun(activity) ? "Lauf" : (isSwim(activity) ? "Schwimm" : (activity.type || "Sport")));

  const durationMin = Math.max(1, Math.round((parseFloat(activity.moving_time) || parseFloat(activity.elapsed_time) || 60) / 60));

  // Zeichne zuerst sofort mit den bereits bekannten Daten (oder Horizontallinie),
  // und aktualisiere, falls der Stream-Request echte Verlaufsdaten liefert.
  const cachedProfile = activitySpeedProfileCache.get(activity.id) || null;
  drawActivityProfileChart(activity, cachedProfile, sameTypeActs, typeLabel, durationMin, subtitleEl);

  if (!activitySpeedProfileCache.has(activity.id)) {
    const fetchedProfile = await fetchActivitySpeedProfile(activity);
    // Prüfen, ob der Nutzer noch auf derselben Aktivität ist
    if (selectedActivityId === activity.id && fetchedProfile) {
      drawActivityProfileChart(activity, fetchedProfile, sameTypeActs, typeLabel, durationMin, subtitleEl);
    }
  }
}

function drawActivityProfileChart(activity, profile, sameTypeActs, typeLabel, durationMin, subtitleEl) {
  if (detailChartInstance) {
    detailChartInstance.destroy();
  }

  const ctx = document.getElementById("activity-detail-chart")?.getContext("2d");
  if (!ctx) return;

  const bikeMode = isBike(activity);
  const primaryField = bikeMode ? "watts" : "kmh";
  const primaryUnit = bikeMode ? "W" : "km/h";
  const primaryLabelShort = bikeMode ? "Leistung" : "Geschwindigkeit";

  const hasDetailedPrimary = Array.isArray(profile) && profile.filter(p => typeof p[primaryField] === "number").length > 1;
  const hasDetailedHr = Array.isArray(profile) && profile.filter(p => typeof p.hr === "number" && p.hr > 0).length > 1;

  // Stützstellen auf der Zeitachse (0 bis Dauer der Aktivität) erzeugen
  let timePointsMin = [];
  if (Array.isArray(profile) && profile.length > 1) {
    timePointsMin = profile.map(p => p.min);
  } else {
    const steps = Math.min(30, Math.max(10, durationMin));
    for (let i = 0; i <= steps; i++) {
      timePointsMin.push(Math.round(((i / steps) * durationMin) * 10) / 10);
    }
  }

  // ── 1. Primäre Metrik (Watt für Rad, km/h für andere Sportarten) ──
  const thisPrimaryAvg = bikeMode ? (getActivityAvgWatts(activity) ?? 0) : getActivityAvgKmh(activity);
  const hasThisPrimaryData = bikeMode ? (hasDetailedPrimary || getActivityAvgWatts(activity) != null) : true;

  const thisPrimarySeries = hasThisPrimaryData
    ? timePointsMin.map(tMin => {
        const val = hasDetailedPrimary
          ? interpolateFieldAtMinute(profile, tMin, primaryField, thisPrimaryAvg)
          : thisPrimaryAvg;
        return Math.round((val ?? 0) * (bikeMode ? 1 : 100)) / (bikeMode ? 1 : 100);
      })
    : [];

  // Vergleichsgruppe für die primäre Metrik (bei Rad nur Aktivitäten mit Watt-Daten heranziehen)
  const primaryPeers = bikeMode
    ? sameTypeActs.filter(a => {
        const prof = activitySpeedProfileCache.get(a.id);
        const hasProfW = Array.isArray(prof) && prof.some(p => typeof p.watts === "number");
        return hasProfW || getActivityAvgWatts(a) != null;
      })
    : sameTypeActs;

  const overallPeerPrimaryAvg = primaryPeers.length > 0
    ? primaryPeers.reduce((sum, a) => sum + (bikeMode ? (getActivityAvgWatts(a) || 0) : getActivityAvgKmh(a)), 0) / primaryPeers.length
    : thisPrimaryAvg;

  const peerPrimarySeries = primaryPeers.length > 0
    ? timePointsMin.map(tMin => {
        const activeAtTime = primaryPeers.filter(a => {
          const aDurMin = (parseFloat(a.moving_time) || parseFloat(a.elapsed_time) || 0) / 60;
          return aDurMin >= tMin;
        });
        const pool = activeAtTime.length > 0 ? activeAtTime : primaryPeers;
        const sumVal = pool.reduce((sum, a) => {
          const prof = activitySpeedProfileCache.get(a.id);
          const aAvg = bikeMode ? (getActivityAvgWatts(a) || 0) : getActivityAvgKmh(a);
          const val = (Array.isArray(prof) && prof.length > 1)
            ? interpolateFieldAtMinute(prof, tMin, primaryField, aAvg)
            : aAvg;
          return sum + (val ?? aAvg);
        }, 0);
        const avg = sumVal / pool.length;
        return Math.round(avg * (bikeMode ? 1 : 100)) / (bikeMode ? 1 : 100);
      })
    : [];

  // ── 2. Herzfrequenz-Metrik (sofern Daten vorhanden) ──
  const thisAvgHr = getActivityAvgHr(activity);
  const hasThisHr = hasDetailedHr || thisAvgHr != null;

  const thisHrSeries = hasThisHr
    ? timePointsMin.map(tMin => {
        const val = hasDetailedHr
          ? interpolateFieldAtMinute(profile, tMin, "hr", thisAvgHr)
          : thisAvgHr;
        return val != null ? Math.round(val) : null;
      })
    : [];

  const hrPeers = sameTypeActs.filter(a => {
    const prof = activitySpeedProfileCache.get(a.id);
    const hasProfHr = Array.isArray(prof) && prof.some(p => typeof p.hr === "number" && p.hr > 0);
    return hasProfHr || getActivityAvgHr(a) != null;
  });

  const hasPeerHr = hrPeers.length > 0;
  const peerHrSeries = hasPeerHr
    ? timePointsMin.map(tMin => {
        const activeAtTime = hrPeers.filter(a => {
          const aDurMin = (parseFloat(a.moving_time) || parseFloat(a.elapsed_time) || 0) / 60;
          return aDurMin >= tMin;
        });
        const pool = activeAtTime.length > 0 ? activeAtTime : hrPeers;
        const sumHr = pool.reduce((sum, a) => {
          const prof = activitySpeedProfileCache.get(a.id);
          const aAvg = getActivityAvgHr(a) || 0;
          const val = (Array.isArray(prof) && prof.length > 1)
            ? interpolateFieldAtMinute(prof, tMin, "hr", aAvg)
            : aAvg;
          return sum + (val ?? aAvg);
        }, 0);
        return Math.round(sumHr / pool.length);
      })
    : [];

  const showHrAxis = hasThisHr || hasPeerHr;

  // Untertitel aktualisieren
  if (subtitleEl) {
    const primaryDesc = bikeMode
      ? (hasDetailedPrimary
          ? `Watt-Verlauf über ${durationMin} Min.`
          : (hasThisPrimaryData ? `Ø Leistung (${Math.round(thisPrimaryAvg)} W, Gerade)` : `Keine Watt-Daten dieser Einheit`))
      : (hasDetailedPrimary
          ? `Geschwindigkeitsverlauf über ${durationMin} Min.`
          : `Ø Geschwindigkeit (${thisPrimaryAvg.toFixed(1)} km/h, Gerade)`);
    const hrDesc = showHrAxis ? ` • inkl. ❤️ Herzfrequenz` : "";
    subtitleEl.textContent = `${primaryDesc} vs. Ø aus ${sameTypeActs.length} ${typeLabel}-Einheiten${hrDesc}`;
  }

  const labels = timePointsMin.map(m => `${Math.round(m)} Min.`);
  const datasets = [];

  // Dataset 1: Primärer Verlauf dieser Einheit (Watt oder km/h)
  if (hasThisPrimaryData) {
    datasets.push({
      label: hasDetailedPrimary
        ? `${primaryLabelShort} dieser Einheit (${primaryUnit})`
        : `Ø ${primaryLabelShort} dieser Einheit (${bikeMode ? Math.round(thisPrimaryAvg) : thisPrimaryAvg.toFixed(1)} ${primaryUnit})`,
      data: thisPrimarySeries,
      yAxisID: "y",
      borderColor: "#e8391e",
      backgroundColor: "rgba(232, 57, 30, 0.14)",
      borderWidth: 2.5,
      pointRadius: hasDetailedPrimary ? 2 : 0,
      pointHoverRadius: 5,
      tension: hasDetailedPrimary ? 0.3 : 0,
      fill: true,
      unit: primaryUnit,
    });
  }

  // Dataset 2: Graue Durchschnittslinie der primären Metrik (Watt oder km/h)
  if (peerPrimarySeries.length > 0) {
    datasets.push({
      label: `Ø ${primaryLabelShort} (${primaryPeers.length} ${typeLabel}-Einheiten)`,
      data: peerPrimarySeries,
      yAxisID: "y",
      borderColor: "#64748b",
      backgroundColor: "rgba(100, 116, 139, 0.1)",
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
      fill: false,
      unit: primaryUnit,
    });
  }

  // Dataset 3: Herzfrequenz dieser Einheit (falls vorhanden)
  if (hasThisHr) {
    datasets.push({
      label: hasDetailedHr
        ? "❤️ Herzfrequenz dieser Einheit (bpm)"
        : `❤️ Ø Herzfrequenz dieser Einheit (${Math.round(thisAvgHr)} bpm)`,
      data: thisHrSeries,
      yAxisID: "yHr",
      borderColor: "#ec4899",
      backgroundColor: "rgba(236, 72, 153, 0.08)",
      borderWidth: 2,
      pointRadius: hasDetailedHr ? 1.5 : 0,
      pointHoverRadius: 4,
      tension: hasDetailedHr ? 0.3 : 0,
      fill: false,
      unit: "bpm",
    });
  }

  // Dataset 4: Durchschnittliche Herzfrequenz gleicher Einheiten im Zeitverlauf (falls vorhanden)
  if (hasPeerHr) {
    datasets.push({
      label: `❤️ Ø Herzfrequenz (${hrPeers.length} ${typeLabel}-Einheiten)`,
      data: peerHrSeries,
      yAxisID: "yHr",
      borderColor: "rgba(148, 163, 184, 0.75)",
      backgroundColor: "transparent",
      borderWidth: 1.75,
      borderDash: [3, 3],
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
      fill: false,
      unit: "bpm",
    });
  }

  const allPrimaryVals = [...thisPrimarySeries, ...peerPrimarySeries].filter(v => typeof v === "number" && !isNaN(v));
  const minPrimary = allPrimaryVals.length > 0 ? Math.min(...allPrimaryVals) : 0;
  const maxPrimary = allPrimaryVals.length > 0 ? Math.max(...allPrimaryVals) : 100;

  const allHrVals = [...thisHrSeries, ...peerHrSeries].filter(v => typeof v === "number" && !isNaN(v));
  const minHr = allHrVals.length > 0 ? Math.min(...allHrVals) : 60;
  const maxHr = allHrVals.length > 0 ? Math.max(...allHrVals) : 190;

  const scales = {
    x: {
      title: {
        display: true,
        text: "Dauer (Minuten)",
        color: "#64748b",
        font: { family: "Inter", size: 11 }
      },
      ticks: {
        color: "#94a3b8",
        font: { family: "Inter", size: 11 },
        maxTicksLimit: 10
      },
      grid: { color: "rgba(37, 42, 64, 0.3)" }
    },
    y: {
      type: "linear",
      position: "left",
      display: allPrimaryVals.length > 0,
      title: {
        display: true,
        text: bikeMode ? "Leistung (Watt)" : "Geschwindigkeit (km/h)",
        color: "#e8391e",
        font: { family: "Inter", size: 11, weight: "600" }
      },
      beginAtZero: false,
      suggestedMin: Math.max(0, Math.floor(minPrimary * 0.85)),
      suggestedMax: Math.ceil(maxPrimary * 1.1),
      ticks: {
        color: "#94a3b8",
        font: { family: "Inter", size: 11 },
        callback: (v) => `${v} ${primaryUnit}`
      },
      grid: { color: "rgba(37, 42, 64, 0.3)" }
    }
  };

  if (showHrAxis) {
    scales.yHr = {
      type: "linear",
      position: "right",
      display: true,
      title: {
        display: true,
        text: "Herzfrequenz (bpm)",
        color: "#ec4899",
        font: { family: "Inter", size: 11, weight: "600" }
      },
      beginAtZero: false,
      suggestedMin: Math.max(40, Math.floor(minHr - 10)),
      suggestedMax: Math.ceil(maxHr + 10),
      ticks: {
        color: "#f472b6",
        font: { family: "Inter", size: 11 },
        callback: (v) => `${Math.round(v)} bpm`
      },
      grid: {
        drawOnChartArea: allPrimaryVals.length === 0,
        color: "rgba(37, 42, 64, 0.3)"
      }
    };
  }

  detailChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
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
          callbacks: {
            label: (context) => {
              const unit = context.dataset.unit || primaryUnit;
              const rawVal = context.parsed?.y;
              if (typeof rawVal !== "number") return `${context.dataset.label}: ${context.formattedValue}`;
              const formatted = (unit === "W" || unit === "bpm") ? Math.round(rawVal) : rawVal.toFixed(1);
              return `${context.dataset.label}: ${formatted} ${unit}`;
            }
          }
        }
      },
      scales
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

  if (["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(type)) {
    // min/km
    const paceSeconds = movingTimeSeconds / (distanceMeters / 1000);
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.round(paceSeconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs} min/km`;
  } else if (["Swim", "OpenWaterSwim"].includes(type)) {
    // min/100m
    const paceSeconds = movingTimeSeconds / (distanceMeters / 100);
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.round(paceSeconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs} min/100m`;
  } else {
    // km/h (Ride, VirtualRide, etc.)
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
