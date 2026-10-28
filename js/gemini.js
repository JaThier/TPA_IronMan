// ============================================================
// js/gemini.js
// Gemini API – KI-gestützter Trainingsplan Generator mit konfigurierbarem Analyse-Zeitraum
// ============================================================

import { db, auth }        from "./firebase-config.js";
import { getSecrets }      from "./config.js";
import {
  doc, getDoc, setDoc, collection, addDoc, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast }       from "./ui-helpers.js";

// ── Gemini-Konstanten & Modell-Prioritäten ──────────────────
const PREFERRED_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.8-pro",
  "gemini-3.0-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-002",
  "gemini-1.5-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-pro",
];

let cachedWorkingModel = null;

/**
 * Ermittelt dynamisch das beste verfügbare Modell via ModelService.ListModels.
 */
async function getBestAvailableModel(apiKey) {
  if (cachedWorkingModel) return cachedWorkingModel;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      const available = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""));

      console.log("[gemini] Verfügbare Modelle für API-Key:", available);

      for (const pref of PREFERRED_MODELS) {
        if (available.includes(pref)) {
          cachedWorkingModel = pref;
          console.log(`[gemini] Wähle Modell: ${pref}`);
          return pref;
        }
      }

      const flashModel = available.find(m => m.includes("flash"));
      if (flashModel) {
        cachedWorkingModel = flashModel;
        console.log(`[gemini] Wähle alternatives Flash-Modell: ${flashModel}`);
        return flashModel;
      }

      if (available.length > 0) {
        cachedWorkingModel = available[0];
        console.log(`[gemini] Wähle erstes verfügbares Modell: ${available[0]}`);
        return available[0];
      }
    } else {
      console.warn("[gemini] Konnte Modell-Liste nicht abrufen (HTTP " + res.status + ")");
    }
  } catch (err) {
    console.warn("[gemini] Fehler beim Ermitteln der Modell-Liste:", err);
  }

  // Standard-Fallback
  return "gemini-3.8-flash";
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
  currentUser = user || auth?.currentUser;
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

  // Synchronisation bei externen Updates (z. B. durch manuelles Bearbeiten im Konto-Tab)
  window.addEventListener("planUpdated", (e) => {
    if (e.detail) {
      currentPlan = e.detail;
      renderTrainingPlan(currentPlan);
    }
  });

  // Vorschau-Zähler für Aktivitäten aktualisieren
  await updateActivityCountPreview();
}

/** Richtet die Listener für den konfigurierbaren Analyse-Zeitraum ein */
function setupTimeframeListeners() {
  const select = document.getElementById("ai-timeframe-select");
  const customBox = document.getElementById("ai-custom-timeframe-box");
  const customVal = document.getElementById("ai-custom-val");
  const customUnit = document.getElementById("ai-custom-unit");

  // Initialen Wert aus dem Dropdown übernehmen falls bereits gesetzt
  if (select && select.value !== "custom") {
    aiTimeframeDays = parseInt(select.value, 10) || aiTimeframeDays;
  }

  select?.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      customBox?.classList.remove("hidden");
    } else {
      customBox?.classList.add("hidden");
      aiTimeframeDays = parseInt(e.target.value, 10) || 30;
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
export async function updateActivityCountPreview() {
  const infoEl = document.getElementById("ai-timeframe-info");
  if (!infoEl) return;

  try {
    const select = document.getElementById("ai-timeframe-select");
    if (select && select.value !== "custom") {
      aiTimeframeDays = parseInt(select.value, 10) || aiTimeframeDays || 30;
    }

    const activities = await loadCachedActivities();
    const cutoff = Date.now() - (aiTimeframeDays * 24 * 3600 * 1000);
    const cutoffDateStr = new Date(cutoff).toLocaleDateString("de-DE", {
      day: "2-digit", month: "short", year: "numeric"
    });

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      infoEl.innerHTML = `
        ℹ️ Noch keine Aktivitäten geladen. Verbinde Strava oder synchronisiere deine Einheiten im Tab <em>Aktivitäten</em>.
      `;
      return;
    }

    const matchingActs = activities.filter(a => {
      if (!a) return false;
      const d = new Date(a.start_date || a.start_date_local || 0).getTime();
      return !isNaN(d) && d >= cutoff;
    });

    const totalKm = matchingActs.reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000;

    infoEl.innerHTML = `
      🔍 Es werden <strong>${matchingActs.length} Aktivitäten</strong> seit dem <strong>${cutoffDateStr}</strong> 
      (Gesamt: ${totalKm.toFixed(1)} km) in die KI-Planung einbezogen.
    `;
  } catch (err) {
    console.error("[gemini] Fehler beim Berechnen der Aktivitäts-Vorschau:", err);
    infoEl.innerHTML = `⚠️ Vorschau konnte nicht berechnet werden.`;
  }
}

