// ============================================================
// js/gemini.js
// Gemini API – KI-gestützter Trainingsplan Generator
// ============================================================
// Ablauf:
// 1. Aktuellen Trainingsplan aus Firestore laden
// 2. Strava-Aktivitäten der letzten 30 Tage lesen
// 3. Kombinierten Prompt an Gemini API senden
// 4. Antwort (JSON) parsen und als neuen Plan in Firestore speichern
// 5. UI aktualisieren
// ============================================================

import { db }              from "./firebase-config.js";
import { getSecrets }      from "./config.js";
import {
  doc, getDoc, setDoc, collection, addDoc, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast }       from "./ui-helpers.js";

// ── Gemini-Konstanten ──────────────────────────────────────
// API-Key wird zur Laufzeit aus Firestore geladen (config/secrets → geminiApiKey).
// ✅ Kein Secret im Quellcode.
const GEMINI_MODEL = "gemini-1.5-flash";  // Free Tier – schnell + kostenlos

/** Gibt die vollständige Gemini-API-URL mit Key zurück. */
function getGeminiUrl() {
  const { geminiApiKey } = getSecrets();
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;
}

// ── Zustand ────────────────────────────────────────────────
let currentUser = null;
let currentPlan = null;

// ── Wochentage ─────────────────────────────────────────────
const WEEKDAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const WEEKDAY_DE = { monday:"Mo",tuesday:"Di",wednesday:"Mi",thursday:"Do",friday:"Fr",saturday:"Sa",sunday:"So" };

// ── Initialisierung ────────────────────────────────────────
/**
 * Wird nach erfolgreichem Firebase-Login aufgerufen.
 * Lädt den aktuellen Trainingsplan und rendert ihn.
 * @param {import("firebase/auth").User} user
 */
export async function initTrainingPlan(user) {
  currentUser = user;
  renderPlanSkeleton();

  const plan = await loadCurrentPlan();
  if (plan) {
    currentPlan = plan;
    renderTrainingPlan(plan);
  } else {
    renderEmptyPlan();
  }

  // AI-Button Event-Listener
  document.getElementById("ai-adjust-btn")?.addEventListener("click", adjustPlanWithAI);
}

// ── Trainingsplan aus Firestore laden ──────────────────────

/**
 * Lädt den neuesten Trainingsplan aus Firestore.
 * @returns {Object|null}
 */
async function loadCurrentPlan() {
  try {
    // Neuesten Plan aus der trainingPlans-Sammlung laden
    const plansRef = collection(db, "users", currentUser.uid, "trainingPlans");
    const q        = query(plansRef, orderBy("createdAt", "desc"), limit(1));
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      const planDoc = snapshot.docs[0];
      return { id: planDoc.id, ...planDoc.data() };
    }
    return null;
  } catch (err) {
    console.error("Fehler beim Laden des Trainingsplans:", err);
    return null;
  }
}

// ── Strava-Aktivitäten für den Prompt lesen ────────────────

/**
 * Liest gecachte Strava-Aktivitäten aus Firestore.
 * @returns {Array}
 */
async function loadCachedActivities() {
  try {
    const ref  = doc(db, "users", currentUser.uid, "cache", "activities");
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data().data ?? [] : [];
  } catch {
    return [];
  }
}

// ── KI-Plan generieren ─────────────────────────────────────

/**
 * Hauptfunktion: Sendet Kontext an Gemini und speichert den neuen Plan.
 */
