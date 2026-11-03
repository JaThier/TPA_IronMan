// ============================================================
// js/strava.js
// Strava OAuth 2.0 Flow, Aktivitäten-Abruf & Master-Detail Ansicht
// ============================================================

import { auth, db } from "./firebase-config.js";
import { getSecrets } from "./config.js";
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";
import { publishUserStatsToHub } from "./hub.js?v=2.8";

// ── Strava-Konstanten ──────────────────────────────────────
const STRAVA_REDIRECT_URI = window.location.origin + window.location.pathname;
const STRAVA_SCOPE = "read,activity:read";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
export const DAILY_AUTO_SYNC_DAYS = 180; // 6 Monate (180 Tage)

/** Liefert das heutige Datum als YYYY-MM-DD Schlüssel (lokale Zeitzone) */
export function getTodayDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
let syncDaysSetting = DAILY_AUTO_SYNC_DAYS; // Standard: 6 Monate (180 Tage)
let detailChartInstance = null;
let dailySyncIntervalId = null;
let tokenRefreshPromise = null;
const activitySpeedProfileCache = new Map(); // numId -> Array<{ min: number, kmh: number | null, watts: number | null, hr: number | null }>
const inFlightProfilePromises = new Map();   // numId -> Promise<Array | null>
const noStreamActivityIds = new Set();       // numId -> Aktivitäten, für die Strava nachweislich keine Stream-/Split-Daten hat

// ── Zustand für den Reiter "Analyse" (Mehrfachauswahl) ─────
const selectedAnalysisIds = new Set();
let analysisInitialized = false;
let analysisFilterSport = "all";
let analysisSearchQuery = "";
let analysisFilteredActivities = [];
let analysisChartInstance = null;
let analysisChartRenderToken = 0;
let analysisSpeedUnitOverride = null; // null = Auto (min/km wenn nur Läufe ausgewählt, sonst km/h), "kmh" | "pace"

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
    // Vorhandene gecachte Aktivitäten inkl. Metadaten laden
    const cachedMeta = await loadCachedActivitiesMeta();
    const cached = cachedMeta.data || [];
    const todayKey = getTodayDateKey();
    const isDailySyncDue =
      cachedMeta.lastDailySyncDate !== todayKey ||
      (cachedMeta.syncDays || 0) < DAILY_AUTO_SYNC_DAYS ||
      cached.length === 0;

    if (cached.length > 0) {
      allActivities = sortActivitiesDesc(cached);
      window.stravaActivities = allActivities;
      window.stravaTokens = stravaTokens;
      selectedActivityId = allActivities[0]?.id || null;
      renderActivitiesView();
      renderAnalysisView();
      // Im Hintergrund Hub synchronisieren (nur als heute frisch synchronisiert markieren, wenn bereits erledigt)
      await publishUserStatsToHub(allActivities, stravaTokens, { markDailySynced: !isDailySyncDue });
      // KI-Vorschau im Trainingsplan aktualisieren
      window.updateAiPreview?.();

      // Falls heute noch kein automatischer 6-Monate-Sync stattfand, im Hintergrund nachholen
      if (isDailySyncDue) {
        console.log(`[strava] Täglicher Auto-Sync (${DAILY_AUTO_SYNC_DAYS} Tage / 6 Monate) wird im Hintergrund ausgeführt…`);
        await fetchAndDisplayActivities(DAILY_AUTO_SYNC_DAYS, { silentLoading: true, isAutoDailySync: true });
      }
    } else {
      await fetchAndDisplayActivities(DAILY_AUTO_SYNC_DAYS, { isAutoDailySync: true });
    }

    startDailyAutoSyncTimer();
  } else {
    showConnectButton();
  }
}

/**
 * Prüft regelmäßig im Hintergrund (während die App geöffnet bleibt),
 * ob ein neuer Kalendertag angebrochen ist und stößt einmal täglich den 6-Monate-Sync an.
 */
function startDailyAutoSyncTimer() {
  if (dailySyncIntervalId) clearInterval(dailySyncIntervalId);
  dailySyncIntervalId = setInterval(async () => {
    if (!currentUser || !stravaTokens?.accessToken) return;
    const cachedMeta = await loadCachedActivitiesMeta();
    const todayKey = getTodayDateKey();
    if (cachedMeta.lastDailySyncDate !== todayKey || (cachedMeta.syncDays || 0) < DAILY_AUTO_SYNC_DAYS) {
      console.log("[strava] Neuer Tag erkannt – starte automatischen täglichen 6-Monate-Sync…");
      await fetchAndDisplayActivities(DAILY_AUTO_SYNC_DAYS, { silentLoading: true, isAutoDailySync: true });
      window.refreshHub?.();
    }
  }, 30 * 60 * 1000); // Alle 30 Minuten prüfen
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
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return;
  currentUser = user;
  try {
    const ref = doc(db, "users", user.uid, "profile", "strava");
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
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return;
  const ref = doc(db, "users", user.uid, "profile", "strava");
  await setDoc(ref, tokens);
}

async function getValidAccessToken() {
  if (!stravaTokens?.accessToken && (currentUser || auth?.currentUser)) {
    await loadStravaTokens();
  }
  if (!stravaTokens?.accessToken && !stravaTokens?.refreshToken) {
    throw new Error("Keine Strava-Tokens verfügbar");
  }

  const now = Math.floor(Date.now() / 1000);

  if (stravaTokens.accessToken && (stravaTokens.expiresAt || 0) > now + 300) {
    return stravaTokens.accessToken;
  }

  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
    try {
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
      stravaTokens.refreshToken = data.refresh_token || stravaTokens.refreshToken;
      stravaTokens.expiresAt = data.expires_at;
      window.stravaTokens = stravaTokens;

      await saveStravaTokens(stravaTokens);
      return stravaTokens.accessToken;
    } finally {
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
}

/**
 * Erneuert bei Bedarf ein übergebenes Strava-Token-Objekt und lädt die Aktivitäten
 * der letzten `days` Tage von der Strava API (wird sowohl für den eigenen Account als auch
 * für den täglichen Team-Auto-Sync im Hub genutzt).
 * @param {Object} tokenObj
 * @param {number} days
 * @returns {Promise<{ activities: Array, tokens: Object, tokenRefreshed: boolean }>}
 */
export async function fetchStravaActivitiesWithTokens(tokenObj, days = DAILY_AUTO_SYNC_DAYS) {
  if (!tokenObj || (!tokenObj.accessToken && !tokenObj.refreshToken)) {
    throw new Error("Keine gültigen Strava-Tokens vorhanden");
  }

  const updatedTokens = { ...tokenObj };
  let tokenRefreshed = false;
  const now = Math.floor(Date.now() / 1000);

  if (!updatedTokens.accessToken || (updatedTokens.expiresAt || 0) <= now + 300) {
    if (!updatedTokens.refreshToken) {
      throw new Error("Strava Refresh-Token fehlt");
    }
    const cfg = getStravaConfig();
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: updatedTokens.refreshToken,
      }),
    });

    if (!response.ok) throw new Error(`Strava Token-Refresh fehlgeschlagen (${response.status})`);
    const data = await response.json();
    updatedTokens.accessToken = data.access_token;
    updatedTokens.refreshToken = data.refresh_token || updatedTokens.refreshToken;
    updatedTokens.expiresAt = data.expires_at;
    tokenRefreshed = true;
  }

  const afterEpoch = Math.floor(Date.now() / 1000) - (days * 24 * 3600);
  let fetched = [];
  let page = 1;
  let hasMore = true;

  // Paginierung: Bis zu 5 Seiten à 100 Aktivitäten (500 Einheiten) für volle 6 Monate Abdeckung
  while (hasMore && page <= 5) {
    const url = `${STRAVA_API_BASE}/athlete/activities?after=${afterEpoch}&per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${updatedTokens.accessToken}` }
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

  return {
    activities: sortActivitiesDesc(fetched),
    tokens: updatedTokens,
    tokenRefreshed,
  };
}

