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
  document.getElementById("ai-feedback-btn")?.addEventListener("click", analyzePlanWithAI);
  document.getElementById("ai-feedback-close-btn")?.addEventListener("click", () => {
    document.getElementById("ai-feedback-card")?.classList.add("hidden");
  });

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

// ── KI-Plan Feedback & Analyse ────────────────────────────
async function analyzePlanWithAI() {
  let geminiApiKey;
  try {
    const secrets = getSecrets();
    geminiApiKey = secrets?.geminiApiKey;
    if (!geminiApiKey) throw new Error("Kein Gemini API-Key vorhanden.");
  } catch (err) {
    showToast("Secrets nicht geladen – bitte erst einloggen.", "error");
    return;
  }

  if (!currentPlan?.weekPlan || Object.keys(currentPlan.weekPlan).length === 0) {
    showToast("Bitte erstelle oder lade zuerst einen Trainingsplan (oder lasse einen von der KI anpassen), bevor du eine Analyse anforderst.", "warning");
    return;
  }

  const btn = document.getElementById("ai-feedback-btn");
  if (btn) btn.disabled = true;

  showAiStatus(`🔍 Analysiere deinen aktuellen Trainingsplan gegen Aktivitäten der letzten ${aiTimeframeDays} Tage…`);

  try {
    // 1. Aktivitäten laden und nach gewähltem Zeitraum filtern
    const allActs = await loadCachedActivities();
    const cutoff = Date.now() - (aiTimeframeDays * 24 * 3600 * 1000);
    const filteredActs = allActs.filter(a => {
      if (!a) return false;
      const d = new Date(a.start_date || a.start_date_local || 0).getTime();
      return !isNaN(d) && d >= cutoff;
    });

    // 2. Prompt für Feedback bauen
    const prompt = buildFeedbackPrompt(currentPlan, filteredActs, aiTimeframeDays);

    // 3. Gemini API aufrufen
    showAiStatus("🧠 Gemini Headcoach wertet deinen Plan aus und formuliert Feedback…");
    const feedbackJSON = await callGeminiAPI(prompt, geminiApiKey);

    // 4. Feedback parsen
    const feedbackData = parseFeedbackResponse(feedbackJSON);
    if (!feedbackData) throw new Error("Ungültiges Feedback-Format von Gemini erhalten");

    // 5. Feedback in der UI rendern
    renderPlanFeedback(feedbackData, aiTimeframeDays, filteredActs.length);

    // 6. Feedback-Card einblenden und sanft dorthin scrollen
    const card = document.getElementById("ai-feedback-card");
    if (card) {
      card.classList.remove("hidden");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    hideAiStatus();
    showToast(`✅ Feedback zum Trainingsplan erfolgreich erstellt (${filteredActs.length} Einheiten analysiert)!`, "success");

  } catch (err) {
    console.error("Gemini Feedback Fehler:", err);
    hideAiStatus();
    showToast(`KI-Feedback fehlgeschlagen: ${err.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Formatierung für Feedback-Prompt ───────────────────────
function formatPlanForFeedbackPrompt(plan) {
  if (!plan?.weekPlan) return "Kein bestehender Plan vorhanden.";
  const week = plan.weekPlan;
  return WEEKDAYS.map(dayKey => {
    const day = week[dayKey];
    const dayLabel = WEEKDAY_DE[dayKey] || dayKey;
    if (!day || day.type === "rest") {
      const note = day?.notes || day?.description;
      return `${dayLabel}: Ruhetag${note ? ` (${note})` : ""}`;
    }

    const typeStr = (day.type || "Aktivität").toUpperCase();
    const metaParts = [];
    if (Array.isArray(day.subtypes) && day.subtypes.length > 0) {
      metaParts.push(`Arten: ${day.subtypes.join(", ")}`);
    }
    if (day.duration) metaParts.push(`Dauer: ${day.duration} Min`);
    if (day.distance) metaParts.push(`Distanz: ${day.distance} km`);
    if (day.speed) metaParts.push(`Tempo: ${day.speed}`);
    if (day.intensity) metaParts.push(`Intensität: ${day.intensity}`);

    let text = `${dayLabel}: ${typeStr} (${metaParts.join(" • ")})`;
    const note = day.notes || day.description;
    if (note) text += `\n  Notiz/Fokus: ${note}`;

    if (Array.isArray(day.parts) && day.parts.length > 1) {
      const partsDetail = day.parts.map(p =>
        `    - Teil "${p.label || p.type}": ${p.duration || 0} Min${p.distance ? `, ${p.distance} km` : ""}${p.speed ? `, Pace ${p.speed}` : ""}${p.intensity ? `, Intensität ${p.intensity}` : ""}`
      ).join("\n");
      text += `\n  Aufteilung in Abschnitte:\n${partsDetail}`;
    }

    return text;
  }).join("\n");
}

function formatActivitiesForFeedbackPrompt(activities, timeframeDays) {
  if (!activities || activities.length === 0) {
    return `Keine Strava-Aktivitäten in den letzten ${timeframeDays} Tagen gefunden.`;
  }

  let swimKm = 0, swimMins = 0, swimCount = 0;
  let bikeKm = 0, bikeMins = 0, bikeCount = 0;
  let runKm  = 0, runMins  = 0, runCount  = 0;
  let otherMins = 0, otherCount = 0;
  let maxBikeKm = 0, maxRunKm = 0;

  activities.forEach(a => {
    const type = (a.type || "").toLowerCase();
    const km = (parseFloat(a.distance) || 0) / 1000;
    const mins = Math.round((parseFloat(a.moving_time) || 0) / 60);

    if (type.includes("swim")) {
      swimCount++;
      swimKm += km;
      swimMins += mins;
    } else if (type.includes("ride") || type.includes("bike")) {
      bikeCount++;
      bikeKm += km;
      bikeMins += mins;
      if (km > maxBikeKm) maxBikeKm = km;
    } else if (type.includes("run")) {
      runCount++;
      runKm += km;
      runMins += mins;
      if (km > maxRunKm) maxRunKm = km;
    } else {
      otherCount++;
      otherMins += mins;
    }
  });

  const totalHours = ((swimMins + bikeMins + runMins + otherMins) / 60).toFixed(1);
  const totalKm = (swimKm + bikeKm + runKm).toFixed(1);

  const listExcerpt = activities.slice(0, 20).map(a => {
    const km = ((parseFloat(a.distance) || 0) / 1000).toFixed(1);
    const mins = Math.round((parseFloat(a.moving_time) || 0) / 60);
    const hr = a.average_heartrate ? `, Ø Puls: ${Math.round(a.average_heartrate)}` : "";
    const dateStr = new Date(a.start_date_local || a.start_date || Date.now()).toLocaleDateString("de-DE");
    return `  - ${a.type || 'Aktivität'} (${dateStr}): ${km} km, ${mins} Min${hr}`;
  }).join("\n");

  return `Volumen & Einheiten der letzten ${timeframeDays} Tage:
- Gesamt: ${activities.length} Einheiten, ~${totalHours} Stunden, ${totalKm} km
- 🏊 Schwimmen: ${swimCount} Einheiten, ${(swimKm * 1000).toFixed(0)} m (${(swimMins / 60).toFixed(1)} Std.)
- 🚴 Radfahren: ${bikeCount} Einheiten, ${bikeKm.toFixed(1)} km (${(bikeMins / 60).toFixed(1)} Std.)${maxBikeKm > 0 ? `, Längste Fahrt: ${maxBikeKm.toFixed(1)} km` : ''}
- 🏃 Laufen: ${runCount} Einheiten, ${runKm.toFixed(1)} km (${(runMins / 60).toFixed(1)} Std.)${maxRunKm > 0 ? `, Längster Lauf: ${maxRunKm.toFixed(1)} km` : ''}
${otherCount > 0 ? `- 🏋️ Sonstige Einheiten: ${otherCount} (${(otherMins / 60).toFixed(1)} Std.)\n` : ''}
Auszug jüngster Einheiten:
${listExcerpt}`;
}

function buildFeedbackPrompt(currentPlan, activities, timeframeDays) {
  const planSummary = formatPlanForFeedbackPrompt(currentPlan);
  const actsSummary = formatActivitiesForFeedbackPrompt(activities, timeframeDays);

  return `Du bist ein hochqualifizierter Triathlon-Headcoach (Spezialisierung Langdistanz / Ironman).
Der Athlet möchte eine professionelle Analyse und konstruktives Feedback zu seinem AKTUELLES WOCHENTRAININGPLAN, basierend auf seinen tatsächlich absolvierten Einheiten der vergangenen ${timeframeDays} Tage.

WICHTIGER HINWEIS: Du sollst den Trainingsplan NICHT überschreiben und keinen neuen Plan generieren, sondern den bestehenden Plan fundiert bewerten und Feedback geben!

## Ziel
Ironman-Vorbereitung (3,8 km Schwimmen, 180 km Radfahren, 42,2 km Laufen).

## Trainingshistorie des Athleten (letzte ${timeframeDays} Tage)
${actsSummary}

## Zu analysierender aktueller Trainingsplan
${planSummary}

## Deine Bewertungskriterien als Coach:
1. Belastungs- & Umfangs-Verhältnis: Passt das geplante Wochenvolumen zu den bisherigen Einheiten der letzten ${timeframeDays} Tage, oder droht Überlastung / ein zu steiler Anstieg (>10-15%)?
2. Balance der drei Disziplinen: Werden Schwimmen, Radfahren und Laufen zielgerichtet trainiert?
3. Schlüsseleinheiten & Erholung: Sind Longride, Longrun oder Schwelleneinheiten sinnvoll platziert? Sind Ruhetage zur Superkompensation ausreichend?
4. Stärken: 2 bis 4 positive Aspekte des aktuellen Plans.
5. Risiken & Warnungen: 1 bis 3 potenzielle Gefahrenquellen, Überlastungen oder Lücken.
6. Handlungsempfehlungen: 3 bis 5 konkrete Tipps für die anstehende Trainingswoche.
7. Gesamt-Score: 0 bis 100 Punkte (wie stimmig und machbar der Plan ist) mit prägnantem Prädikat.

## WICHTIG: Antwortformat
Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt ohne Markdown-Codeblöcke (\`\`\`json) und ohne zusätzlichen Text davor oder danach:
{
  "score": 85,
  "rating": "Ausgewogen & Zielgerichtet",
  "summary": "3-4 Sätze fundiertes Gesamt-Feedback des Coaches.",
  "disciplineAnalysis": {
    "swim": {
      "status": "optimal",
      "comment": "Feedback zum Schwimmvolumen im Vergleich zur Historie (1-2 Sätze)."
    },
    "ride": {
      "status": "optimal",
      "comment": "Feedback zum Radfahren / Longride im Vergleich zur Historie (1-2 Sätze)."
    },
    "run": {
      "status": "warning",
      "comment": "Feedback zum Laufen / Pacing / Gelenkbelastung im Vergleich zur Historie (1-2 Sätze)."
    }
  },
  "strengths": [
    "Präzise Stärke 1",
    "Präzise Stärke 2"
  ],
  "risksAndWarnings": [
    "Kritisches Risiko oder Warnung 1"
  ],
  "recommendations": [
    "Handlungsempfehlung 1 für diese Woche",
    "Handlungsempfehlung 2 für diese Woche",
    "Handlungsempfehlung 3 für diese Woche"
  ]
}
Hinweis für status: Verwende ausschließlich "optimal", "warning" oder "low".`;
}

function parseFeedbackResponse(rawText) {
  try {
    let cleaned = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace  = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(cleaned);

    const score = typeof parsed.score === "number" ? Math.min(100, Math.max(0, Math.round(parsed.score))) : 75;
    const rating = parsed.rating || "Solider Trainingsaufbau";
    const summary = parsed.summary || "Dein Trainingsplan wurde analysiert.";

    const disciplineAnalysis = parsed.disciplineAnalysis || {
      swim: { status: "optimal", comment: "Solide Einheiten." },
      ride: { status: "optimal", comment: "Gute Umfänge." },
      run:  { status: "optimal", comment: "Ausgewogener Laufumfang." }
    };

    const strengths = Array.isArray(parsed.strengths) && parsed.strengths.length > 0
      ? parsed.strengths
      : ["Ausgewogene Wochenstruktur", "Gute Einheitenverteilung"];

    const risksAndWarnings = Array.isArray(parsed.risksAndWarnings) && parsed.risksAndWarnings.length > 0
      ? parsed.risksAndWarnings
      : ["Auf ausreichende Regeneration und Schlaf zwischen fordernden Einheiten achten."];

    const recommendations = Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0
      ? parsed.recommendations
      : ["Plane ausreichend Schlaf ein", "Achte auf konsequente Grundlageneinheiten in Zone 2"];

    return {
      score,
      rating,
      summary,
      disciplineAnalysis,
      strengths,
      risksAndWarnings,
      recommendations,
    };
  } catch (err) {
    console.error("[gemini] JSON Parse-Fehler beim Feedback:", err, rawText);
    return null;
  }
}

function renderPlanFeedback(feedback, timeframeDays, activitiesCount) {
  const metaEl = document.getElementById("ai-feedback-meta");
  const contentEl = document.getElementById("ai-feedback-content");
  if (!contentEl) return;

  if (metaEl) {
    const timeStr = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    metaEl.textContent = `Basis: Letzte ${timeframeDays} Tage (${activitiesCount} Einheiten) • ${timeStr} Uhr`;
  }

  let scoreClass = "score-high";
  if (feedback.score < 60) {
    scoreClass = "score-low";
  } else if (feedback.score < 80) {
    scoreClass = "score-mid";
  }

  const discMap = {
    swim: { title: "Schwimmen", icon: "🏊" },
    ride: { title: "Radfahren", icon: "🚴" },
    run:  { title: "Laufen",    icon: "🏃" }
  };

  const statusLabels = {
    optimal: { text: "Optimal abgestimmt", class: "status-optimal" },
    warning: { text: "Optimierungsbedarf", class: "status-warning" },
    low:     { text: "Ausbaufähig",        class: "status-low" }
  };

  const discHtml = Object.entries(feedback.disciplineAnalysis || {}).map(([key, disc]) => {
    const meta = discMap[key] || { title: key, icon: "⚡" };
    const statusInfo = statusLabels[disc?.status] || statusLabels.optimal;
    return `
      <div class="feedback-disc-card">
        <div class="disc-card-header">
          <div class="disc-card-title">
            <span class="disc-icon">${meta.icon}</span>
            <span>${escapeHtml(meta.title)}</span>
          </div>
          <span class="disc-status-pill ${statusInfo.class}">${escapeHtml(statusInfo.text)}</span>
        </div>
        <p class="disc-card-comment">${escapeHtml(disc?.comment || "")}</p>
      </div>
    `;
  }).join("");

  const strengthsHtml = (feedback.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join("");
  const risksHtml = (feedback.risksAndWarnings || []).map(r => `<li>${escapeHtml(r)}</li>`).join("");
  const recsHtml = (feedback.recommendations || []).map(rec => `<li>${escapeHtml(rec)}</li>`).join("");

  contentEl.innerHTML = `
    <div class="feedback-overview-banner">
      <div class="feedback-score-badge ${scoreClass}">
        <div class="score-circle">
          <span class="score-number">${feedback.score}</span>
          <span class="score-max">/100</span>
        </div>
        <span class="score-label">${escapeHtml(feedback.rating)}</span>
      </div>
      <div class="feedback-summary-box">
        <div class="feedback-summary-header">
          <span class="summary-badge">COACH-EINSCHÄTZUNG</span>
          <h4>Gesamtbewertung des aktuellen Trainingsplans</h4>
        </div>
        <p class="feedback-summary-text">${escapeHtml(feedback.summary)}</p>
      </div>
    </div>

    <div class="feedback-disciplines-section">
      <h4 class="feedback-section-title">Analyse nach Disziplinen</h4>
      <div class="feedback-disciplines-grid">
        ${discHtml}
      </div>
    </div>

    <div class="feedback-details-cols">
      <div class="feedback-col feedback-strengths">
        <h4><span class="col-icon">✅</span> Stärken des aktuellen Plans</h4>
        <ul class="feedback-bullet-list">
          ${strengthsHtml}
        </ul>
      </div>
      <div class="feedback-col feedback-risks">
        <h4><span class="col-icon">⚠️</span> Potenzielle Risiken &amp; Warnungen</h4>
        <ul class="feedback-bullet-list">
          ${risksHtml}
        </ul>
      </div>
    </div>

    <div class="feedback-recommendations-box">
      <h4><span class="col-icon">🎯</span> Konkrete Handlungsempfehlungen für diese Woche</h4>
      <ol class="feedback-recs-list">
        ${recsHtml}
      </ol>
    </div>
  `;
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

    let partsOrMetricsHtml = "";
    if (Array.isArray(day.parts) && day.parts.length > 1) {
      partsOrMetricsHtml = `
        <div class="day-parts-view-list">
          ${day.parts.map(p => `
            <div class="day-part-item">
              <div class="part-item-header">
                <span class="subtype-pill">
                  <span class="pill-icon">${p.icon || '•'}</span>
                  <span>${escapeHtml(p.label)}</span>
                </span>
                <span class="part-mini-intensity intensity-${p.intensity || 'easy'}">
                  ${p.intensity === 'hard' ? 'EB' : (p.intensity === 'moderate' ? 'GA2' : 'GA1')}
                </span>
              </div>
              <div class="part-metrics-subline">
                <span class="metric-mini">⏱️ ${p.duration > 0 ? `${p.duration} Min.` : '–'}</span>
                ${p.distance != null ? `<span class="metric-mini">📍 ${p.distance} km</span>` : ''}
                ${p.speed ? `<span class="metric-mini">⚡ ${escapeHtml(p.speed)}</span>` : ''}
              </div>
            </div>
          `).join("")}
        </div>
        <div class="day-total-badge">
          Gesamt: ⏱️ ${day.duration} Min.${day.distance != null ? ` • 📍 ${day.distance} km` : ''}
        </div>
      `;
    } else {
      let subtypesHtml = "";
      if (Array.isArray(day.subtypes) && day.subtypes.length > 0) {
        subtypesHtml = `<div class="day-subtype-pills">${day.subtypes.map(s => `<span class="subtype-pill">${escapeHtml(s)}</span>`).join("")}</div>`;
      }

      const metricsParts = [];
      metricsParts.push(`⏱️ ${day.duration > 0 ? `${day.duration} Min.` : 'Ruhetag'}`);
      if (day.distance) metricsParts.push(`📍 ${day.distance} km`);
      if (day.speed) metricsParts.push(`⚡ ${escapeHtml(day.speed)}`);

      partsOrMetricsHtml = `
        ${subtypesHtml}
        <div class="day-duration">${metricsParts.join(" &bull; ")}</div>
      `;
    }

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
          ${partsOrMetricsHtml}
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