async function adjustPlanWithAI() {
  // Prüfen ob Secrets verfügbar sind
  let geminiUrl;
  try {
    geminiUrl = getGeminiUrl();
  } catch (err) {
    showToast("Secrets nicht geladen – bitte erst einloggen.", "error");
    return;
  }

  const btn = document.getElementById("ai-adjust-btn");
  if (btn) btn.disabled = true;

  showAiStatus("🤖 Analysiere dein Training…");

  try {
    // Kontextdaten sammeln
    const activities = await loadCachedActivities();
    const prompt     = buildPrompt(currentPlan, activities);

    // Gemini API aufrufen
    showAiStatus("🧠 Gemini generiert deinen Plan…");
    const newPlanJSON = await callGeminiAPI(prompt, geminiUrl);

    // Plan parsen und validieren
    const newPlan = parsePlanResponse(newPlanJSON);
    if (!newPlan) throw new Error("Ungültige Plan-Struktur von Gemini");

    // Plan in Firestore speichern
    showAiStatus("💾 Speichere neuen Plan…");
    const savedPlan = await savePlan(newPlan);

    currentPlan = savedPlan;
    renderTrainingPlan(savedPlan);
    hideAiStatus();
    showToast("✅ Trainingsplan wurde von KI angepasst!", "success");

  } catch (err) {
    console.error("Gemini Fehler:", err);
    hideAiStatus();
    showToast(`KI-Anpassung fehlgeschlagen: ${err.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Prompt-Builder ─────────────────────────────────────────

/**
 * Erstellt den Gemini-Prompt aus Trainingsplan + Strava-Aktivitäten.
 * @param {Object|null} currentPlan
 * @param {Array} activities
 * @returns {string}
 */
function buildPrompt(currentPlan, activities) {
  // Aktivitäten-Zusammenfassung (letzte 2 Wochen)
  const recentActs = activities
    .filter((a) => (Date.now() - new Date(a.start_date).getTime()) < 14 * 24 * 3600 * 1000)
    .map((a) => `- ${a.type}: ${(a.distance/1000).toFixed(1)}km, ${Math.round(a.moving_time/60)}min, Herzrate: ${a.average_heartrate ?? "n/a"}bpm`)
    .join("\n");

  const currentPlanStr = currentPlan?.weekPlan
    ? JSON.stringify(currentPlan.weekPlan, null, 2)
    : "Kein bestehender Plan vorhanden.";

  return `Du bist ein erfahrener Triathlon-Coach. Analysiere die folgenden Trainingsdaten und erstelle einen optimierten Trainingsplan für die nächste Woche.

## Ziel
Ironman-Training (Wettkampf in ca. 16-20 Wochen). Disziplinen: Schwimmen (3,8km), Radfahren (180km), Laufen (42,2km).

## Strava-Aktivitäten (letzte 14 Tage)
${recentActs || "Keine Aktivitäten vorhanden."}

## Aktueller Wochenplan
${currentPlanStr}

## Aufgabe
Erstelle einen angepassten Trainingsplan für die nächste Woche. Berücksichtige:
- Erholung und Belastungssteuerung
- Progressive Überlastung (ca. +5-10% Volumen)
- Ausgewogene Verteilung aller drei Disziplinen
- Ruhetage einplanen

## Antwortformat
Antworte NUR mit einem validen JSON-Objekt (kein Markdown, keine Erklärungen):
{
  "weekPlan": {
    "monday":    { "type": "run|swim|ride|rest|brick", "duration": 60, "intensity": "easy|moderate|hard", "description": "Kurze Beschreibung" },
    "tuesday":   { ... },
    "wednesday": { ... },
    "thursday":  { ... },
    "friday":    { ... },
    "saturday":  { ... },
    "sunday":    { ... }
  },
  "coachNote": "Kurze Anmerkung des Coaches zum Plan (1-2 Sätze)"
}`;
}

// ── Gemini API aufrufen ────────────────────────────────────

/**
 * Sendet den Prompt an die Gemini REST API.
 * @param {string} prompt
 * @param {string} apiUrl  - Vollständige Gemini-URL mit Key
 * @returns {string} Roh-Antwort von Gemini
 */
async function callGeminiAPI(prompt, apiUrl) {
  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature:     0.7,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",  // Erzwingt JSON-Ausgabe
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  const response = await fetch(apiUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData?.error?.message ?? `HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error("Leere Antwort von Gemini");
  return text;
}

/**
 * Parst die JSON-Antwort von Gemini und validiert die Struktur.
 * @param {string} jsonText
 * @returns {Object|null}
 */
function parsePlanResponse(jsonText) {
  try {
    // Entferne eventuell vorhandene Markdown-Fences
    const clean = jsonText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(clean);

    if (!parsed.weekPlan) return null;

    // Stelle sicher, dass alle 7 Wochentage vorhanden sind
    const plan = { ...parsed };
    WEEKDAYS.forEach((day) => {
      if (!plan.weekPlan[day]) {
        plan.weekPlan[day] = { type: "rest", duration: 0, intensity: "easy", description: "Ruhetag" };
      }
    });

    return plan;
  } catch (err) {
    console.error("JSON-Parse-Fehler:", err, jsonText);
    return null;
  }
}

// ── Firestore speichern ────────────────────────────────────

/**
 * Speichert den neuen Trainingsplan in Firestore.
 * @param {Object} plan
 * @returns {Object} Plan mit generierter ID
 */
async function savePlan(plan) {
  const plansRef = collection(db, "users", currentUser.uid, "trainingPlans");
  const docRef   = await addDoc(plansRef, {
    ...plan,
    ownerId:      currentUser.uid,
    createdAt:    new Date().toISOString(),
    aiGenerated:  true,
  });

  return { id: docRef.id, ...plan };
}

// ── Rendering ──────────────────────────────────────────────

/** Aktivitäts-Icon je Typ */
function typeIcon(type) {
  const icons = {
    run:   "🏃",
    swim:  "🏊",
    ride:  "🚴",
    brick: "🏊🚴",
    rest:  "😴",
  };
  return icons[type?.toLowerCase()] ?? "🏋️";
}

/** Intensitäts-Farbe */
function intensityColor(intensity) {
  const colors = { easy: "var(--clr-green)", moderate: "var(--clr-accent-2)", hard: "var(--clr-accent)" };
  return colors[intensity?.toLowerCase()] ?? "var(--clr-text-muted)";
}

/** Wochenplan rendern */
function renderTrainingPlan(plan) {
  const weekContainer = document.getElementById("week-plan-grid");
  const coachNote     = document.getElementById("coach-note");
  const planMeta      = document.getElementById("plan-meta");

  if (!weekContainer) return;

  // Heutigen Wochentag ermitteln
  const todayIndex = (new Date().getDay() + 6) % 7; // 0=Mo, 6=So

  const daysHTML = WEEKDAYS.map((day, i) => {
    const session = plan.weekPlan?.[day] ?? { type: "rest", duration: 0, intensity: "easy", description: "Ruhetag" };
    const isToday = i === todayIndex;
    const isRest  = session.type === "rest";

    return `
      <div class="day-card ${isToday ? "today" : ""} ${isRest ? "rest" : ""}">
        <div class="day-name">${WEEKDAY_DE[day]}</div>
        <div class="day-icon">${typeIcon(session.type)}</div>
        <div class="day-type" style="color:${intensityColor(session.intensity)}">
          ${session.type?.toUpperCase() ?? "REST"}
        </div>
        <div class="day-duration">${session.duration ? `${session.duration} Min.` : "–"}</div>
      </div>
    `;
  }).join("");

  weekContainer.innerHTML = daysHTML;

  // Coach-Notiz
  if (coachNote && plan.coachNote) {
    coachNote.textContent = plan.coachNote;
    coachNote.closest(".coach-note-box")?.classList.remove("hidden");
  }

  // Plan-Datum
  if (planMeta && plan.createdAt) {
    const date = new Date(plan.createdAt).toLocaleDateString("de-DE", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    planMeta.innerHTML = `<span>🤖</span> KI-Plan vom ${date}`;
  }
}

/** Leerer Plan-Zustand */
function renderEmptyPlan() {
  const weekContainer = document.getElementById("week-plan-grid");
  if (!weekContainer) return;

  weekContainer.innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--clr-text-muted);">
      <p style="font-size:2rem;margin-bottom:0.5rem;">🤖</p>
      <p>Noch kein Trainingsplan vorhanden.<br>Klicke auf "Plan von KI anpassen lassen" um zu starten.</p>
    </div>
  `;
}

/** Skeleton-Loader für den Plan */
function renderPlanSkeleton() {
  const weekContainer = document.getElementById("week-plan-grid");
  if (!weekContainer) return;

  weekContainer.innerHTML = Array(7).fill(0).map(() => `
    <div class="day-card">
      <div class="skeleton" style="height:12px;width:60%;margin:0 auto 0.5rem;"></div>
      <div class="skeleton" style="height:32px;width:40%;margin:0 auto 0.5rem;border-radius:50%;"></div>
      <div class="skeleton" style="height:12px;width:70%;margin:0 auto;"></div>
    </div>
  `).join("");
}

/** KI-Status-Box anzeigen */
function showAiStatus(text) {
  const el = document.getElementById("ai-status");
  if (!el) return;
  el.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
  el.classList.remove("hidden");
}

/** KI-Status-Box verstecken */
function hideAiStatus() {
  document.getElementById("ai-status")?.classList.add("hidden");
}