// ── Aktivitäten abrufen mit konfigurierbarem Zeitraum ──────
/**
 * Ruft Aktivitäten von Strava ab, die nicht älter als `days` Tage sind.
 * @param {number} days Anzahl Tage in die Vergangenheit
 * @param {Object} options Optionale Flags ({ silentLoading, isAutoDailySync })
 */
export async function fetchAndDisplayActivities(days = syncDaysSetting, options = {}) {
  syncDaysSetting = parseInt(days, 10) || DAILY_AUTO_SYNC_DAYS;
  const { silentLoading = false, isAutoDailySync = false } = options;

  if (!silentLoading) {
    showStravaLoading(`Synchronisiere Aktivitäten der letzten ${syncDaysSetting} Tage…`);
  }

  try {
    const result = await fetchStravaActivitiesWithTokens(stravaTokens, syncDaysSetting);
    stravaTokens = result.tokens;
    if (result.tokenRefreshed) {
      await saveStravaTokens(stravaTokens);
    }

    allActivities = result.activities;
    window.stravaActivities = allActivities;
    window.stravaTokens = stravaTokens;
    if (allActivities.length > 0 && !selectedActivityId) {
      selectedActivityId = allActivities[0].id;
    }

    // In Firestore cachen (inkl. Tagesstempel für den täglichen 6-Monate-Sync)
    const isFullSixMonthSync = syncDaysSetting >= DAILY_AUTO_SYNC_DAYS;
    await cacheActivities(allActivities, isFullSixMonthSync);

    // Eigene Stats für den Hub aktualisieren
    await publishUserStatsToHub(allActivities, stravaTokens, { markDailySynced: isFullSixMonthSync });

    if (!isAutoDailySync) {
      showToast(`✅ ${allActivities.length} Aktivitäten (${syncDaysSetting} Tage) synchronisiert!`, "success");
    } else {
      console.log(`[strava] Täglicher 6-Monate-Sync abgeschlossen: ${allActivities.length} Aktivitäten geladen.`);
    }
    renderActivitiesView();
    renderAnalysisView();
    // KI-Vorschau im Trainingsplan aktualisieren
    window.updateAiPreview?.();

  } catch (err) {
    console.error("Fehler beim Laden der Aktivitäten:", err);
    if (!silentLoading) {
      showToast(`Synchronisation fehlgeschlagen: ${err.message}`, "error");
    }
    if (allActivities.length === 0) {
      showConnectButton();
    } else {
      renderActivitiesView();
      renderAnalysisView();
    }
  }
}

async function cacheActivities(activities, markDailySynced = false) {
  const ref = doc(db, "users", currentUser.uid, "cache", "activities");
  const payload = {
    data: activities,
    updatedAt: new Date().toISOString(),
    syncDays: syncDaysSetting,
  };
  if (markDailySynced || syncDaysSetting >= DAILY_AUTO_SYNC_DAYS) {
    payload.lastDailySyncDate = getTodayDateKey();
  }
  await setDoc(ref, payload, { merge: true });
}

async function loadCachedActivitiesMeta() {
  try {
    const ref = doc(db, "users", currentUser.uid, "cache", "activities");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data() || {};
      return {
        data: Array.isArray(d.data) ? d.data : [],
        updatedAt: d.updatedAt || null,
        syncDays: d.syncDays || 0,
        lastDailySyncDate: d.lastDailySyncDate || null,
      };
    }
  } catch (err) {
    console.error("Fehler beim Laden der Cache-Aktivitäten:", err);
  }
  return { data: [], updatedAt: null, syncDays: 0, lastDailySyncDate: null };
}

