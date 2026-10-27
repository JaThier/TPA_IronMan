// ============================================================
// js/gemini.js
// Gemini API – KI-gestützter Trainingsplan Generator mit konfigurierbarem Analyse-Zeitraum
// ============================================================

import { db }              from "./firebase-config.js";
import { getSecrets }      from "./config.js";
import {
  doc, getDoc, setDoc, collection, addDoc, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast }       from "./ui-helpers.js";

// ── Gemini-Konstanten ──────────────────────────────────────
const GEMINI_MODEL = "gemini-1.5-flash";  // Free Tier – schnell + kostenlos

function getGeminiUrl() {
  const { geminiApiKey } = getSecrets();
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;
}

// ── Zustand ────────────────────────────────────────────────
let currentUser         = null;
let currentPlan         = null;
let aiTimeframeDays     = 30; // Standard: 30 Tage

// ── Wochentage ─────────────────────────────────────────────
const WEEKDAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const WEEKDAY_DE = { monday:"Mo", tuesday:"Di", wednesday:"Mi", thursday:"Do", friday:"Fr", saturday:"Sa", sunday:"So" };

// ── Initialisierung ────────────────────────────────────────
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

  // Setup Event-Listener
  setupTimeframeListeners();
  document.getElementById("ai-adjust-btn")?.addEventListener("click", adjustPlanWithAI);

  // Vorschau-Zähler für Aktivitäten aktualisieren
  updateActivityCountPreview();
}

/** Richtet die Listener für den konfigurierbaren Analyse-Zeitraum ein */
function setupTimeframeListeners() {
  const select = document.getElementById("ai-timeframe-select");
  const customBox = document.getElementById("ai-custom-timeframe-box");
  const customVal = document.getElementById("ai-custom-val");
  const customUnit = document.getElementById("ai-custom-unit");

  select?.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      customBox?.classList.remove("hidden");
    } else {
      customBox?.classList.add("hidden");
      aiTimeframeDays = parseInt(e.target.value, 10);
      updateActivityCountPreview();
    }
  });

  const onCustomChange = () => {
    const val = parseInt(customVal?.value, 10) || 30;
    const unit = customUnit?.value || "days";
    aiTimeframeDays = unit === "weeks" ? val * 7 : val;
    updateActivityCountPreview();
  };

  customVal?.addEventListener("input", onCustomChange);
  customUnit?.addEventListener("change", onCustomChange);
}

/** Aktualisiert den Text, wie viele Aktivitäten in dem gewählten Zeitraum einbezogen werden */
async function updateActivityCountPreview() {
  const infoEl = document.getElementById("ai-timeframe-info");
  if (!infoEl) return;

  const activities = await loadCachedActivities();
  const cutoff = Date.now() - (aiTimeframeDays * 24 * 3600 * 1000);
  const cutoffDateStr = new Date(cutoff).toLocaleDateString("de-DE", {
    day: "2-digit", month: "short", year: "numeric"
  });

  const matchingActs = activities.filter(a => new Date(a.start_date).getTime() >= cutoff);
  const totalKm = matchingActs.reduce((s, a) => s + (a.distance || 0), 0) / 1000;

  infoEl.innerHTML = `
    🔍 Es werden <strong>${matchingActs.length} Aktivitäten</strong> seit dem <strong>${cutoffDateStr}</strong> 
    (Gesamt: ${totalKm.toFixed(1)} km) in die KI-Planung einbezogen.
  `;
}

