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
let proposedPlan        = null;
let aiTimeframeDays     = 30; // Standard: 30 Tage

// ── Wochentage ─────────────────────────────────────────────
const WEEKDAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const WEEKDAY_DE = { monday:"Mo", tuesday:"Di", wednesday:"Mi", thursday:"Do", friday:"Fr", saturday:"Sa", sunday:"So" };

// ── Initialisierung ────────────────────────────────────────
export async function initTrainingPlan(user) {
  currentUser = user || auth?.currentUser;

  // Setup Event-Listener (vor dem Laden registrieren, damit die Buttons immer funktionieren)
  setupTimeframeListeners();
  document.getElementById("ai-adjust-btn")?.addEventListener("click", adjustPlanWithAI);
  document.getElementById("ai-feedback-btn")?.addEventListener("click", analyzePlanWithAI);
  document.getElementById("ai-feedback-close-btn")?.addEventListener("click", () => {
    document.getElementById("ai-feedback-card")?.classList.add("hidden");
    updateEmptyHintVisibility();
  });
  document.getElementById("ai-accept-proposal-btn")?.addEventListener("click", acceptProposedPlan);
  document.getElementById("ai-reject-proposal-btn")?.addEventListener("click", rejectProposedPlan);

  // Synchronisation bei externen Updates (z. B. durch manuelles Bearbeiten im Trainingsplan-Tab)
  window.addEventListener("planUpdated", (e) => {
    if (e.detail) {
      currentPlan = e.detail;
    }
  });

  try {
    const plan = await loadCurrentPlan();
    if (plan) {
      currentPlan = plan;
    }
  } catch (err) {
    console.error("[gemini] Fehler beim Laden des bestehenden Trainingsplans:", err);
  }

  updateEmptyHintVisibility();

  // Vorschau-Zähler für Aktivitäten aktualisieren
  await updateActivityCountPreview();
}