async function loadCachedActivities() {
  const meta = await loadCachedActivitiesMeta();
  return meta.data;
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
          <span id="activity-chart-main-title">📈 ${isBike(activity) ? 'Leistungs- &amp; Herzfrequenzverlauf' : (isRun(activity) ? 'Pace- &amp; Herzfrequenzverlauf' : 'Geschwindigkeits- &amp; Herzfrequenzverlauf')} dieser Einheit</span>
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
  // 1. Aus Streams (time + velocity_smooth / distance / watts / heartrate / moving)
  const timeStream = streamsData?.time?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "time")?.data : null);
  const velStream = streamsData?.velocity_smooth?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "velocity_smooth")?.data : null);
  const distStream = streamsData?.distance?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "distance")?.data : null);
  const wattsStream = streamsData?.watts?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "watts")?.data : null);
  const hrStream = streamsData?.heartrate?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "heartrate")?.data : null);
  const movingStream = streamsData?.moving?.data || (Array.isArray(streamsData) ? streamsData.find(s => s.type === "moving")?.data : null);

  const hasAnyMetricStream = Array.isArray(velStream) || Array.isArray(distStream) || Array.isArray(wattsStream) || Array.isArray(hrStream);

  if (Array.isArray(timeStream) && timeStream.length > 1 && hasAnyMetricStream) {
    const rawPoints = [];
    let cumActiveSec = 0;

    for (let i = 0; i < timeStream.length; i++) {
      if (i > 0) {
        const rawDt = Math.max(0, (timeStream[i] || 0) - (timeStream[i - 1] || 0));
        const isMoving = Array.isArray(movingStream) ? Boolean(movingStream[i]) : true;
        // Lange Standpausen (z. B. Uhr pausiert / Ampelstopp) aus der aktiven Bewegungszeit herausfiltern
        const activeDt = isMoving ? Math.min(rawDt, 30) : 0;
        cumActiveSec += activeDt;
      }

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

      rawPoints.push({ sec: cumActiveSec, kmh, watts, hr });
    }

    // Zeitachse auf die tatsächliche Bewegungsdauer (moving_time) normieren, falls vorhanden
    const targetDurSec = parseFloat(activity?.moving_time) || parseFloat(activity?.elapsed_time) || cumActiveSec;
    const scaleRatio = (cumActiveSec > 0 && targetDurSec > 0) ? (targetDurSec / cumActiveSec) : 1;
    rawPoints.forEach(p => {
      p.min = (p.sec * scaleRatio) / 60;
    });

    // Einheitliches 0,5-Minuten-Zeitraster (0, 0.5, 1.0, 1.5, ...) OHNE Mittelung über Zeit-Buckets:
    // Zu jedem Zeitpunkt tMin wird direkt der Momentanwert an diesem Zeitpunkt abgegriffen.
    const totalDurationMin = Math.max(1, Math.round(((targetDurSec || 60) / 60) * 2) / 2);
    const timeStepMin = 0.5;
    const sampled = [];
    let cursor = 0;

    const pickValueAtMin = (tMin, field) => {
      // Nächstliegenden / interpolierten Momentanwert zum Zeitpunkt tMin ermitteln (keine Bucket-Mittelung über die Zeit)
      const p0 = rawPoints[cursor];
      const p1 = rawPoints[Math.min(rawPoints.length - 1, cursor + 1)];
      const v0 = p0?.[field];
      const v1 = p1?.[field];
      if (typeof v0 === "number" && !isNaN(v0) && typeof v1 === "number" && !isNaN(v1)) {
        const span = p1.min - p0.min;
        if (span > 0 && tMin >= p0.min && tMin <= p1.min) {
          const ratio = (tMin - p0.min) / span;
          return v0 + ratio * (v1 - v0);
        }
      }
      if (typeof v0 === "number" && !isNaN(v0)) return v0;
      if (typeof v1 === "number" && !isNaN(v1)) return v1;
      return null;
    };

    for (let t = 0; t <= totalDurationMin + 1e-6; t += timeStepMin) {
      const tMin = Math.round(t * 10) / 10;
      while (cursor < rawPoints.length - 2 && rawPoints[cursor + 1].min <= tMin) {
        cursor++;
      }
      const kmhVal = pickValueAtMin(tMin, "kmh");
      const wattsVal = pickValueAtMin(tMin, "watts");
      const hrVal = pickValueAtMin(tMin, "hr");

      sampled.push({
        min: tMin,
        kmh: kmhVal != null ? Math.round(kmhVal * 100) / 100 : null,
        watts: wattsVal != null ? Math.round(wattsVal * 10) / 10 : null,
        hr: hrVal != null ? Math.round(hrVal * 10) / 10 : null,
      });
    }
    return sampled;
  }

  // 2. Aus Splits oder Laps (die Quelle mit der feineren Auflösung / mehr Messpunkten bevorzugen)
  const candidates = [
    detailData?.splits_metric,
    detailData?.laps,
    activity?.splits_metric,
    activity?.laps,
  ].filter(arr => Array.isArray(arr) && arr.length > 1);
  candidates.sort((a, b) => b.length - a.length);
  const splits = candidates[0] || null;

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
      points.push({ min: Math.round((cumSec / 60) * 100) / 100, kmh: Math.round(spd * 100) / 100, watts: w, hr });
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
  const numId = Number(activity.id);

  if (activitySpeedProfileCache.has(numId)) {
    const cached = activitySpeedProfileCache.get(numId);
    if (Array.isArray(cached) && cached.length > 1) {
      return cached;
    }
  }
  if (noStreamActivityIds.has(numId)) {
    return null;
  }

  // Prüfen ob bereits im Objekt selbst Splits/Laps vorhanden sind
  const localProfile = extractProfileFromData(activity);
  if (localProfile && localProfile.length > 1) {
    activitySpeedProfileCache.set(numId, localProfile);
    return localProfile;
  }

  if (inFlightProfilePromises.has(numId)) {
    return inFlightProfilePromises.get(numId);
  }

  const fetchPromise = (async () => {
    try {
      const token = await getValidAccessToken();
      if (!token) return null;

      // 1. Versuch: Strava Streams API (time, velocity_smooth, distance, watts, heartrate, moving)
      const streamUrl = `${STRAVA_API_BASE}/activities/${numId}/streams?keys=time,velocity_smooth,distance,watts,heartrate,moving&key_by_type=true`;
      const res = await fetch(streamUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.ok) {
        const streamsData = await res.json();
        const profile = extractProfileFromData(activity, streamsData, null);
        if (profile && profile.length > 1) {
          activitySpeedProfileCache.set(numId, profile);
          return profile;
        }
      }

      // 2. Versuch: Einzelne Aktivität abrufen für splits_metric / laps
      const detailUrl = `${STRAVA_API_BASE}/activities/${numId}`;
      const detailRes = await fetch(detailUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (detailRes.ok) {
        const detailData = await detailRes.json();
        const profile = extractProfileFromData(activity, null, detailData);
        if (profile && profile.length > 1) {
          activitySpeedProfileCache.set(numId, profile);
          return profile;
        }
        // Aktivität existiert, besitzt aber weder Streams noch Splits (z. B. manueller Eintrag)
        noStreamActivityIds.add(numId);
      }
    } catch (err) {
      console.warn(`[strava] Konnte Detail-Verlauf für Aktivität ${numId} nicht laden:`, err);
    } finally {
      inFlightProfilePromises.delete(numId);
    }
    return null;
  })();

  inFlightProfilePromises.set(numId, fetchPromise);
  return fetchPromise;
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

/**
 * Formatiert einen Dezimalwert in Minuten pro km (z. B. 5.25 -> "5:15") als String.
 */
function formatPaceMinKm(paceDecimal) {
  if (typeof paceDecimal !== "number" || isNaN(paceDecimal) || paceDecimal <= 0) return "–";
  const totalSecs = Math.round(paceDecimal * 60);
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * Wandelt km/h in Pace (min/km als Dezimalzahl) um und begrenzt Ausreißer (z. B. Standzeiten an Ampeln).
 */
function kmhToPaceMinKm(kmh, fallbackPace = 6.0) {
  if (typeof kmh !== "number" || isNaN(kmh) || kmh <= 0.5) return fallbackPace;
  const pace = 60 / kmh;
  return Math.min(15, Math.max(2, pace));
}

function drawActivityProfileChart(activity, profile, sameTypeActs, typeLabel, durationMin, subtitleEl) {
  if (detailChartInstance) {
    detailChartInstance.destroy();
  }

  const ctx = document.getElementById("activity-detail-chart")?.getContext("2d");
  if (!ctx) return;

  const bikeMode = isBike(activity);
  const runMode = isRun(activity);
  const primaryField = bikeMode ? "watts" : "kmh";
  const primaryUnit = bikeMode ? "W" : (runMode ? "min/km" : "km/h");
  const primaryLabelShort = bikeMode ? "Leistung" : (runMode ? "Pace" : "Geschwindigkeit");

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

  // ── 1. Primäre Metrik (Watt für Rad, Pace min/km für Laufen, km/h für andere Sportarten) ──
  const thisAvgKmhVal = getActivityAvgKmh(activity);
  const thisAvgPaceVal = kmhToPaceMinKm(thisAvgKmhVal, 6.0);
  const thisPrimaryAvg = bikeMode
    ? (getActivityAvgWatts(activity) ?? 0)
    : (runMode ? thisAvgPaceVal : thisAvgKmhVal);
  const hasThisPrimaryData = bikeMode ? (hasDetailedPrimary || getActivityAvgWatts(activity) != null) : true;

  const thisPrimarySeries = hasThisPrimaryData
    ? timePointsMin.map(tMin => {
        if (bikeMode) {
          const val = hasDetailedPrimary
            ? interpolateFieldAtMinute(profile, tMin, "watts", thisPrimaryAvg)
            : thisPrimaryAvg;
          return Math.round(val ?? 0);
        } else if (runMode) {
          const kmhVal = hasDetailedPrimary
            ? interpolateFieldAtMinute(profile, tMin, "kmh", thisAvgKmhVal)
            : thisAvgKmhVal;
          const paceVal = kmhToPaceMinKm(kmhVal, thisAvgPaceVal);
          return Math.round(paceVal * 100) / 100;
        } else {
          const val = hasDetailedPrimary
            ? interpolateFieldAtMinute(profile, tMin, "kmh", thisAvgKmhVal)
            : thisAvgKmhVal;
          return Math.round((val ?? 0) * 100) / 100;
        }
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

  const peerPrimarySeries = primaryPeers.length > 0
    ? timePointsMin.map(tMin => {
        const activeAtTime = primaryPeers.filter(a => {
          const aDurMin = (parseFloat(a.moving_time) || parseFloat(a.elapsed_time) || 0) / 60;
          return aDurMin >= tMin;
        });
        const pool = activeAtTime.length > 0 ? activeAtTime : primaryPeers;
        const sumVal = pool.reduce((sum, a) => {
          const prof = activitySpeedProfileCache.get(a.id);
          if (bikeMode) {
            const aAvg = getActivityAvgWatts(a) || 0;
            const val = (Array.isArray(prof) && prof.length > 1)
              ? interpolateFieldAtMinute(prof, tMin, "watts", aAvg)
              : aAvg;
            return sum + (val ?? aAvg);
          } else {
            const aAvgKmh = getActivityAvgKmh(a);
            const kmhVal = (Array.isArray(prof) && prof.length > 1)
              ? interpolateFieldAtMinute(prof, tMin, "kmh", aAvgKmh)
              : aAvgKmh;
            return sum + (kmhVal ?? aAvgKmh);
          }
        }, 0);
        const avg = sumVal / pool.length;
        if (bikeMode) return Math.round(avg);
        if (runMode) {
          const paceAvg = kmhToPaceMinKm(avg, thisAvgPaceVal);
          return Math.round(paceAvg * 100) / 100;
        }
        return Math.round(avg * 100) / 100;
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
      : (runMode
          ? (hasDetailedPrimary
              ? `Pace-Verlauf über ${durationMin} Min.`
              : `Ø Pace (${formatPaceMinKm(thisPrimaryAvg)} min/km, Gerade)`)
          : (hasDetailedPrimary
              ? `Geschwindigkeitsverlauf über ${durationMin} Min.`
              : `Ø Geschwindigkeit (${thisPrimaryAvg.toFixed(1)} km/h, Gerade)`));
    const hrDesc = showHrAxis ? ` • inkl. ❤️ Herzfrequenz` : "";
    subtitleEl.textContent = `${primaryDesc} vs. Ø aus ${sameTypeActs.length} ${typeLabel}-Einheiten${hrDesc}`;
  }

  const labels = timePointsMin.map(m => `${Math.round(m)} Min.`);
  const datasets = [];

  const formattedThisAvgStr = bikeMode
    ? `${Math.round(thisPrimaryAvg)} W`
    : (runMode ? `${formatPaceMinKm(thisPrimaryAvg)} min/km` : `${thisPrimaryAvg.toFixed(1)} km/h`);

  // Dataset 1: Primärer Verlauf dieser Einheit (Watt, min/km oder km/h)
  if (hasThisPrimaryData) {
    datasets.push({
      label: hasDetailedPrimary
        ? `${primaryLabelShort} dieser Einheit (${primaryUnit})`
        : `Ø ${primaryLabelShort} dieser Einheit (${formattedThisAvgStr})`,
      data: thisPrimarySeries,
      yAxisID: "y",
      borderColor: "#e8391e",
      backgroundColor: "rgba(232, 57, 30, 0.14)",
      borderWidth: 2.5,
      pointRadius: 0,
      pointHitRadius: 10,
      pointHoverRadius: 5,
      tension: hasDetailedPrimary ? 0.3 : 0,
      fill: runMode ? "start" : true,
      unit: primaryUnit,
    });
  }

  // Dataset 2: Graue Durchschnittslinie der primären Metrik (Watt, min/km oder km/h)
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
      pointHitRadius: 10,
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
      pointRadius: 0,
      pointHitRadius: 10,
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
      pointHitRadius: 10,
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
      reverse: runMode,
      title: {
        display: true,
        text: bikeMode ? "Leistung (Watt)" : (runMode ? "Pace (min/km)" : "Geschwindigkeit (km/h)"),
        color: "#e8391e",
        font: { family: "Inter", size: 11, weight: "600" }
      },
      beginAtZero: false,
      suggestedMin: runMode ? Math.max(2, Math.floor((minPrimary - 0.4) * 2) / 2) : Math.max(0, Math.floor(minPrimary * 0.85)),
      suggestedMax: runMode ? Math.ceil((maxPrimary + 0.4) * 2) / 2 : Math.ceil(maxPrimary * 1.1),
      ticks: {
        color: "#94a3b8",
        font: { family: "Inter", size: 11 },
        callback: (v) => runMode ? `${formatPaceMinKm(v)} min/km` : `${v} ${primaryUnit}`
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
              if (unit === "min/km") {
                return `${context.dataset.label}: ${formatPaceMinKm(rawVal)} min/km`;
              }
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
  const html = `
    <div class="strava-connect-card">
      <span class="connect-icon">🚴‍♂️</span>
      <h3>Verbinde deinen Strava-Account</h3>
      <p>Synchronisiere deine Trainingseinheiten automatisch für die Leistungsanalyse, den KI-Trainingsplan und den Team-Hub.</p>
      <button class="btn btn-strava" onclick="window.stravaConnect()">
        🚴 Mit Strava verbinden
      </button>
    </div>
  `;
  const container = document.getElementById("strava-content");
  if (container) container.innerHTML = html;
  const analysisContainer = document.getElementById("analysis-content");
  if (analysisContainer) analysisContainer.innerHTML = html;
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

// ════════════════════════════════════════════════════════════
// REITER: ANALYSE (Mehrfachauswahl & Geschwindigkeits-/HF-Schnitt)
// ════════════════════════════════════════════════════════════

/**
 * Filtert die Aktivitäten für den Analyse-Tab.
 */
function applyAnalysisFilters() {
  analysisFilteredActivities = sortActivitiesDesc(allActivities).filter((a) => {
    let matchesSport = analysisFilterSport === "all";
    if (!matchesSport) {
      if (analysisFilterSport === "Ride") matchesSport = isBike(a);
      else if (analysisFilterSport === "Run") matchesSport = isRun(a);
      else if (analysisFilterSport === "Swim") matchesSport = isSwim(a);
      else matchesSport = (a.type === analysisFilterSport || a.sport_type === analysisFilterSport);
    }
    const matchesSearch = !analysisSearchQuery || (a.name || "").toLowerCase().includes(analysisSearchQuery);
    return matchesSport && matchesSearch;
  });

  // Beim allerersten Öffnen standardmäßig die letzten 3 Aktivitäten derselben Sportart (oder die letzten 3) vorauswählen
  if (!analysisInitialized && allActivities.length > 0) {
    analysisInitialized = true;
    const sorted = sortActivitiesDesc(allActivities);
    const firstAct = sorted[0];
    const sameSportPool = sorted.filter(a => {
      if (isBike(firstAct)) return isBike(a);
      if (isRun(firstAct)) return isRun(a);
      if (isSwim(firstAct)) return isSwim(a);
      return true;
    });
    const initialPick = (sameSportPool.length >= 2 ? sameSportPool : sorted).slice(0, 3);
    initialPick.forEach(a => {
      if (a?.id != null) selectedAnalysisIds.add(Number(a.id));
    });
  }
}

let analysisLoadingPromise = null;

/**
 * Rendert die Hauptansicht des Analyse-Tabs (Master-Detail mit Mehrfachauswahl).
 */
export async function renderAnalysisView() {
  const container = document.getElementById("analysis-content");
  if (!container) return;

  if (!currentUser && auth?.currentUser) {
    currentUser = auth.currentUser;
  }

  if (allActivities.length === 0 && Array.isArray(window.stravaActivities) && window.stravaActivities.length > 0) {
    allActivities = sortActivitiesDesc(window.stravaActivities);
  }

  if (allActivities.length === 0 && currentUser) {
    if (!analysisLoadingPromise) {
      analysisLoadingPromise = (async () => {
        try {
          if (!stravaTokens?.accessToken) {
            await loadStravaTokens();
          }
          if (stravaTokens?.accessToken && allActivities.length === 0) {
            const cachedMeta = await loadCachedActivitiesMeta();
            if (Array.isArray(cachedMeta.data) && cachedMeta.data.length > 0) {
              allActivities = sortActivitiesDesc(cachedMeta.data);
              window.stravaActivities = allActivities;
            }
          }
        } catch (err) {
          console.warn("[strava] Fehler beim Nachladen der Analyse-Aktivitäten:", err);
        } finally {
          analysisLoadingPromise = null;
        }
      })();
    }
    await analysisLoadingPromise;
  }

  if (!stravaTokens?.accessToken && allActivities.length === 0) {
    showConnectButton();
    return;
  }

  applyAnalysisFilters();

  container.innerHTML = `
    <div class="activities-master-detail analysis-master-detail">
      <!-- Linke Spalte: Scrollbare Aktivitäten-Liste mit Mehrfachauswahl -->
      <div class="activities-list-pane analysis-list-pane">
        <div class="list-filters-header">
          <div class="sport-filter-chips" id="analysis-sport-chips">
            <button type="button" class="chip ${analysisFilterSport === 'all' ? 'active' : ''}" data-sport="all">Alle (${allActivities.length})</button>
            <button type="button" class="chip ${analysisFilterSport === 'Run' ? 'active' : ''}" data-sport="Run">🏃 Laufen</button>
            <button type="button" class="chip ${analysisFilterSport === 'Ride' ? 'active' : ''}" data-sport="Ride">🚴 Rad</button>
            <button type="button" class="chip ${analysisFilterSport === 'Swim' ? 'active' : ''}" data-sport="Swim">🏊 Schwimmen</button>
          </div>

          <input
            type="text"
            id="analysis-search-input"
            placeholder="Aktivität für Analyse suchen..."
            value="${escapeHtml(analysisSearchQuery)}"
            class="activity-search-box"
          />

          <div class="analysis-selection-toolbar">
            <span class="analysis-selected-badge" id="analysis-selected-count-badge">
              ${selectedAnalysisIds.size} ausgewählt
            </span>
            <div class="analysis-selection-actions">
              <button type="button" class="btn-analysis-action" id="btn-analysis-select-filtered" title="Alle aktuell gefilterten Aktivitäten auswählen">
                ✓ Gefilterte wählen
              </button>
              <button type="button" class="btn-analysis-action btn-analysis-clear" id="btn-analysis-clear-selection" title="Auswahl komplett aufheben">
                ✕ Leeren
              </button>
            </div>
          </div>
        </div>

        <div class="activities-scrollable-list" id="analysis-scroll-container">
          <!-- Wird per renderAnalysisListItems() befüllt -->
        </div>
      </div>

      <!-- Rechte Spalte: Aggregierte Werte & Durchschnitts-Diagramm -->
      <div class="activity-detail-pane" id="analysis-detail-container">
        <!-- Wird per renderAnalysisDetail() befüllt -->
      </div>
    </div>
  `;

  setupAnalysisListeners();
  renderAnalysisListItems();
  renderAnalysisDetail();
}

/**
 * Richtet die Filter-, Such- und Auswahl-Listener im Analyse-Tab ein.
 */
function setupAnalysisListeners() {
  const chips = document.querySelectorAll("#analysis-sport-chips .chip");
  chips.forEach((c) => {
    c.addEventListener("click", () => {
      chips.forEach(chip => chip.classList.remove("active"));
      c.classList.add("active");
      analysisFilterSport = c.dataset.sport;
      applyAnalysisFilters();
      renderAnalysisListItems();
    });
  });

  const searchInput = document.getElementById("analysis-search-input");
  searchInput?.addEventListener("input", (e) => {
    analysisSearchQuery = e.target.value.toLowerCase().trim();
    applyAnalysisFilters();
    renderAnalysisListItems();
  });

  document.getElementById("btn-analysis-select-filtered")?.addEventListener("click", () => {
    analysisFilteredActivities.forEach(a => {
      if (a?.id != null) selectedAnalysisIds.add(Number(a.id));
    });
    updateAnalysisCountBadge();
    renderAnalysisListItems();
    renderAnalysisDetail();
  });

  document.getElementById("btn-analysis-clear-selection")?.addEventListener("click", () => {
    selectedAnalysisIds.clear();
    updateAnalysisCountBadge();
    renderAnalysisListItems();
    renderAnalysisDetail();
  });
}

function updateAnalysisCountBadge() {
  const badge = document.getElementById("analysis-selected-count-badge");
  if (badge) {
    badge.textContent = `${selectedAnalysisIds.size} ausgewählt`;
  }
}

/**
 * Rendert die scrollbare Liste der Aktivitäten mit Checkbox-Mehrfachauswahl.
 */
function renderAnalysisListItems() {
  const container = document.getElementById("analysis-scroll-container");
  if (!container) return;

  const sortedList = sortActivitiesDesc(analysisFilteredActivities);

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
    const numId = Number(a.id);
    const isSelected = selectedAnalysisIds.has(numId);
    const icon = getSportIcon(a.type);
    const dateStr = new Date(a.start_date_local || a.start_date).toLocaleDateString("de-DE", {
      day: "2-digit", month: "short", year: "numeric"
    });
    const distKm = ((parseFloat(a.distance) || 0) / 1000).toFixed(1);
    const durationMin = Math.round((parseFloat(a.moving_time) || 0) / 60);
    const avgKmh = getActivityAvgKmh(a);
    const avgHr = getActivityAvgHr(a);
    const speedDisplay = isRun(a)
      ? `${formatPaceMinKm(kmhToPaceMinKm(avgKmh))} /km`
      : `${avgKmh.toFixed(1)} km/h`;
    const badgeClass = isBike(a) ? "badge-ride" : (isRun(a) ? "badge-run" : (isSwim(a) ? "badge-swim" : "badge-other"));
    const badgeText = a.type === "VirtualRide" ? "VirtualRide" : (a.type || "Other");

    return `
      <div class="activity-card-item analysis-card-item ${isSelected ? 'selected' : ''}" data-id="${numId}">
        <span class="analysis-check-box ${isSelected ? 'checked' : ''}" aria-hidden="true">${isSelected ? '✓' : ''}</span>
        <span class="item-icon">${icon}</span>
        <div class="item-content">
          <div class="item-name">${escapeHtml(a.name)}</div>
          <div class="item-meta">
            ${dateStr} &bull; ${durationMin} Min. &bull; ⚡ ${speedDisplay}
            ${avgHr ? ` &bull; ❤️ ${Math.round(avgHr)}` : ''}
          </div>
        </div>
        <div class="item-right">
          <div class="item-dist">${distKm} km</div>
          <span class="item-badge ${badgeClass}">${badgeText}</span>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".analysis-card-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (selectedAnalysisIds.has(id)) {
        selectedAnalysisIds.delete(id);
        el.classList.remove("selected");
        const cb = el.querySelector(".analysis-check-box");
        if (cb) { cb.classList.remove("checked"); cb.textContent = ""; }
      } else {
        selectedAnalysisIds.add(id);
        el.classList.add("selected");
        const cb = el.querySelector(".analysis-check-box");
        if (cb) { cb.classList.add("checked"); cb.textContent = "✓"; }
      }
      updateAnalysisCountBadge();
      renderAnalysisDetail();
    });
  });
}

/**
 * Rendert die rechte Auswertungs-Spalte für alle ausgewählten Aktivitäten.
 */
function renderAnalysisDetail() {
  const container = document.getElementById("analysis-detail-container");
  if (!container) return;

  const selectedActs = sortActivitiesDesc(
    allActivities.filter(a => selectedAnalysisIds.has(Number(a.id)))
  );

  if (selectedActs.length === 0) {
    if (analysisChartInstance) {
      analysisChartInstance.destroy();
      analysisChartInstance = null;
    }
    container.innerHTML = `
      <div class="detail-placeholder">
        <span style="font-size:3rem;">📈</span>
        <h3>Aktivitäten zur Analyse auswählen</h3>
        <p>Klicke links in der Liste auf beliebig viele Trainingseinheiten, um deren Geschwindigkeits- und Herzfrequenzschnitt im gemeinsamen Diagramm auszuwerten.</p>
      </div>
    `;
    return;
  }

  // Aggregierte Kennzahlen über die Auswahl berechnen
  const count = selectedActs.length;
  const totalDistKm = selectedActs.reduce((s, a) => s + ((parseFloat(a.distance) || 0) / 1000), 0);
  const avgDistKm = totalDistKm / count;

  const totalMovingSec = selectedActs.reduce((s, a) => s + (parseFloat(a.moving_time) || 0), 0);
  const avgMovingSec = Math.round(totalMovingSec / count);

  const avgKmhMean = selectedActs.reduce((s, a) => s + getActivityAvgKmh(a), 0) / count;
  const avgKmhWeighted = totalMovingSec > 0 ? (totalDistKm / (totalMovingSec / 3600)) : avgKmhMean;
  const avgKmh = avgKmhMean > 0 ? avgKmhMean : avgKmhWeighted;
  const avgPaceDecimal = kmhToPaceMinKm(avgKmh, 6.0);
  const avgPaceFormatted = `${formatPaceMinKm(avgPaceDecimal)} min/km`;

  const actsWithHr = selectedActs.filter(a => getActivityAvgHr(a) != null);
  const avgHr = actsWithHr.length > 0
    ? actsWithHr.reduce((s, a) => s + getActivityAvgHr(a), 0) / actsWithHr.length
    : null;
  const maxHrVals = selectedActs.map(a => parseFloat(a.max_heartrate)).filter(v => !isNaN(v) && v > 0);
  const peakMaxHr = maxHrVals.length > 0 ? Math.round(Math.max(...maxHrVals)) : null;

  const totalElev = Math.round(selectedActs.reduce((s, a) => s + (parseFloat(a.total_elevation_gain) || 0), 0));
  const avgElev = Math.round(totalElev / count);

  const allRuns = selectedActs.every(a => isRun(a));
  const effectivePaceMode = analysisSpeedUnitOverride === "pace" || (analysisSpeedUnitOverride === null && allRuns);

  // Zeitraum der Auswahl
  const timestamps = selectedActs.map(a => parseActivityDate(a)).filter(t => t > 0);
  const minDateStr = timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })
    : "–";
  const maxDateStr = timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })
    : "–";
  const dateRangeLabel = minDateStr === maxDateStr ? minDateStr : `${minDateStr} – ${maxDateStr}`;

  // Icons der enthaltenen Sportarten
  const uniqueIcons = Array.from(new Set(selectedActs.map(a => getSportIcon(a.type)))).join(" ");

  // Kompakte Chips der ausgewählten Einheiten
  const selectedPillsHtml = selectedActs.map(a => {
    const dStr = new Date(a.start_date_local || a.start_date).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    const aKmh = getActivityAvgKmh(a);
    const aHr = getActivityAvgHr(a);
    const spdStr = isRun(a) ? `${formatPaceMinKm(kmhToPaceMinKm(aKmh))} min/km` : `${aKmh.toFixed(1)} km/h`;
    return `
      <span class="analysis-selected-activity-pill" data-remove-id="${a.id}" title="Klicken, um ${escapeHtml(a.name)} aus der Auswahl zu entfernen">
        <span>${getSportIcon(a.type)}</span>
        <strong>${escapeHtml(a.name)}</strong>
        <span class="pill-meta">(${dStr} • ${spdStr}${aHr ? ` • ❤️ ${Math.round(aHr)}` : ''})</span>
        <span class="pill-remove">✕</span>
      </span>
    `;
  }).join("");

  container.innerHTML = `
    <div class="detail-card">
      <!-- Detail Header -->
      <div class="detail-header">
        <div class="detail-title-group">
          <span class="detail-type-icon">${uniqueIcons || '📈'}</span>
          <div>
            <h2 class="detail-activity-name">Schnitt aus ${count} ${count === 1 ? 'ausgewählter Aktivität' : 'ausgewählten Aktivitäten'}</h2>
            <div class="detail-date-time">
              📅 Zeitraum der Auswahl: ${dateRangeLabel} &bull; ❤️ ${actsWithHr.length}/${count} mit Herzfrequenzdaten
            </div>
          </div>
        </div>

        <div class="detail-actions">
          <div class="hub-chart-filter-pills" id="analysis-unit-toggle">
            <button type="button" class="hub-filter-pill ${!effectivePaceMode ? 'active' : ''}" data-unit="kmh">
              🚀 km/h
            </button>
            <button type="button" class="hub-filter-pill ${effectivePaceMode ? 'active' : ''}" data-unit="pace">
              🏃 min/km (Pace)
            </button>
          </div>
        </div>
      </div>

      <!-- Haupt-KPIs der Auswahl -->
      <div class="detail-kpis">
        <div class="detail-kpi-card">
          <div class="kpi-label">${effectivePaceMode ? 'Ø PACE (SCHNITT)' : 'Ø GESCHWINDIGKEIT'}</div>
          <div class="kpi-val" id="analysis-kpi-speed-val">
            ${effectivePaceMode
              ? `${formatPaceMinKm(avgPaceDecimal)} <span class="kpi-unit">min/km</span>`
              : `${avgKmh.toFixed(1)} <span class="kpi-unit">km/h</span>`}
          </div>
          <div class="kpi-sub-hint" id="analysis-kpi-speed-hint">${effectivePaceMode ? `entspricht Ø ${avgKmh.toFixed(1)} km/h` : `entspricht Ø ${avgPaceFormatted}`}</div>
        </div>

        <div class="detail-kpi-card">
          <div class="kpi-label">❤️ Ø HERZFREQUENZ</div>
          <div class="kpi-val" id="analysis-kpi-hr-val">${avgHr != null ? `${Math.round(avgHr)} <span class="kpi-unit">bpm</span>` : '–'}</div>
          <div class="kpi-sub-hint">${peakMaxHr ? `Spitzenwert: ${peakMaxHr} bpm` : 'Keine HF-Spitzenwerte'}</div>
        </div>

        <div class="detail-kpi-card">
          <div class="kpi-label">Ø DISTANZ JE EINHEIT</div>
          <div class="kpi-val">${avgDistKm.toFixed(2)} <span class="kpi-unit">km</span></div>
          <div class="kpi-sub-hint">Gesamt: ${totalDistKm.toFixed(1)} km</div>
        </div>

        <div class="detail-kpi-card">
          <div class="kpi-label">Ø BEWEGUNGSZEIT</div>
          <div class="kpi-val">${formatSeconds(avgMovingSec)}</div>
          <div class="kpi-sub-hint">Gesamt: ${formatSeconds(totalMovingSec)} (${avgElev} Ø hm)</div>
        </div>
      </div>

      <!-- Diagramm-Bereich für den Geschwindigkeits- & Herzfrequenzschnitt -->
      <div class="detail-chart-section">
        <div class="detail-chart-title">
          <span id="analysis-chart-main-title">
            📈 ${effectivePaceMode ? 'Pace- &amp; Herzfrequenzschnitt' : 'Geschwindigkeits- &amp; Herzfrequenzschnitt'} (${count} ${count === 1 ? 'Einheit' : 'Einheiten'})
          </span>
          <span class="chart-subtitle" id="analysis-chart-subtitle">
            Berechne kombinierten Verlauf über die Dauer…
          </span>
        </div>
        <div class="detail-chart-wrapper">
          <canvas id="analysis-detail-chart"></canvas>
        </div>
      </div>

      <!-- Ausgewählte Einheiten als klickbare Pills -->
      <div class="analysis-selected-pills-section">
        <div class="analysis-pills-title">Ausgewählte Aktivitäten (${count}) – Klicke auf eine Einheit zum Abwählen:</div>
        <div class="analysis-selected-pills-wrap" id="analysis-selected-pills-wrap">
          ${selectedPillsHtml}
        </div>
      </div>
    </div>
  `;

  // Unit-Toggle Buttons binden
  container.querySelectorAll("#analysis-unit-toggle .hub-filter-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      analysisSpeedUnitOverride = btn.dataset.unit;
      renderAnalysisDetail();
    });
  });

  // Pill-Remove Buttons binden
  container.querySelectorAll(".analysis-selected-activity-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const remId = Number(pill.dataset.removeId);
      selectedAnalysisIds.delete(remId);
      updateAnalysisCountBadge();
      renderAnalysisListItems();
      renderAnalysisDetail();
    });
  });

  renderAnalysisCombinedChart(selectedActs, effectivePaceMode, avgKmh, avgPaceDecimal, avgHr);
}

/**
 * Lädt (falls nötig) die Verlaufs-Profile aller ausgewählten Aktivitäten nach und zeichnet das Durchschnittsdiagramm.
 */
async function renderAnalysisCombinedChart(selectedActs, paceMode, overallAvgKmh, overallAvgPace, overallAvgHr) {
  if (typeof Chart === "undefined" || !selectedActs || selectedActs.length === 0) return;

  const myToken = ++analysisChartRenderToken;
  const subtitleEl = document.getElementById("analysis-chart-subtitle");

  const missingActs = selectedActs.filter(a => {
    const numId = Number(a.id);
    const cached = activitySpeedProfileCache.get(numId);
    const hasValidCache = Array.isArray(cached) && cached.length > 1;
    return !hasValidCache && !noStreamActivityIds.has(numId);
  });

  // Sofort mit bereits vorhandenen Daten zeichnen
  drawAnalysisCombinedChart(selectedActs, paceMode, overallAvgKmh, overallAvgPace, overallAvgHr, subtitleEl, missingActs.length > 0);

  // Fehlende Stream-Profile für alle ausgewählten Aktivitäten in Paketen nachladen
  if (missingActs.length > 0) {
    const batchSize = 6;
    for (let i = 0; i < missingActs.length; i += batchSize) {
      if (myToken !== analysisChartRenderToken) return;
      const batch = missingActs.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(a => fetchActivitySpeedProfile(a)));
      if (myToken !== analysisChartRenderToken) return;
      const stillLoading = (i + batchSize) < missingActs.length;
      drawAnalysisCombinedChart(selectedActs, paceMode, overallAvgKmh, overallAvgPace, overallAvgHr, subtitleEl, stillLoading);
    }
  }
}

/**
 * Zeichnet das Chart.js Diagramm für den Geschwindigkeits- und Herzfrequenzschnitt der ausgewählten Aktivitäten.
 * Für jeden Zeitpunkt tMin auf der X-Achse wird der arithmetische Mittelwert aller zu diesem Zeitpunkt
 * aktiven ausgewählten Aktivitäten gebildet.
 */
function drawAnalysisCombinedChart(selectedActs, paceMode, overallAvgKmh, overallAvgPace, overallAvgHr, subtitleEl, isLoadingStreams = false) {
  if (analysisChartInstance) {
    analysisChartInstance.destroy();
    analysisChartInstance = null;
  }

  const ctx = document.getElementById("analysis-detail-chart")?.getContext("2d");
  if (!ctx) return;

  // Prüfen, für welche ausgewählten Aktivitäten echte Zeitreihen-Profile vorliegen
  const actsWithProfile = selectedActs.filter(a => {
    const prof = activitySpeedProfileCache.get(Number(a.id));
    return Array.isArray(prof) && prof.length > 1;
  });
  const useStrictProfiles = actsWithProfile.length > 0;

  const getActEndMin = (a) => {
    const prof = activitySpeedProfileCache.get(Number(a.id));
    const durMin = Math.max(1, Math.round((((parseFloat(a.moving_time) || parseFloat(a.elapsed_time) || 60) / 60)) * 2) / 2);
    if (Array.isArray(prof) && prof.length > 1) {
      return prof[prof.length - 1].min || durMin;
    }
    return durMin;
  };

  // Identisches 0,5-Minuten-Zeitraster wie im Aktivitäten-Tab verwenden
  let timePointsMin = [];
  if (actsWithProfile.length === 1 && selectedActs.length === 1) {
    const singleProf = activitySpeedProfileCache.get(Number(actsWithProfile[0].id));
    timePointsMin = singleProf.map(p => p.min);
  } else {
    const maxDurationMin = Math.max(1, ...selectedActs.map(getActEndMin));
    const stepMin = 0.5;
    for (let t = 0; t <= maxDurationMin + 1e-6; t += stepMin) {
      timePointsMin.push(Math.round(t * 10) / 10);
    }
  }

  const unitLabel = paceMode ? "min/km" : "km/h";
  const metricTitle = paceMode ? "Pace" : "Geschwindigkeit";

  const speedContributorCounts = [];

  // 1. Pro Zeitpunkt tMin ausschließlich den Mittelwert zwischen den gewählten Aktivitäten zu diesem Zeitpunkt bilden
  const avgSpeedSeries = timePointsMin.map(tMin => {
    const valsAtTime = [];
    const sourceActs = useStrictProfiles ? actsWithProfile : selectedActs;

    sourceActs.forEach(a => {
      const actEndMin = getActEndMin(a);
      if (tMin > actEndMin + 0.01) return; // Aktivität ist zu diesem Zeitpunkt bereits beendet

      const prof = activitySpeedProfileCache.get(Number(a.id));
      const aAvgKmh = getActivityAvgKmh(a);
      const aAvgPace = kmhToPaceMinKm(aAvgKmh, 6.0);
      let kmhVal = null;
      if (Array.isArray(prof) && prof.length > 1) {
        kmhVal = interpolateFieldAtMinute(prof, tMin, "kmh", aAvgKmh);
      } else if (!useStrictProfiles) {
        kmhVal = aAvgKmh;
      }

      if (typeof kmhVal === "number" && !isNaN(kmhVal) && kmhVal >= 0) {
        if (paceMode) {
          valsAtTime.push(kmhToPaceMinKm(kmhVal, aAvgPace));
        } else {
          valsAtTime.push(kmhVal);
        }
      }
    });

    speedContributorCounts.push(valsAtTime.length);
    if (valsAtTime.length === 0) return null;

    const meanValAtT = valsAtTime.reduce((s, v) => s + v, 0) / valsAtTime.length;
    return Math.round(meanValAtT * 100) / 100;
  });

  // 2. Pro Zeitpunkt tMin ausschließlich den Mittelwert der Herzfrequenz zwischen den gewählten Aktivitäten zu diesem Zeitpunkt bilden
  const actsWithHrProfile = selectedActs.filter(a => {
    const prof = activitySpeedProfileCache.get(Number(a.id));
    return Array.isArray(prof) && prof.some(p => typeof p.hr === "number" && p.hr > 0);
  });
  const actsWithAnyHr = selectedActs.filter(a => getActivityAvgHr(a) != null);
  const useStrictHrProfiles = actsWithHrProfile.length > 0;
  const hasHr = useStrictHrProfiles || actsWithAnyHr.length > 0;

  const hrContributorCounts = [];
  const avgHrSeries = hasHr
    ? timePointsMin.map(tMin => {
        const hrValsAtTime = [];
        const sourceHrActs = useStrictHrProfiles ? actsWithHrProfile : actsWithAnyHr;

        sourceHrActs.forEach(a => {
          const actEndMin = getActEndMin(a);
          if (tMin > actEndMin + 0.01) return;

          const prof = activitySpeedProfileCache.get(Number(a.id));
          const aAvgHr = getActivityAvgHr(a);
          let hrVal = null;
          if (Array.isArray(prof) && prof.length > 1) {
            hrVal = interpolateFieldAtMinute(prof, tMin, "hr", aAvgHr);
          } else if (!useStrictHrProfiles) {
            hrVal = aAvgHr;
          }

          if (typeof hrVal === "number" && !isNaN(hrVal) && hrVal > 0) {
            hrValsAtTime.push(hrVal);
          }
        });

        hrContributorCounts.push(hrValsAtTime.length);
        if (hrValsAtTime.length === 0) return null;
        const meanHrAtT = hrValsAtTime.reduce((s, v) => s + v, 0) / hrValsAtTime.length;
        return Math.round(meanHrAtT);
      })
    : [];

  const validSpeedPoints = avgSpeedSeries.filter(v => typeof v === "number" && !isNaN(v));
  const validHrPoints = avgHrSeries.filter(v => typeof v === "number" && !isNaN(v));

  if (subtitleEl) {
    if (isLoadingStreams) {
      subtitleEl.textContent = `Lade Messwerte pro Zeitpunkt (${actsWithProfile.length}/${selectedActs.length} Aktivitäten geladen)…`;
    } else {
      const spdSummary = paceMode
        ? `Ø Pace: ${formatPaceMinKm(overallAvgPace)} min/km`
        : `Ø Geschwindigkeit: ${overallAvgKmh.toFixed(1)} km/h`;
      const hrSummary = hasHr && overallAvgHr != null ? ` • ❤️ Ø Herzfrequenz: ${Math.round(overallAvgHr)} bpm` : "";
      subtitleEl.textContent = `${spdSummary}${hrSummary} • Pro Zeitpunkt gemittelt zwischen den gewählten Aktivitäten`;
    }
  }

  const labels = timePointsMin.map(m => `${Math.round(m)} Min.`);
  const datasets = [
    {
      label: `Ø ${metricTitle} pro Zeitpunkt (${unitLabel})`,
      data: avgSpeedSeries,
      yAxisID: "y",
      borderColor: "#e8391e",
      backgroundColor: "rgba(232, 57, 30, 0.14)",
      borderWidth: 2.5,
      pointRadius: 0,
      pointHitRadius: 10,
      pointHoverRadius: 5,
      tension: 0.3,
      spanGaps: true,
      fill: paceMode ? "start" : true,
      unit: unitLabel,
      contributorCounts: speedContributorCounts,
    }
  ];

  if (hasHr) {
    datasets.push({
      label: `❤️ Ø Herzfrequenz pro Zeitpunkt (bpm)`,
      data: avgHrSeries,
      yAxisID: "yHr",
      borderColor: "#ec4899",
      backgroundColor: "rgba(236, 72, 153, 0.08)",
      borderWidth: 2,
      pointRadius: 0,
      pointHitRadius: 10,
      pointHoverRadius: 4,
      tension: 0.3,
      spanGaps: true,
      fill: false,
      unit: "bpm",
      contributorCounts: hrContributorCounts,
    });
  }

  const allPrimaryVals = validSpeedPoints;
  const minPrimary = allPrimaryVals.length > 0 ? Math.min(...allPrimaryVals) : 0;
  const maxPrimary = allPrimaryVals.length > 0 ? Math.max(...allPrimaryVals) : 30;

  const allHrVals = validHrPoints;
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
      display: true,
      reverse: paceMode,
      title: {
        display: true,
        text: paceMode ? "Ø Pace (min/km)" : "Ø Geschwindigkeit (km/h)",
        color: "#e8391e",
        font: { family: "Inter", size: 11, weight: "600" }
      },
      beginAtZero: false,
      suggestedMin: paceMode ? Math.max(2, Math.floor((minPrimary - 0.4) * 2) / 2) : Math.max(0, Math.floor(minPrimary * 0.85)),
      suggestedMax: paceMode ? Math.ceil((maxPrimary + 0.4) * 2) / 2 : Math.ceil(maxPrimary * 1.1),
      ticks: {
        color: "#94a3b8",
        font: { family: "Inter", size: 11 },
        callback: (v) => paceMode ? `${formatPaceMinKm(v)} min/km` : `${v} km/h`
      },
      grid: { color: "rgba(37, 42, 64, 0.3)" }
    }
  };

  if (hasHr) {
    scales.yHr = {
      type: "linear",
      position: "right",
      display: true,
      title: {
        display: true,
        text: "Ø Herzfrequenz (bpm)",
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
        drawOnChartArea: false,
        color: "rgba(37, 42, 64, 0.3)"
      }
    };
  }

  analysisChartInstance = new Chart(ctx, {
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
              const unit = context.dataset.unit || unitLabel;
              const rawVal = context.parsed?.y;
              const countAtT = context.dataset.contributorCounts?.[context.dataIndex];
              const countSuffix = countAtT ? ` (${countAtT} ${countAtT === 1 ? 'Aktivität' : 'Aktivitäten'})` : "";
              if (typeof rawVal !== "number") return `${context.dataset.label}: ${context.formattedValue}`;
              if (unit === "min/km") {
                return `${context.dataset.label}: ${formatPaceMinKm(rawVal)} min/km${countSuffix}`;
              }
              const formatted = unit === "bpm" ? Math.round(rawVal) : rawVal.toFixed(1);
              return `${context.dataset.label}: ${formatted} ${unit}${countSuffix}`;
            }
          }
        }
      },
      scales
    }
  });
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
