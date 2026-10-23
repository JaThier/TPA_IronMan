// ============================================================
// js/strava.js
// Strava OAuth 2.0 Flow & Aktivitäten-Abruf
// ============================================================
// SETUP:
// 1. Erstelle eine Strava-App unter https://www.strava.com/settings/api
// 2. Lege die Authorization Callback Domain auf deine GitHub Pages Domain fest
// 3. Speichere stravaClientId + stravaClientSecret in Firestore:
//    Firebase Console → Firestore → config → secrets
// ✅ Kein Secret im Quellcode – wird erst nach Login aus Firestore geladen.
// ============================================================

import { db }              from "./firebase-config.js";
import { getSecrets }      from "./config.js";
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast }       from "./ui-helpers.js";

// ── Strava-Konstanten ──────────────────────────────────────
// Client-ID und Client-Secret werden zur Laufzeit aus Firestore geladen.
// (config/secrets → stravaClientId, stravaClientSecret)
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
let currentUser = null;
let stravaTokens = null; // { accessToken, refreshToken, expiresAt, athleteId }

// ── Initialisierung ────────────────────────────────────────
/**
 * Wird nach erfolgreichem Firebase-Login aufgerufen.
 * Prüft auf Strava-Callback (URL-Parameter) und lädt danach Daten.
 * @param {import("firebase/auth").User} user
 */
export async function initStrava(user) {
  currentUser = user;
  renderStravaSection();

  // Prüfe ob wir gerade vom Strava-OAuth-Callback kommen
  const urlParams = new URLSearchParams(window.location.search);
  const code      = urlParams.get("code");
  const state     = urlParams.get("state");

  if (code && state === "strava_oauth") {
    // URL bereinigen (ohne Reload)
    window.history.replaceState({}, document.title, window.location.pathname);
    await handleStravaCallback(code);
    return;
  }

  // Vorhandene Tokens aus Firestore laden
  await loadStravaTokens();

  if (stravaTokens?.accessToken) {
    await fetchAndDisplayActivities();
  } else {
    showConnectButton();
  }
}

// ── OAuth Flow ─────────────────────────────────────────────

/** Startet den Strava OAuth-Redirect */
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

/**
 * Verarbeitet den OAuth-Callback von Strava.
 * Tauscht den Auth-Code gegen Access + Refresh Token.
 * @param {string} code - OAuth Authorization Code
 */
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

    if (!response.ok) {
      throw new Error(`Strava Token-Fehler: ${response.status}`);
    }

    const data = await response.json();

    stravaTokens = {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:    data.expires_at,
      athleteId:    data.athlete.id,
      athleteName:  `${data.athlete.firstname} ${data.athlete.lastname}`,
    };

    // Tokens in Firestore speichern
    await saveStravaTokens(stravaTokens);
    showToast(`Strava verbunden: ${stravaTokens.athleteName} 🎉`, "success");
    await fetchAndDisplayActivities();

  } catch (err) {
    console.error("Strava Callback Fehler:", err);
    showToast("Strava-Verbindung fehlgeschlagen.", "error");
    showConnectButton();
  }
}

// ── Token-Management ───────────────────────────────────────

/** Tokens aus Firestore laden */
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

/** Tokens in Firestore speichern */
async function saveStravaTokens(tokens) {
  const ref = doc(db, "users", currentUser.uid, "profile", "strava");
  await setDoc(ref, tokens);
}

/**
 * Erneuert den Access Token mit dem Refresh Token, falls abgelaufen.
 * @returns {string} Gültiger Access Token
 */
async function getValidAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  // Token ist noch gültig (5 Min. Puffer)
  if (stravaTokens.expiresAt > now + 300) {
    return stravaTokens.accessToken;
  }

  // Token erneuern
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
  stravaTokens.accessToken = data.access_token;
  stravaTokens.refreshToken = data.refresh_token;
  stravaTokens.expiresAt   = data.expires_at;

  await saveStravaTokens(stravaTokens);
  return stravaTokens.accessToken;
}

// ── Aktivitäten abrufen ────────────────────────────────────

/**
 * Ruft die letzten Aktivitäten von der Strava API ab und zeigt sie an.
 */