function updateEmptyHintVisibility() {
  const hintCard = document.getElementById("ai-empty-hint-card");
  const proposalCard = document.getElementById("ai-proposal-card");
  const feedbackCard = document.getElementById("ai-feedback-card");
  if (!hintCard) return;

  const hasProposal = proposalCard && !proposalCard.classList.contains("hidden");
  const hasFeedback = feedbackCard && !feedbackCard.classList.contains("hidden");
  hintCard.classList.toggle("hidden", Boolean(hasProposal || hasFeedback));
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

// ── KI-Plan-Vorschlag generieren ──────────────────────────
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
    // Sicherstellen, dass wir den aktuellsten Plan (für Lock-Status etc.) geladen haben
    if (!currentPlan) {
      currentPlan = await loadCurrentPlan();
    }

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
    showAiStatus("🧠 Gemini erstellt deinen personalisierten Trainingsplan-Vorschlag…");
    const newPlanJSON = await callGeminiAPI(prompt, geminiApiKey);

    // 4. Plan parsen und validieren
    const newPlan = parsePlanResponse(newPlanJSON);
    if (!newPlan) throw new Error("Ungültige Plan-Struktur von Gemini");

    // 5. Als Vorschlag im Tab "KI-Assistenz" anzeigen (noch NICHT speichern!)
    proposedPlan = {
      ...newPlan,
      analyzedTimeframeDays: aiTimeframeDays,
      analyzedActivitiesCount: filteredActs.length,
      createdAt: new Date().toISOString(),
      aiGenerated: true,
    };

    renderTrainingPlan(proposedPlan);

    const proposalCard = document.getElementById("ai-proposal-card");
    if (proposalCard) {
      proposalCard.classList.remove("hidden");
      updateEmptyHintVisibility();
      proposalCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    hideAiStatus();
    showToast(`✨ Neuer Trainingsplan-Vorschlag erstellt! Du kannst ihn jetzt prüfen und annehmen oder ablehnen.`, "success");

  } catch (err) {
    console.error("Gemini Fehler:", err);
    hideAiStatus();
    showToast(`KI-Vorschlag fehlgeschlagen: ${err.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Nimmt den generierten KI-Vorschlag an, überschreibt damit den aktuellen Trainingsplan in Firestore
 * und synchronisiert den Trainingsplan-Tab.
 */
async function acceptProposedPlan() {
  if (!proposedPlan) return;

  const acceptBtn = document.getElementById("ai-accept-proposal-btn");
  const rejectBtn = document.getElementById("ai-reject-proposal-btn");
  if (acceptBtn) {
    acceptBtn.disabled = true;
    acceptBtn.textContent = "💾 Übernehme Trainingsplan…";
  }
  if (rejectBtn) rejectBtn.disabled = true;

  try {
    const savedPlan = await savePlan(proposedPlan);
    currentPlan = savedPlan;
    proposedPlan = null;

    document.getElementById("ai-proposal-card")?.classList.add("hidden");
    updateEmptyHintVisibility();

    showToast("✅ KI-Vorschlag angenommen! Dein Trainingsplan wurde aktualisiert.", "success");

    // Direkt zum Trainingsplan-Tab wechseln, damit der Nutzer seinen neuen Plan sieht
    window.location.hash = "plan";
  } catch (err) {
    console.error("[gemini] Fehler beim Übernehmen des Vorschlags:", err);
    showToast(`Fehler beim Speichern des Plans: ${err.message}`, "error");
  } finally {
    if (acceptBtn) {
      acceptBtn.disabled = false;
      acceptBtn.textContent = "✅ Vorschlag annehmen & Trainingsplan überschreiben";
    }
    if (rejectBtn) rejectBtn.disabled = false;
  }
}

/**
 * Lehnt den generierten KI-Vorschlag ab und verwirft ihn, ohne den bestehenden Plan zu verändern.
 */
function rejectProposedPlan() {
  proposedPlan = null;
  document.getElementById("ai-proposal-card")?.classList.add("hidden");
  updateEmptyHintVisibility();
  showToast("KI-Vorschlag abgelehnt. Dein bestehender Trainingsplan bleibt unverändert.", "info");
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
      updateEmptyHintVisibility();
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
    const isRest = !day || day.type === "rest" || (Array.isArray(day.disciplines) && day.disciplines.length === 1 && day.disciplines[0] === "rest");
    const lockNote = day?.locked ? " [🔒 FIXIERT / GESPERRT]" : "";

    if (!day || isRest) {
      const note = day?.notes || day?.description;
      return `${dayLabel}${lockNote}: Ruhetag${note ? ` (${note})` : ""}`;
    }

    let typeStr = (day.type || "Aktivität").toUpperCase();
    if (Array.isArray(day.disciplines) && day.disciplines.length > 1) {
      const discNames = day.disciplines.map(d => ({
        ride: "Rad", run: "Laufen", swim: "Schwimmen"
      }[d] || d)).join(" + ");
      typeStr = `KOPPELTRAINING (${discNames})`;
    }

    const metaParts = [];
    if (Array.isArray(day.disciplines) && day.disciplines.length > 0) {
      metaParts.push(`Disziplinen: ${day.disciplines.join(", ")}`);
    }
    if (Array.isArray(day.subtypes) && day.subtypes.length > 0) {
      metaParts.push(`Arten: ${day.subtypes.join(", ")}`);
    }
    if (day.duration) metaParts.push(`Dauer: ${day.duration} Min`);
    if (day.distance) metaParts.push(`Distanz: ${day.distance} km`);
    if (day.speed) metaParts.push(`Tempo: ${day.speed}`);
    if (day.intensity) metaParts.push(`Intensität: ${day.intensity}`);

    let text = `${dayLabel}${lockNote}: ${typeStr} (${metaParts.join(" • ")})`;
    const note = day.notes || day.description;
    if (note) text += `\n  Notiz/Fokus: ${note}`;

    if (Array.isArray(day.parts) && day.parts.length > 0) {
      const partsDetail = day.parts.map(p => {
        const discPrefix = p.discId ? `[${{ride:"Rad", run:"Laufen", swim:"Schwimmen", rest:"Ruhe"}[p.discId] || p.discId}] ` : "";
        return `    - ${discPrefix}"${p.label || p.type}": ${p.duration || 0} Min${p.distance ? `, ${p.distance} km` : ""}${p.speed ? `, Pace/Tempo ${p.speed}` : ""}${p.intensity ? `, Intensität ${p.intensity}` : ""}`;
      }).join("\n");
      text += `\n  Einheiten / Abschnitte:\n${partsDetail}`;
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

  const actsSummary = formatActivitiesForFeedbackPrompt(activities, timeframeDays);
  const currentPlanStr = formatPlanForFeedbackPrompt(currentPlan);

  // Fixierte Tage erfassen
  const lockedDaysList = [];
  if (currentPlan?.weekPlan) {
    for (const [dKey, dObj] of Object.entries(currentPlan.weekPlan)) {
      if (dObj?.locked) {
        const dLabel = WEEKDAY_DE[dKey] || dKey;
        const discs = Array.isArray(dObj.disciplines) && dObj.disciplines.length > 0
          ? dObj.disciplines.map(d => ({ ride: "Rad", run: "Laufen", swim: "Schwimmen", rest: "Ruhetag" }[d] || d)).join(" + ")
          : (dObj.type || "Ruhetag");
        const rawDiscs = Array.isArray(dObj.disciplines) && dObj.disciplines.length > 0
          ? dObj.disciplines
          : [dObj.type || "rest"];
        lockedDaysList.push(`- **${dLabel}** (${dKey}): Fixierte Disziplin(en) = ${discs} (disciplines: ${JSON.stringify(rawDiscs)})`);
      }
    }
  }

  const lockedSection = lockedDaysList.length > 0
    ? `\n## 🔒 FIXIERTE TAGE DES ATHLETEN (HÖCHSTE PRIORITÄT!)
Der Athlet hat für folgende Wochentage ein LOCK gesetzt. Für diese Tage MUSST du zwingend die exakt vorgegebenen Disziplinen beibehalten!
Du darfst diese Tage weder in eine andere Sportart noch in Ruhetag umwandeln (oder umgekehrt).
Pass die Abschnitte (parts), Distanzen, Intensitäten und Notizen gerne optimal an, aber die Disziplin(en) sind unantastbar:
${lockedDaysList.join("\n")}\n`
    : "";

  return `Du bist ein hochqualifizierter Triathlon-Headcoach (Ironman-Spezialist für Langdistanz: 3,8 km Schwimmen, 180 km Radfahren, 42,2 km Laufen).
Analysiere die Trainingshistorie des Athleten aus den letzten ${timeframeDays} Tagen und erstelle einen neuen, detailgenauen und perfekt abgestimmten Wochenplan für die kommende Woche.

## Trainings-Historie (letzte ${timeframeDays} Tage, seit ${dateStr})
Anzahl analysierter Einheiten: ${activities.length}
${actsSummary}

## Bisheriger Trainingsplan
${currentPlanStr}
${lockedSection}
## Trainingsphilosophie für den Ironman
1. **Belastungssteuerung & Erholung**: Mindestens 1 echter Ruhetag pro Woche (z. B. Montag). Ruhetage dienen der Superkompensation.
2. **Triathlon-Spezifik**: Am Wochenende ist mindestens 1 Koppeleinheit (Brick: Radfahren gefolgt von einem Koppellauf) oder ein langer Lauf (Longrun) einzuplanen.
3. **Progressive Anpassung**: Die Gesamtbelastung sollte maßvoll an die bisherige Historie anknüpfen (+5% bis +10% Steigerung, keine abrupten Überlastungen).

## WICHTIG: Architektur des neuen, ausführlichen Trainingsplan-Formats
Das Dashboard nutzt ein neues, detailliertes Mehr-Disziplinen- und Abschnittsmodell. Jeder Wochentag (monday bis sunday) MUSS exakt nach diesen Regeln strukturiert sein:

1. **Disziplinen (\`disciplines\`)**:
   - Array der gewählten Disziplinen. Erlaubte IDs: \`"swim"\`, \`"ride"\`, \`"run"\`, \`"rest"\`.
   - **KOPPELTRAINING (Brick)**: "Koppel" ist KEINE eigene Disziplin! Eine Koppeleinheit wird erzeugt, indem MEHRERE Disziplinen gewählt werden (z. B. \`["ride", "run"]\` oder \`["swim", "ride"]\`).
   - **RUHETAG**: Hat AUSSCHLIESSLICH \`["rest"]\` als Disziplin. Ruhetag darf NIEMALS mit einer Sport-Disziplin kombiniert werden!

2. **Trainingsarten je Disziplin (\`subtypesByDisc\` & \`subtypes\`)**:
   - Für jede gewählte Disziplin in \`disciplines\` werden eine oder mehrere spezifische Arten gewählt:
     - \`swim\`: \`"technik"\` (Technik), \`"distance"\` (Distance), \`"intervalle"\` (Intervalle)
     - \`ride\`: \`"intervalle"\` (Intervalle), \`"endurance"\` (Endurance), \`"schwelle"\` (Schwelle)
     - \`run\`: \`"longrun"\` (Longrun), \`"intervalle"\` (Intervalle), \`"zone2"\` (Zone 2)
     - \`rest\`: \`"ruhe"\` (Komplette Erholung), \`"mobility"\` (Stretching & Mobilität), \`"walk"\` (Spaziergang / Regenerativ)
   - \`subtypesByDisc\`: Ein Objekt mit Subtype-Arrays je Disziplin, z. B. \`{ "ride": ["endurance"], "run": ["zone2"] }\`.
   - \`subtypes\`: Flat-Array aller gewählten Subtypes, z. B. \`["endurance", "zone2"]\`.

3. **Abschnitte & Parameter (\`parts\`)**:
   - Das Array \`parts\` enthält genau ein Objekt für JEDE gewählte Art JEDER Disziplin.
   - Jedes Teil-Objekt besitzt:
     - \`discId\`: Disziplin-ID (\`"swim"\`, \`"ride"\`, \`"run"\`, \`"rest"\`)
     - \`id\`: Art-ID (z. B. \`"endurance"\`, \`"zone2"\`, \`"ruhe"\`)
     - \`label\`: Bezeichnung mit Disziplin-Präfix (z. B. \`"Rad: Endurance"\`, \`"Laufen: Zone 2"\`)
     - \`icon\`: Passendes Emoji (z. B. 🔋, 💚, ⚡, 🔥, 🎯, 🌊, 🏃‍♂️, 🛏️, 🧘)
     - \`duration\`: Dauer in Minuten (ganze Zahl, 0 bei Ruhetag)
     - \`distance\`: Distanz in Kilometern als Zahl (z. B. 60 oder 1.8; bei reinem Ruhetag null)
     - \`speed\`: Tempo-/Pace-/Leistungsangabe (z. B. \`"32 km/h / 230 W"\`, \`"5:15 min/km"\`, \`"1:45 min/100m"\` oder \`""\` bei Ruhetag)
     - \`intensity\`: Intensität (\`"easy"\`, \`"moderate"\` oder \`"hard"\`)

4. **Tages-Gesamtwerte**:
   - \`duration\`: Summe aller part.duration in Minuten (ganze Zahl)
   - \`distance\`: Summe aller part.distance in km (Zahl oder null)
   - \`speed\`: Zusammenfassung der Tempi (z. B. \`"Rad: 30 km/h • Laufen: 5:25 min/km"\`)
   - \`intensity\`: Höchste Intensität des Tages (\`"easy"\`, \`"moderate"\` oder \`"hard"\`)
   - \`description\`: Kurztitel der Einheit (z. B. \`"Koppeltraining: Rad (Endurance) + Laufen (Zone 2)"\`)
   - \`notes\`: Präzise Coaching-Anweisung & Durchführungshinweise (Warmup, Intervalle, Trittfrequenz, Pacing, Verpflegung).

## WICHTIG: Antwortformat
Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt ohne Markdown-Codeblöcke (\`\`\`json) und ohne zusätzlichen Text davor oder danach:
{
  "coachNote": "Persönliche Analyse und Begründung des Headcoaches für die Schwerpunktsetzung dieser Woche (2-3 Sätze).",
  "weekPlan": {
    "monday": {
      "disciplines": ["rest"],
      "subtypes": ["ruhe", "mobility"],
      "subtypesByDisc": { "rest": ["ruhe", "mobility"] },
      "parts": [
        { "discId": "rest", "id": "ruhe", "label": "Ruhetag: Komplette Erholung", "icon": "🛏️", "duration": 0, "distance": null, "speed": "", "intensity": "easy" },
        { "discId": "rest", "id": "mobility", "label": "Ruhetag: Stretching & Mobilität", "icon": "🧘", "duration": 20, "distance": null, "speed": "", "intensity": "easy" }
      ],
      "duration": 20,
      "distance": null,
      "speed": "",
      "intensity": "easy",
      "description": "Ruhetag & Mobilität",
      "notes": "Aktive Erholung, Faszienrolle und Dehnen für Beine und Hüfte."
    },
    "tuesday": {
      "disciplines": ["ride"],
      "subtypes": ["intervalle", "schwelle"],
      "subtypesByDisc": { "ride": ["intervalle", "schwelle"] },
      "parts": [
        { "discId": "ride", "id": "intervalle", "label": "Rad: Intervalle", "icon": "⚡", "duration": 45, "distance": 22, "speed": "34 km/h", "intensity": "hard" },
        { "discId": "ride", "id": "schwelle", "label": "Rad: Schwelle", "icon": "🔥", "duration": 30, "distance": 15, "speed": "32 km/h", "intensity": "hard" }
      ],
      "duration": 75,
      "distance": 37,
      "speed": "Rad: 34 km/h • Rad: 32 km/h",
      "intensity": "hard",
      "description": "Rad (Intervalle & Schwelle)",
      "notes": "15 Min. Warmup, 3x 8 Min. an der anaeroben Schwelle (TF 90 rpm, 4 Min Pause), 15 Min. Ausfahren."
    },
    "wednesday": {
      "disciplines": ["swim"],
      "subtypes": ["technik", "intervalle"],
      "subtypesByDisc": { "swim": ["technik", "intervalle"] },
      "parts": [
        { "discId": "swim", "id": "technik", "label": "Schwimmen: Technik", "icon": "🎯", "duration": 25, "distance": 1.0, "speed": "1:55 min/100m", "intensity": "easy" },
        { "discId": "swim", "id": "intervalle", "label": "Schwimmen: Intervalle", "icon": "⚡", "duration": 35, "distance": 1.5, "speed": "1:40 min/100m", "intensity": "moderate" }
      ],
      "duration": 60,
      "distance": 2.5,
      "speed": "Schwimmen: 1:55 min/100m • Schwimmen: 1:40 min/100m",
      "intensity": "moderate",
      "description": "Schwimmen (Technik & Intervalle)",
      "notes": "Einschwimmen, Faustschwimmen & Kraulbeine, gefolgt von 10x 100m zügig mit 20s Pause."
    },
    "thursday": {
      "disciplines": ["run"],
      "subtypes": ["zone2"],
      "subtypesByDisc": { "run": ["zone2"] },
      "parts": [
        { "discId": "run", "id": "zone2", "label": "Laufen: Zone 2", "icon": "💚", "duration": 60, "distance": 11, "speed": "5:25 min/km", "intensity": "easy" }
      ],
      "duration": 60,
      "distance": 11,
      "speed": "Laufen: 5:25 min/km",
      "intensity": "easy",
      "description": "Laufen (Zone 2)",
      "notes": "Lockerer Grundlagenausdauerlauf, Puls strikt im aeroben Bereich halten."
    },
    "friday": {
      "disciplines": ["swim"],
      "subtypes": ["distance"],
      "subtypesByDisc": { "swim": ["distance"] },
      "parts": [
        { "discId": "swim", "id": "distance", "label": "Schwimmen: Distance", "icon": "🌊", "duration": 45, "distance": 2.2, "speed": "1:48 min/100m", "intensity": "moderate" }
      ],
      "duration": 45,
      "distance": 2.2,
      "speed": "Schwimmen: 1:48 min/100m",
      "intensity": "moderate",
      "description": "Schwimmen (Distance)",
      "notes": "Gleichmäßige Ausdauerserie im Neopren- oder Wettkampftempo, Fokus auf Wasserlage."
    },
    "saturday": {
      "disciplines": ["ride", "run"],
      "subtypes": ["endurance", "zone2"],
      "subtypesByDisc": { "ride": ["endurance"], "run": ["zone2"] },
      "parts": [
        { "discId": "ride", "id": "endurance", "label": "Rad: Endurance", "icon": "🔋", "duration": 120, "distance": 60, "speed": "30 km/h", "intensity": "moderate" },
        { "discId": "run", "id": "zone2", "label": "Laufen: Koppellauf Zone 2", "icon": "💚", "duration": 30, "distance": 5.5, "speed": "5:25 min/km", "intensity": "easy" }
      ],
      "duration": 150,
      "distance": 65.5,
      "speed": "Rad: 30 km/h • Laufen: 5:25 min/km",
      "intensity": "moderate",
      "description": "Koppeltraining: Rad (Endurance) + Laufen (Zone 2)",
      "notes": "Wettkampfspezifisches Koppeltraining: 2 Std. Radfahren in Aero-Position, direkter schneller Wechsel und 30 Min. Koppellauf."
    },
    "sunday": {
      "disciplines": ["run"],
      "subtypes": ["longrun"],
      "subtypesByDisc": { "run": ["longrun"] },
      "parts": [
        { "discId": "run", "id": "longrun", "label": "Laufen: Longrun", "icon": "🏃‍♂️", "duration": 90, "distance": 16, "speed": "5:35 min/km", "intensity": "moderate" }
      ],
      "duration": 90,
      "distance": 16,
      "speed": "Laufen: 5:35 min/km",
      "intensity": "moderate",
      "description": "Laufen (Longrun)",
      "notes": "Langer Vorbereitungslauf. Alle 25 Minuten Kohlenhydrat-Zufuhr testen."
    }
  }
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

// ── Katalog & Normalisierung für das neue Format ──────────
const AI_PLAN_CATALOG = {
  rest: {
    label: "Ruhetag",
    icon: "😴",
    subtypes: {
      ruhe:     { label: "Ruhetag: Komplette Erholung", icon: "🛏️", defInt: "easy", defSpeed: "" },
      mobility: { label: "Ruhetag: Stretching & Mobilität", icon: "🧘", defInt: "easy", defSpeed: "" },
      walk:     { label: "Ruhetag: Spaziergang / Regenerativ", icon: "🚶", defInt: "easy", defSpeed: "" }
    }
  },
  swim: {
    label: "Schwimmen",
    icon: "🏊",
    subtypes: {
      technik:   { label: "Schwimmen: Technik", icon: "🎯", defInt: "easy", defSpeed: "1:55 min/100m" },
      distance:  { label: "Schwimmen: Distance", icon: "🌊", defInt: "moderate", defSpeed: "1:48 min/100m" },
      intervalle:{ label: "Schwimmen: Intervalle", icon: "⚡", defInt: "hard", defSpeed: "1:40 min/100m" }
    }
  },
  ride: {
    label: "Rad",
    icon: "🚴",
    subtypes: {
      intervalle:{ label: "Rad: Intervalle", icon: "⚡", defInt: "hard", defSpeed: "34 km/h" },
      endurance: { label: "Rad: Endurance", icon: "🔋", defInt: "moderate", defSpeed: "30 km/h" },
      schwelle:  { label: "Rad: Schwelle", icon: "🔥", defInt: "hard", defSpeed: "32 km/h" }
    }
  },
  run: {
    label: "Laufen",
    icon: "🏃",
    subtypes: {
      longrun:   { label: "Laufen: Longrun", icon: "🏃‍♂️", defInt: "moderate", defSpeed: "5:30 min/km" },
      intervalle:{ label: "Laufen: Intervalle", icon: "⚡", defInt: "hard", defSpeed: "4:30 min/km" },
      zone2:     { label: "Laufen: Zone 2", icon: "💚", defInt: "easy", defSpeed: "5:45 min/km" }
    }
  }
};

/**
 * Normalisiert und validiert einen von Gemini generierten Trainingsplan,
 * sodass er ausnahmslos dem neuen Mehr-Disziplinen- und Abschnittsformat entspricht.
 */
function normalizePlanFromAI(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") return null;
  const rawWeek = rawPlan.weekPlan || {};
  const normalizedWeek = {};

  for (const dayKey of WEEKDAYS) {
    const rawDay = rawWeek[dayKey] || { type: "rest" };
    const existingDay = currentPlan?.weekPlan?.[dayKey];
    const isLocked = Boolean(existingDay?.locked || rawDay.locked);

    // 1. Disziplinen validieren & bereinigen
    let disciplines = [];
    if (isLocked && existingDay?.disciplines && Array.isArray(existingDay.disciplines) && existingDay.disciplines.length > 0) {
      // 🔒 Wenn fixiert: Die Disziplin(en) des Athleten haben absolute Priorität!
      disciplines = existingDay.disciplines.filter(d => AI_PLAN_CATALOG[d]);
      if (disciplines.length === 0) disciplines = ["rest"];
    } else if (Array.isArray(rawDay.disciplines) && rawDay.disciplines.length > 0) {
      for (const d of rawDay.disciplines) {
        if (d === "brick") {
          if (!disciplines.includes("ride")) disciplines.push("ride");
          if (!disciplines.includes("run")) disciplines.push("run");
        } else if (AI_PLAN_CATALOG[d] && !disciplines.includes(d)) {
          disciplines.push(d);
        }
      }
    } else if (rawDay.type === "brick") {
      disciplines = ["ride", "run"];
    } else if (rawDay.type && AI_PLAN_CATALOG[rawDay.type]) {
      disciplines = [rawDay.type];
    } else {
      disciplines = ["rest"];
    }

    // Ruhetags-Regel: Ruhetag schließt alle Sportarten aus
    if (disciplines.includes("rest")) {
      if (disciplines.length > 1) {
        disciplines = disciplines.filter(d => d !== "rest");
      } else {
        disciplines = ["rest"];
      }
    }
    if (disciplines.length === 0) disciplines = ["rest"];

    const isRest = disciplines.length === 1 && disciplines[0] === "rest";

    // 2. Parts & Subtypes validieren und aufbauen
    const parts = [];
    const subtypesByDisc = {};
    disciplines.forEach(d => { subtypesByDisc[d] = []; });

    if (Array.isArray(rawDay.parts) && rawDay.parts.length > 0) {
      for (const p of rawDay.parts) {
        if (!p) continue;
        let discId = p.discId;
        if (!discId || !AI_PLAN_CATALOG[discId]) {
          for (const d of disciplines) {
            if (AI_PLAN_CATALOG[d]?.subtypes[p.id]) { discId = d; break; }
          }
        }
        if (!discId || !disciplines.includes(discId)) {
          discId = disciplines[0];
        }

        const discConf = AI_PLAN_CATALOG[discId] || AI_PLAN_CATALOG.rest;
        let subId = (p.id || "").toLowerCase();
        if (!discConf.subtypes[subId]) {
          const labelLower = (p.label || "").toLowerCase();
          for (const sKey of Object.keys(discConf.subtypes)) {
            if (labelLower.includes(sKey)) { subId = sKey; break; }
          }
          if (!discConf.subtypes[subId]) {
            subId = Object.keys(discConf.subtypes)[0];
          }
        }

        const subConf = discConf.subtypes[subId] || { label: p.label || subId, icon: "•", defInt: "moderate" };
        const duration = typeof p.duration === "number" ? Math.max(0, Math.round(p.duration)) : (isRest ? 0 : 30);
        const distance = p.distance != null && !isNaN(parseFloat(p.distance)) ? parseFloat(parseFloat(p.distance).toFixed(1)) : null;
        const speed = p.speed ? p.speed.toString().trim() : (subConf.defSpeed || "");
        const intensity = ["easy", "moderate", "hard"].includes(p.intensity) ? p.intensity : (subConf.defInt || "moderate");

        parts.push({
          discId,
          id: subId,
          label: p.label || subConf.label,
          icon: p.icon || subConf.icon || "•",
          duration,
          distance,
          speed,
          intensity
        });

        if (!subtypesByDisc[discId].includes(subId)) {
          subtypesByDisc[discId].push(subId);
        }
      }
    }

    // Fallback: Wenn Gemini keine Parts geliefert hat, erstellen wir sie sauber aus den Subtypes
    if (parts.length === 0) {
      for (const d of disciplines) {
        const discConf = AI_PLAN_CATALOG[d] || AI_PLAN_CATALOG.rest;
        const rawSubs = (rawDay.subtypesByDisc && rawDay.subtypesByDisc[d]) || rawDay.subtypes || [];
        const chosenSubs = rawSubs.filter(s => discConf.subtypes[s]);
        const finalSubs = chosenSubs.length > 0 ? chosenSubs : [Object.keys(discConf.subtypes)[0]];

        const count = finalSubs.length;
        const totalDayDur = typeof rawDay.duration === "number" && rawDay.duration > 0 ? rawDay.duration : (d === "rest" ? 0 : 45);
        const durPerPart = Math.round(totalDayDur / (disciplines.length * count));

        for (const sId of finalSubs) {
          const subConf = discConf.subtypes[sId];
          parts.push({
            discId: d,
            id: sId,
            label: subConf.label,
            icon: subConf.icon,
            duration: d === "rest" ? 0 : durPerPart,
            distance: d === "rest" ? null : (rawDay.distance ? parseFloat((rawDay.distance / (disciplines.length * count)).toFixed(1)) : null),
            speed: subConf.defSpeed || "",
            intensity: subConf.defInt || "moderate"
          });
          if (!subtypesByDisc[d].includes(sId)) {
            subtypesByDisc[d].push(sId);
          }
        }
      }
    }

    // Subtypes als flache Liste
    const subtypes = [];
    for (const list of Object.values(subtypesByDisc)) {
      subtypes.push(...list);
    }

    // Gesamtwerte aufsummieren
    const totalDuration = parts.reduce((sum, p) => sum + (p.duration || 0), 0);
    const hasDistances = parts.some(p => typeof p.distance === "number" && p.distance > 0);
    const totalDistance = hasDistances
      ? parseFloat(parts.reduce((sum, p) => sum + (p.distance || 0), 0).toFixed(1))
      : null;

    // Tempo-String zusammensetzen falls nicht angegeben
    const speedParts = [];
    parts.forEach(p => {
      if (p.speed && !speedParts.includes(p.speed)) {
        speedParts.push(`${AI_PLAN_CATALOG[p.discId]?.label || p.discId}: ${p.speed}`);
      }
    });
    const totalSpeed = rawDay.speed || (speedParts.length > 0 ? speedParts.join(" • ") : "");

    // Gesamt-Intensität ermitteln
    let totalIntensity = "easy";
    if (parts.some(p => p.intensity === "hard")) {
      totalIntensity = "hard";
    } else if (parts.some(p => p.intensity === "moderate")) {
      totalIntensity = "moderate";
    }

    const finalType = isRest ? "rest" : (disciplines.length > 1 ? "brick" : disciplines[0]);

    normalizedWeek[dayKey] = {
      type: finalType,
      disciplines,
      subtypes,
      subtypesByDisc,
      parts,
      duration: totalDuration,
      distance: totalDistance,
      speed: totalSpeed,
      intensity: totalIntensity,
      description: rawDay.description || (disciplines.length > 1 ? "Koppeltraining" : (AI_PLAN_CATALOG[disciplines[0]]?.label || "Training")),
      notes: rawDay.notes || rawDay.description || "",
      locked: isLocked
    };
  }

  return {
    ...rawPlan,
    weekPlan: normalizedWeek,
    coachNote: rawPlan.coachNote || "Dein Ironman-Wochenplan wurde von der KI optimiert."
  };
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
    return normalizePlanFromAI(parsed);
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
    const dayLabel = WEEKDAY_DE[dayKey] || dayKey;
    const day = week[dayKey] || { type: "rest", duration: 0, description: "Ruhetag", intensity: "easy" };
    const isRest = day.type === "rest" || (Array.isArray(day.disciplines) && day.disciplines.length === 1 && day.disciplines[0] === "rest");

    let icon = typeIcon(day.type);
    let typeBadgeLabel = (day.type || 'other').toUpperCase();
    let badgeClass = (day.type || 'other').toLowerCase();

    if (Array.isArray(day.disciplines) && day.disciplines.length > 1) {
      icon = day.disciplines.map(d => typeIcon(d)).join(" ");
      const names = day.disciplines.map(d => ({
        ride: "RAD", run: "LAUF", swim: "SWIM"
      }[d] || d.toUpperCase())).join(" + ");
      typeBadgeLabel = `KOPPEL (${names})`;
      badgeClass = "brick";
    }

    let partsOrMetricsHtml = "";
    if (Array.isArray(day.parts) && (day.parts.length > 1 || (Array.isArray(day.disciplines) && day.disciplines.length > 1))) {
      partsOrMetricsHtml = `
        <div class="day-parts-view-list">
          ${day.parts.map(p => {
            const discTag = p.discId ? `<span class="disc-mini-badge badge-${p.discId}">${{ride:"Rad", run:"Lauf", swim:"Swim", rest:"Ruhe"}[p.discId] || p.discId}</span>` : "";
            return `
            <div class="day-part-item">
              <div class="part-item-header">
                <span class="subtype-pill">
                  <span class="pill-icon">${p.icon || '•'}</span>
                  <span>${escapeHtml(p.label)}</span>
                  ${discTag}
                </span>
                <span class="part-mini-intensity intensity-${p.intensity || 'easy'}">
                  ${p.intensity === 'hard' ? 'EB' : (p.intensity === 'moderate' ? 'GA2' : 'GA1')}
                </span>
              </div>
              <div class="part-metrics-subline">
                <span class="metric-mini">⏱️ ${p.duration > 0 ? `${p.duration} Min.` : '–'}</span>
                ${p.distance != null && p.distance !== "" ? `<span class="metric-mini">📍 ${p.distance} km</span>` : ''}
                ${p.speed ? `<span class="metric-mini">⚡ ${escapeHtml(p.speed)}</span>` : ''}
              </div>
            </div>
            `;
          }).join("")}
        </div>
        <div class="day-total-badge">
          Gesamt: ⏱️ ${day.duration} Min.${day.distance != null && day.distance !== "" ? ` • 📍 ${day.distance} km` : ''}
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
          <div class="day-card-header-icons">
            ${day.locked ? '<span class="day-locked-pill" title="Aktivität ist für die KI-Generierung fixiert">🔒</span>' : ''}
            <span class="day-icon">${icon}</span>
          </div>
        </div>
        <div class="day-body">
          <div class="day-type-badge badge-${badgeClass}">
            ${typeBadgeLabel}
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