// ── Trainingsplan aus Firestore laden ──────────────────────
async function loadCurrentPlan() {
  try {
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
async function adjustPlanWithAI() {
  let geminiUrl;
  try {
    geminiUrl = getGeminiUrl();
  } catch (err) {
    showToast("Secrets nicht geladen – bitte erst einloggen.", "error");
    return;
  }

  const btn = document.getElementById("ai-adjust-btn");
  if (btn) btn.disabled = true;

  showAiStatus(`🤖 Analysiere deine Einheiten der letzten ${aiTimeframeDays} Tage…`);

  try {
    // 1. Aktivitäten laden und nach gewähltem Zeitraum filtern
    const allActs = await loadCachedActivities();
    const cutoff = Date.now() - (aiTimeframeDays * 24 * 3600 * 1000);
    const filteredActs = allActs.filter(a => new Date(a.start_date).getTime() >= cutoff);

    // 2. Prompt bauen mit den gefilterten Aktivitäten
    const prompt = buildPrompt(currentPlan, filteredActs, aiTimeframeDays);

    // 3. Gemini API aufrufen
    showAiStatus("🧠 Gemini erstellt deinen personalisierten Trainingsplan…");
    const newPlanJSON = await callGeminiAPI(prompt, geminiUrl);

    // 4. Plan parsen und validieren
    const newPlan = parsePlanResponse(newPlanJSON);
    if (!newPlan) throw new Error("Ungültige Plan-Struktur von Gemini");

    // 5. Plan in Firestore speichern
    showAiStatus("💾 Speichere neuen Plan in Firestore…");
    const savedPlan = await savePlan({
      ...newPlan,
      analyzedTimeframeDays: aiTimeframeDays,
      analyzedActivitiesCount: filteredActs.length,
    });

    currentPlan = savedPlan;
    renderTrainingPlan(savedPlan);
    hideAiStatus();
    showToast(`✅ Trainingsplan erfolgreich angepasst (${filteredActs.length} Einheiten analysiert)!`, "success");

  } catch (err) {
    console.error("Gemini Fehler:", err);
    hideAiStatus();
    showToast(`KI-Anpassung fehlgeschlagen: ${err.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Prompt-Builder ─────────────────────────────────────────
function buildPrompt(currentPlan, activities, timeframeDays) {
  const cutoffDate = new Date(Date.now() - (timeframeDays * 24 * 3600 * 1000));
  const dateStr = cutoffDate.toLocaleDateString("de-DE");

  const actsSummary = activities.map((a) => {
    const km = (a.distance / 1000).toFixed(1);
    const mins = Math.round(a.moving_time / 60);
    const hr = a.average_heartrate ? `, Ø Puls: ${Math.round(a.average_heartrate)}` : "";
    const hm = a.total_elevation_gain ? `, Höhenmeter: ↑${Math.round(a.total_elevation_gain)}m` : "";
    return `- ${a.type} (${new Date(a.start_date_local).toLocaleDateString("de-DE")}): ${km} km, ${mins} Min${hr}${hm}`;
  }).join("\n");

  const currentPlanStr = currentPlan?.weekPlan
    ? JSON.stringify(currentPlan.weekPlan, null, 2)
    : "Kein bestehender Plan vorhanden.";

  return `Du bist ein erfahrener Triathlon-Coach (Ironman-Spezialist). Analysiere die Trainingshistorie des Athleten und erstelle einen optimierten Wochenplan für die kommende Woche.

## Ziel
Ironman-Vorbereitung. Disziplinen: Schwimmen (3,8 km), Radfahren (180 km), Laufen (42,2 km).

## Trainings-Historie (letzte ${timeframeDays} Tage, seit ${dateStr})
Anzahl analysierter Einheiten: ${activities.length}
${actsSummary || "Keine Strava-Aktivitäten in diesem Zeitraum gefunden. Erstelle einen soliden Einstiegsplan."}

## Aktueller Wochenplan
${currentPlanStr}

## Trainingsprinzipien
1. Belastungssteuerung: Achte auf Ruhetage und Erholung zwischen intensiven Einheiten.
2. Progressive Überlastung: Steigere das Volumen moderat (+5% bis +10%) gegenüber der letzten Woche, wenn der Athlet gut trainiert hat.
3. Triathlon-Spezifisch: Mindestens 1 Koppeleinheit (Brick: Rad + kurzer Lauf) am Wochenende einplanen.

## WICHTIG: Antwortformat
Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt ohne Markdown-Codeblöcke (\`\`\`json) und ohne zusätzlichen Text davor oder danach:
{
  "weekPlan": {
    "monday":    { "type": "swim|ride|run|rest|brick", "duration": 60, "intensity": "easy|moderate|hard", "description": "Kurze genaue Einheit-Beschreibung" },
    "tuesday":   { "type": "run", "duration": 75, "intensity": "easy", "description": "..." },
    "wednesday": { "type": "ride", "duration": 90, "intensity": "moderate", "description": "..." },
    "thursday":  { "type": "rest", "duration": 0, "intensity": "easy", "description": "Aktive Erholung" },
    "friday":    { "type": "swim", "duration": 45, "intensity": "hard", "description": "..." },
    "saturday":  { "type": "brick", "duration": 180, "intensity": "moderate", "description": "..." },
    "sunday":    { "type": "run", "duration": 120, "intensity": "easy", "description": "Langer Lauf" }
  },
  "coachNote": "Persönliche Analyse und Begründung des Coaches für diese Woche."
}`;
}

// ── Gemini API Call ────────────────────────────────────────
async function callGeminiAPI(prompt, geminiUrl) {
  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
    }
  };

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Leere Antwort von Gemini erhalten.");

  return text;
}

function parsePlanResponse(rawText) {
  try {
    // Eventuelle Markdown-Codeblocks entfernen
    const cleaned = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    if (!parsed.weekPlan) return null;
    return parsed;
  } catch (err) {
    console.error("JSON Parse-Fehler von Gemini:", err, rawText);
    return null;
  }
}

async function savePlan(planData) {
  const plansRef = collection(db, "users", currentUser.uid, "trainingPlans");
  const docRef   = await addDoc(plansRef, {
    ...planData,
    ownerId:     currentUser.uid,
    createdAt:   new Date().toISOString(),
    aiGenerated: true,
  });

  return { id: docRef.id, ...planData };
}

// ── Rendering des Wochenplans ──────────────────────────────
function renderTrainingPlan(plan) {
  const weekContainer = document.getElementById("week-plan-grid");
  const coachNoteBox  = document.getElementById("coach-note-box");
  const coachNote     = document.getElementById("coach-note");
  const planMeta      = document.getElementById("plan-meta");

  if (!weekContainer) return;

  if (planMeta) {
    const dateStr = plan.createdAt
      ? new Date(plan.createdAt).toLocaleDateString("de-DE", {
          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
        })
      : "Starter";
    planMeta.textContent = `${plan.aiGenerated ? '🤖 KI-optimiert' : '📋 Starter-Plan'} • ${dateStr}`;
  }

  if (plan.coachNote && coachNote && coachNoteBox) {
    coachNote.textContent = plan.coachNote;
    coachNoteBox.classList.remove("hidden");
  } else if (coachNoteBox) {
    coachNoteBox.classList.add("hidden");
  }

  const week = plan.weekPlan || {};
  weekContainer.innerHTML = WEEKDAYS.map((dayKey) => {
    const day = week[dayKey] || { type: "rest", duration: 0, description: "Ruhetag", intensity: "easy" };
    const icon = typeIcon(day.type);
    const dayLabel = WEEKDAY_DE[dayKey] || dayKey;
    const isRest = day.type === "rest";

    return `
      <div class="day-card ${isRest ? 'day-rest' : ''}">
        <div class="day-card-header">
          <span class="day-name">${dayLabel}</span>
          <span class="day-icon">${icon}</span>
        </div>
        <div class="day-body">
          <div class="day-type-badge badge-${(day.type || 'other').toLowerCase()}">
            ${day.type?.toUpperCase()}
          </div>
          <div class="day-duration">${day.duration > 0 ? `${day.duration} Min.` : 'Ruhetag'}</div>
          <p class="day-desc">${escapeHtml(day.description || "")}</p>
        </div>
        <div class="day-intensity-bar intensity-${day.intensity || 'easy'}"></div>
      </div>
    `;
  }).join("");
}

function renderEmptyPlan() {
  const weekContainer = document.getElementById("week-plan-grid");
  if (!weekContainer) return;

  weekContainer.innerHTML = `
    <div class="empty-plan-card">
      <span>📋</span>
      <h3>Noch kein Trainingsplan vorhanden</h3>
      <p>Klicke unten auf "Plan von KI anpassen lassen", um deinen ersten personalisierten Ironman-Plan zu erstellen.</p>
    </div>
  `;
}

function renderPlanSkeleton() {
  const weekContainer = document.getElementById("week-plan-grid");
  if (!weekContainer) return;

  weekContainer.innerHTML = Array(7).fill(0).map(() => `
    <div class="day-card"><div class="skeleton" style="height:120px;"></div></div>
  `).join("");
}

function showAiStatus(text) {
  const el = document.getElementById("ai-status");
  if (!el) return;
  el.classList.remove("hidden");
  el.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
}

function hideAiStatus() {
  const el = document.getElementById("ai-status");
  if (!el) return;
  el.classList.add("hidden");
  el.innerHTML = "";
}

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

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