export async function fetchAndDisplayActivities() {
  showStravaLoading("Lade Aktivitäten…");

  try {
    const token = await getValidAccessToken();

    // Letzte 10 Aktivitäten abrufen
    const response = await fetch(
      `${STRAVA_API_BASE}/athlete/activities?per_page=10&page=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) throw new Error(`API-Fehler: ${response.status}`);

    const activities = await response.json();

    // Aktivitäten in Firestore cachen
    await cacheActivities(activities);

    // Stats berechnen und rendern
    renderStravaData(activities);

  } catch (err) {
    console.error("Fehler beim Laden der Aktivitäten:", err);
    showToast("Aktivitäten konnten nicht geladen werden.", "error");
    showConnectButton();
  }
}

/**
 * Speichert die letzten Aktivitäten in Firestore (als Cache).
 * @param {Array} activities
 */
async function cacheActivities(activities) {
  const ref = doc(db, "users", currentUser.uid, "cache", "activities");
  await setDoc(ref, {
    data:      activities.slice(0, 20),
    updatedAt: new Date().toISOString(),
  });
}

// ── Rendering ──────────────────────────────────────────────

/** Strava-Bereich initial rendern (Skeleton / Connect-Button) */
function renderStravaSection() {
  const container = document.getElementById("strava-content");
  if (!container) return;

  container.innerHTML = `
    <div class="skeleton" style="height:80px; margin-bottom:1rem;"></div>
    <div class="skeleton" style="height:60px; margin-bottom:0.5rem;"></div>
    <div class="skeleton" style="height:60px;"></div>
  `;
}

/** Connect-Button anzeigen */
function showConnectButton() {
  const container = document.getElementById("strava-content");
  if (!container) return;

  container.innerHTML = `
    <div class="strava-connect">
      <p>Verbinde dein Strava-Konto, um deine Trainingsaktivitäten zu sehen.</p>
      <button id="strava-connect-btn" class="btn btn-strava" onclick="window.stravaConnect()">
        🚴 Mit Strava verbinden
      </button>
    </div>
  `;
}

/** Lade-Indikator anzeigen */
function showStravaLoading(text = "Laden…") {
  const container = document.getElementById("strava-content");
  if (!container) return;
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.75rem;padding:1.5rem;color:var(--clr-text-muted);">
      <div class="spinner"></div>
      <span>${text}</span>
    </div>
  `;
}

/**
 * Aktivitäten-Daten rendern: Stats + Liste
 * @param {Array} activities
 */
function renderStravaData(activities) {
  const container = document.getElementById("strava-content");
  if (!container) return;

  // ── Stats berechnen ──
  const last30days = activities.filter((a) => {
    const date = new Date(a.start_date);
    return (Date.now() - date.getTime()) < 30 * 24 * 60 * 60 * 1000;
  });

  const totalKm   = last30days.reduce((s, a) => s + a.distance, 0) / 1000;
  const totalHours = last30days.reduce((s, a) => s + a.moving_time, 0) / 3600;
  const totalActs  = last30days.length;

  // ── Aktivitäts-Emoji je Typ ──
  const typeEmoji = (type) => {
    const map = { Run: "🏃", Ride: "🚴", Swim: "🏊", Walk: "🚶", Hike: "🥾" };
    return map[type] ?? "🏋️";
  };

  // ── Aktivitätsliste HTML ──
  const listHTML = activities.slice(0, 6).map((a) => `
    <div class="activity-item">
      <span class="activity-icon">${typeEmoji(a.type)}</span>
      <div class="activity-info">
        <div class="activity-name">${a.name}</div>
        <div class="activity-meta">
          ${new Date(a.start_date_local).toLocaleDateString("de-DE", { day:"2-digit", month:"short" })}
          &bull; ${Math.round(a.moving_time / 60)} Min.
        </div>
      </div>
      <span class="activity-distance">${(a.distance / 1000).toFixed(1)} km</span>
    </div>
  `).join("");

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-value">${totalKm.toFixed(0)}</div>
        <div class="stat-label">km (30 Tage)</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${totalHours.toFixed(1)}</div>
        <div class="stat-label">Stunden</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${totalActs}</div>
        <div class="stat-label">Einheiten</div>
      </div>
    </div>

    <div class="activities-list">
      ${listHTML || "<p class='text-muted' style='padding:1rem;'>Keine Aktivitäten gefunden.</p>"}
    </div>

    <div style="margin-top:1rem;display:flex;justify-content:flex-end;">
      <button class="btn btn-secondary" onclick="window.stravaSync()" style="font-size:0.8125rem;padding:0.5rem 1rem;">
        🔄 Aktualisieren
      </button>
    </div>
  `;
}

// Globale Funktionen für onclick-Handler (da kein Bundler)
window.stravaConnect = connectToStrava;
window.stravaSync    = fetchAndDisplayActivities;