// Global für andere Module (z.B. strava.js) bereitstellen
window.updateAiPreview = updateActivityCountPreview;

// ── Trainingsplan aus Firestore laden ──────────────────────
async function loadCurrentPlan() {
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return null;

  try {
    const plansRef = collection(db, "users", user.uid, "trainingPlans");
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
  // 1. Erst in-memory Strava-Aktivitäten prüfen (aus strava.js)
  if (Array.isArray(window.stravaActivities) && window.stravaActivities.length > 0) {
    return window.stravaActivities;
  }

  // 2. Fallback: Aus Firestore Cache laden
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return [];

  try {
    const ref  = doc(db, "users", user.uid, "cache", "activities");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const raw = snap.data()?.data;
      if (Array.isArray(raw)) {
        window.stravaActivities = raw;
        return raw;
      } else if (raw && typeof raw === "object") {
        const arr = Object.values(raw);
        window.stravaActivities = arr;
        return arr;
      }
    }
    return [];
  } catch (err) {
    console.warn("[gemini] Konnte gecachte Aktivitäten nicht laden:", err);
    return [];
  }
}

// ── KI-Plan generieren ─────────────────────────────────────
async function adjustPlanWithAI() {
  let geminiApiKey;
  try {
    const secrets = getSecrets();
    geminiApiKey = secrets?.geminiApiKey;
    if (!geminiApiKey) throw new Error("Kein Gemini API-Key vorhanden.");
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
    const filteredActs = allActs.filter(a => {
      if (!a) return false;
      const d = new Date(a.start_date || a.start_date_local || 0).getTime();
      return !isNaN(d) && d >= cutoff;
    });

    // 2. Prompt bauen mit den gefilterten Aktivitäten
    const prompt = buildPrompt(currentPlan, filteredActs, aiTimeframeDays);

    // 3. Gemini API aufrufen
    showAiStatus("🧠 Gemini erstellt deinen personalisierten Trainingsplan…");
    const newPlanJSON = await callGeminiAPI(prompt, geminiApiKey);

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
    const km = ((parseFloat(a.distance) || 0) / 1000).toFixed(1);
    const mins = Math.round((parseFloat(a.moving_time) || 0) / 60);
    const hr = a.average_heartrate ? `, Ø Puls: ${Math.round(a.average_heartrate)}` : "";
    const hm = a.total_elevation_gain ? `, Höhenmeter: ↑${Math.round(a.total_elevation_gain)}m` : "";
    const dateStr = new Date(a.start_date_local || a.start_date || Date.now()).toLocaleDateString("de-DE");
    return `- ${a.type || 'Aktivität'} (${dateStr}): ${km} km, ${mins} Min${hr}${hm}`;
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
4. Halte die Beschreibungen fokussiert und präzise (1-2 Sätze je Einheit).

## WICHTIG: Antwortformat
Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt ohne Markdown-Codeblöcke (\`\`\`json) und ohne zusätzlichen Text davor oder danach:
{
  "weekPlan": {
    "monday":    { "type": "swim|ride|run|rest|brick", "duration": 60, "intensity": "easy|moderate|hard", "description": "Präzise Beschreibung der Einheit (1-2 Sätze)" },
    "tuesday":   { "type": "run", "duration": 75, "intensity": "easy", "description": "..." },
    "wednesday": { "type": "ride", "duration": 90, "intensity": "moderate", "description": "..." },
    "thursday":  { "type": "rest", "duration": 0, "intensity": "easy", "description": "Aktive Erholung" },
    "friday":    { "type": "swim", "duration": 45, "intensity": "hard", "description": "..." },
    "saturday":  { "type": "brick", "duration": 180, "intensity": "moderate", "description": "..." },
    "sunday":    { "type": "run", "duration": 120, "intensity": "easy", "description": "Langer Lauf" }
  },
  "coachNote": "Persönliche Analyse und Begründung des Coaches für diese Woche (2-3 Sätze)."
}`;
}

// ── Gemini API Call ────────────────────────────────────────
async function callGeminiAPI(prompt, apiKey) {
  const model = await getBestAvailableModel(apiKey);
  console.log(`[gemini] Sende Request an Modell: ${model}`);

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  // Falls das gewählte Modell 404 liefert, Fallback-Kette durchprobieren
  if (!response.ok && response.status === 404) {
    console.warn(`[gemini] Modell ${model} schlug mit 404 fehl, durchsuche Fallback-Modelle...`);
    cachedWorkingModel = null;

    // Zuerst prüfen, ob Google direkt ein Ersatz-Modell in der Fehlermeldung nennt
    const errData = await response.clone().json().catch(() => ({}));
    const errMsg = errData.error?.message || "";
    const match = errMsg.match(/use\s+(?:models\/)?([a-zA-Z0-9.\-_]+)/i);
    const suggestedModel = match ? match[1] : null;

    if (suggestedModel && suggestedModel !== model) {
      console.log(`[gemini] Google empfiehlt Modell '${suggestedModel}', versuche Direktaufruf...`);
      const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${suggestedModel}:generateContent?key=${apiKey}`;
      const directRes = await fetch(directUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (directRes.ok) {
        console.log(`[gemini] Erfolgreich auf empfohlenes Modell ${suggestedModel} umgeschaltet.`);
        cachedWorkingModel = suggestedModel;
        response = directRes;
      }
    }

    if (!response.ok) {
      for (const fallbackModel of PREFERRED_MODELS) {
        if (fallbackModel === model || fallbackModel === suggestedModel) continue;
        const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent?key=${apiKey}`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (fallbackRes.ok) {
          console.log(`[gemini] Erfolgreich auf Fallback-Modell ${fallbackModel} ausgewichen.`);
          cachedWorkingModel = fallbackModel;
          response = fallbackRes;
          break;
        }
      }
    }
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error("Leere Antwort von Gemini erhalten.");

  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    console.warn(`[gemini] finishReason: ${candidate.finishReason}`);
  }

  // Alle Text-Parts zusammenführen (Thought-Parts überspringen)
  const text = (candidate.content?.parts || [])
    .filter(p => !p.thought)
    .map(p => p.text || "")
    .join("");

  if (!text) throw new Error("Kein Text in der Gemini-Antwort gefunden.");

  return text;
}

function parsePlanResponse(rawText) {
  try {
    // Eventuelle Markdown-Codeblocks entfernen
    let cleaned = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    // Nur das JSON-Objekt zwischen der ersten { und letzten } extrahieren
    const firstBrace = cleaned.indexOf("{");
    const lastBrace  = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(cleaned);
    if (!parsed.weekPlan) return null;
    return parsed;
  } catch (err) {
    console.error("JSON Parse-Fehler von Gemini:", err, rawText);
    return null;
  }
}

async function savePlan(planData) {
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) throw new Error("Nicht eingeloggt");

  const plansRef = collection(db, "users", user.uid, "trainingPlans");
  const docRef   = await addDoc(plansRef, {
    ...planData,
    ownerId:     user.uid,
    createdAt:   new Date().toISOString(),
    aiGenerated: true,
  });

  const savedPlan = { id: docRef.id, ...planData, ownerId: user.uid, createdAt: new Date().toISOString(), aiGenerated: true };
  window.dispatchEvent(new CustomEvent("planUpdated", { detail: savedPlan }));
  return savedPlan;
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
      : "Aktuell";
    const originLabel = plan.aiGenerated ? '🤖 KI-optimiert' : '✏️ Manuell angepasst';
    planMeta.textContent = `${originLabel} • ${dateStr}`;
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

    // Subtype-Pills falls vorhanden
    let subtypesHtml = "";
    if (Array.isArray(day.subtypes) && day.subtypes.length > 0) {
      subtypesHtml = `<div class="day-subtype-pills">${day.subtypes.map(s => `<span class="subtype-pill">${escapeHtml(s)}</span>`).join("")}</div>`;
    }

    // Metriken (Dauer, Distanz, Speed/Pace)
    const metricsParts = [];
    metricsParts.push(`⏱️ ${day.duration > 0 ? `${day.duration} Min.` : 'Ruhetag'}`);
    if (day.distance) metricsParts.push(`📍 ${day.distance} km`);
    if (day.speed) metricsParts.push(`⚡ ${escapeHtml(day.speed)}`);

    const noteOrDesc = day.notes || day.description || "";

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
          ${subtypesHtml}
          <div class="day-duration">${metricsParts.join(" &bull; ")}</div>
          ${noteOrDesc ? `<p class="day-desc">${escapeHtml(noteOrDesc)}</p>` : ''}
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
