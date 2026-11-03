// ============================================================
// js/journal.js
// Trainings-Journal: Kalenderansicht für übertragene Trainingspläne,
// manuelles Mapping von Strava-Aktivitäten, RPE (1-5), Beschwerden & KI-Kontext
// ============================================================

import { auth, db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";
import { PLAN_DISCIPLINES } from "./account.js?v=3.7";

let currentUser = null;
let journalEntries = {}; // Map: "YYYY-MM-DD" -> JournalEntry
let journalLoaded = false;
let currentCalendarYear = new Date().getFullYear();
let currentCalendarMonth = new Date().getMonth(); // 0..11
let selectedJournalDate = formatDateKey(new Date());

// In-Memory State für das aktuell geöffnete Detail-Formular
let detailFormState = null;

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTH_NAMES_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

const RPE_LEVELS = [
  { value: 1, label: "Sehr leicht", emoji: "🌱", desc: "Kaum Belastung, sehr locker", colorClass: "rpe-1" },
  { value: 2, label: "Leicht",      emoji: "🙂", desc: "Lockeres Grundlagen-Tempo",   colorClass: "rpe-2" },
  { value: 3, label: "Moderat",     emoji: "💪", desc: "Fordernd, aber gut kontrolliert", colorClass: "rpe-3" },
  { value: 4, label: "Schwer",      emoji: "🥵", desc: "Hohe Anstrengung, intensiv",  colorClass: "rpe-4" },
  { value: 5, label: "Maximal",     emoji: "🔥", desc: "Am absoluten Limit",          colorClass: "rpe-5" }
];

const FEELING_OPTIONS = [
  { id: "great",   label: "Topfit & Energiegeladen", emoji: "⚡" },
  { id: "good",    label: "Gut / Normal",            emoji: "👍" },
  { id: "heavy",   label: "Müde / Schwere Beine",    emoji: "😐" },
  { id: "drained", label: "Erschöpft",               emoji: "😴" }
];

const COMPLAINT_TAGS = [
  "Knie",
  "Achillessehne / Wade",
  "Schienbein",
  "Hüfte / Unterer Rücken",
  "Schulter / Nacken",
  "Muskelkater / Krämpfe",
  "Magen / Verpflegung"
];

/** Formatiert ein Date-Objekt als YYYY-MM-DD (lokale Zeitzone) */
export function formatDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parst einen YYYY-MM-DD String als lokales Date-Objekt (00:00 Uhr) */
function parseDateKey(dateKey) {
  const [y, m, d] = (dateKey || "").split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

/** Liefert den Montag der aktuellen Woche (00:00 Uhr lokal) */
function getMondayOfDate(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay(); // 0 = So, 1 = Mo, ..., 6 = Sa
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return date;
}

/**
 * Initialisiert das Journal-Modul beim Login.
 */
export async function initJournal(user) {
  currentUser = user || auth?.currentUser;
  await ensureJournalLoaded();
  setupJournalDelegation();
}

/**
 * Stellt sicher, dass die Journal-Einträge aus Firestore / LocalStorage geladen sind.
 */
export async function ensureJournalLoaded() {
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return journalEntries;

  if (journalLoaded && Object.keys(journalEntries).length > 0) {
    window.journalEntries = journalEntries;
    return journalEntries;
  }

  // 1. LocalStorage-Fallback schnell vorladen
  try {
    const rawLocal = localStorage.getItem(`tpa_journal_${user.uid}`);
    if (rawLocal) {
      const parsed = JSON.parse(rawLocal);
      if (parsed && typeof parsed === "object") {
        journalEntries = parsed;
      }
    }
  } catch (e) {
    console.warn("[journal] LocalStorage Lese-Warnung:", e);
  }

  // 2. Aus Firestore laden (users/{uid}/cache/journal)
  try {
    const ref = doc(db, "users", user.uid, "cache", "journal");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      if (data?.entries && typeof data.entries === "object") {
        journalEntries = { ...journalEntries, ...data.entries };
        try {
          localStorage.setItem(`tpa_journal_${user.uid}`, JSON.stringify(journalEntries));
        } catch (_) {}
      }
    }
    journalLoaded = true;
  } catch (err) {
    console.warn("[journal] Konnte Journal nicht aus Firestore laden (nutze lokalen Stand):", err);
  }

  window.journalEntries = journalEntries;
  return journalEntries;
}

/**
 * Speichert das gesamte `journalEntries`-Objekt in Firestore und LocalStorage.
 */
async function persistJournalEntries() {
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return;

  window.journalEntries = journalEntries;

  try {
    localStorage.setItem(`tpa_journal_${user.uid}`, JSON.stringify(journalEntries));
  } catch (e) {
    console.warn("[journal] LocalStorage Schreib-Warnung:", e);
  }

  try {
    const ref = doc(db, "users", user.uid, "cache", "journal");
    await setDoc(
      ref,
      {
        entries: journalEntries,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );
  } catch (err) {
    console.error("[journal] Fehler beim Speichern des Journals in Firestore:", err);
    throw err;
  }
}

/**
 * Überträgt einen Trainingsplan (`weekPlan` + `coachNote`) für `weeksCount` Wochen
 * ab dem Montag der aktuellen Woche in den Journal-Kalender.
 */
export async function transferPlanToJournal(plan, weeksCount = 4) {
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) {
    showToast("Bitte logge dich ein, um den Trainingsplan ins Journal zu übertragen.", "error");
    return;
  }

  if (!plan || !plan.weekPlan) {
    showToast("Kein Trainingsplan zum Übertragen vorhanden.", "error");
    return;
  }

  await ensureJournalLoaded();

  const weeks = Math.max(1, Math.min(52, parseInt(weeksCount, 10) || 4));
  const totalDays = weeks * 7;

  // Start am Montag der aktuellen Woche, damit vollständige Kalenderwochen im Journal eingetragen werden
  const startMonday = getMondayOfDate(new Date());
  const jsDayToPlanKey = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  let transferredDays = 0;

  for (let offset = 0; offset < totalDays; offset++) {
    const d = new Date(startMonday.getFullYear(), startMonday.getMonth(), startMonday.getDate() + offset);
    const dateKey = formatDateKey(d);
    const dayKey = jsDayToPlanKey[d.getDay()];
    const dayPlan = plan.weekPlan[dayKey];
    if (!dayPlan) continue;

    const existing = journalEntries[dateKey] || {};

    // Geplante Einheit sauber klonen
    const plannedSnapshot = {
      dayKey,
      type: dayPlan.type || "rest",
      disciplines: Array.isArray(dayPlan.disciplines) ? [...dayPlan.disciplines] : [dayPlan.type || "rest"],
      subtypes: Array.isArray(dayPlan.subtypes) ? [...dayPlan.subtypes] : [],
      parts: Array.isArray(dayPlan.parts) ? dayPlan.parts.map(p => ({ ...p })) : [],
      duration: Number(dayPlan.duration) || 0,
      distance: dayPlan.distance != null && dayPlan.distance !== "" ? Number(dayPlan.distance) : null,
      speed: dayPlan.speed || "",
      intensity: dayPlan.intensity || "easy",
      description: dayPlan.description || "",
      notes: dayPlan.notes || "",
      coachNote: plan.coachNote || "",
      transferredAt: new Date().toISOString()
    };

    journalEntries[dateKey] = {
      dateKey,
      planned: plannedSnapshot,
      mappedActivityIds: Array.isArray(existing.mappedActivityIds) ? existing.mappedActivityIds : [],
      completed: Boolean(existing.completed),
      rpe: existing.rpe ?? null,
      feeling: existing.feeling || "",
      complaintTags: Array.isArray(existing.complaintTags) ? existing.complaintTags : [],
      complaints: existing.complaints || "",
      customNotes: existing.customNotes || "",
      updatedAt: existing.updatedAt || new Date().toISOString()
    };

    transferredDays++;
  }

  await persistJournalEntries();

  // Heute als ausgewähltes Datum setzen, falls noch keins gewählt ist
  const todayKey = formatDateKey(new Date());
  selectedJournalDate = todayKey;
  currentCalendarYear = new Date().getFullYear();
  currentCalendarMonth = new Date().getMonth();
  initDetailFormState(selectedJournalDate);

  // Falls KI-Vorschau existiert, aktualisieren
  if (typeof window.updateAiPreview === "function") {
    window.updateAiPreview();
  }

  const endDate = new Date(startMonday.getFullYear(), startMonday.getMonth(), startMonday.getDate() + totalDays - 1);
  const startStr = startMonday.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  const endStr = endDate.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

  showToast(
    `📓 Trainingsplan für ${weeks} ${weeks === 1 ? "Woche" : "Wochen"} (${startStr} – ${endStr}) ins Journal übertragen!`,
    "success"
  );

  // Direkt zum Journal-Tab wechseln, damit der Nutzer den übertragenen Kalender sofort sieht
  window.location.hash = "journal";
  loadAndRenderJournal();
}

/**
 * Lädt und rendert die komplette Journal-Ansicht im Tab `#view-journal`.
 */
export async function loadAndRenderJournal() {
  const container = document.getElementById("journal-content");
  if (!container) return;

  await ensureJournalLoaded();

  // Sicherstellen, dass Strava-Aktivitäten im Speicher verfügbar sind (für das Mapping)
  await ensureActivitiesForJournal();

  if (!selectedJournalDate) {
    selectedJournalDate = formatDateKey(new Date());
  }
  initDetailFormState(selectedJournalDate);

  renderJournalUI();
}

/**
 * Stellt sicher, dass `window.stravaActivities` geladen ist, damit im Journal Aktivitäten zugeordnet werden können.
 */
async function ensureActivitiesForJournal() {
  if (Array.isArray(window.stravaActivities) && window.stravaActivities.length > 0) {
    return window.stravaActivities;
  }
  const user = currentUser || auth?.currentUser;
  if (!user?.uid) return [];

  try {
    const ref = doc(db, "users", user.uid, "cache", "activities");
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
  } catch (err) {
    console.warn("[journal] Konnte gecachte Aktivitäten für Journal nicht laden:", err);
  }
  return [];
}

/**
 * Initialisiert `detailFormState` für das aktuell ausgewählte Datum `dateKey`.
 */
function initDetailFormState(dateKey) {
  const entry = journalEntries[dateKey] || {};
  detailFormState = {
    dateKey,
    mappedActivityIds: Array.isArray(entry.mappedActivityIds) ? [...entry.mappedActivityIds] : [],
    completed: Boolean(entry.completed || (Array.isArray(entry.mappedActivityIds) && entry.mappedActivityIds.length > 0)),
    rpe: entry.rpe != null ? Number(entry.rpe) : null,
    feeling: entry.feeling || "",
    complaintTags: Array.isArray(entry.complaintTags) ? [...entry.complaintTags] : [],
    complaints: entry.complaints || "",
    customNotes: entry.customNotes || ""
  };
}

/**
 * Rendert das Journal (Monats-KPI-Leiste, Kalender-Grid links, Detail-Editor rechts).
 */
function renderJournalUI() {
  const container = document.getElementById("journal-content");
  if (!container) return;

  const monthTitle = `${MONTH_NAMES_DE[currentCalendarMonth]} ${currentCalendarYear}`;
  const stats = computeMonthStats(currentCalendarYear, currentCalendarMonth);

  container.innerHTML = `
    <!-- Obere Toolbar: Monats-Navigation & Monats-Kennzahlen -->
    <div class="journal-top-bar">
      <div class="journal-month-nav">
        <button type="button" class="btn btn-secondary btn-sm journal-nav-btn" data-action="prev-month" title="Vorheriger Monat">
          ◀
        </button>
        <h4 class="journal-month-title">${escapeHtml(monthTitle)}</h4>
        <button type="button" class="btn btn-secondary btn-sm journal-nav-btn" data-action="next-month" title="Nächster Monat">
          ▶
        </button>
        <button type="button" class="btn btn-secondary btn-sm journal-today-btn" data-action="go-today">
          📅 Heute
        </button>
      </div>

      <div class="journal-kpi-strip">
        <div class="journal-kpi-pill" title="Geplante aktive Trainingstage in diesem Monat">
          <span class="kpi-icon">📋</span>
          <span>Geplant: <strong>${stats.plannedWorkouts}</strong></span>
        </div>
        <div class="journal-kpi-pill kpi-done" title="Absolvierte oder mit Strava-Aktivität verknüpfte Tage in diesem Monat">
          <span class="kpi-icon">✅</span>
          <span>Absolviert: <strong>${stats.completedWorkouts}</strong></span>
        </div>
        <div class="journal-kpi-pill kpi-rpe" title="Durchschnittliches Belastungsempfinden (Skala 1-5) in diesem Monat">
          <span class="kpi-icon">🔥</span>
          <span>Ø RPE: <strong>${stats.avgRpe ? `${stats.avgRpe} / 5` : "–"}</strong></span>
        </div>
        <div class="journal-kpi-pill ${stats.complaintDays > 0 ? "kpi-warn" : ""}" title="Tage mit dokumentierten Beschwerden in diesem Monat">
          <span class="kpi-icon">⚠️</span>
          <span>Beschwerden: <strong>${stats.complaintDays}</strong></span>
        </div>
      </div>
    </div>

    <!-- Master-Detail Grid: Links Kalender, Rechts Detailansicht des gewählten Tages -->
    <div class="journal-master-detail">
      <div class="journal-calendar-panel">
        <div class="journal-weekdays-header">
          ${WEEKDAY_NAMES_SHORT.map(w => `<div class="journal-weekday-cell">${w}</div>`).join("")}
        </div>
        <div class="journal-calendar-grid" id="journal-calendar-grid">
          ${renderCalendarCellsHtml(currentCalendarYear, currentCalendarMonth)}
        </div>
        <div class="journal-calendar-legend">
          <span class="legend-item"><span class="legend-dot dot-planned"></span> Geplante Einheit</span>
          <span class="legend-item"><span class="legend-dot dot-completed"></span> Absolviert / Gemappt</span>
          <span class="legend-item"><span class="legend-dot dot-rpe"></span> RPE (1–5) bewertet</span>
          <span class="legend-item"><span class="legend-dot dot-complaint"></span> Beschwerden vermerkt</span>
        </div>
      </div>

      <div class="journal-detail-panel" id="journal-detail-panel">
        ${renderJournalDetailHtml(selectedJournalDate)}
      </div>
    </div>
  `;
}

/**
 * Berechnet Kennzahlen für den aktuell angezeigten Kalendermonat.
 */
function computeMonthStats(year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  let plannedWorkouts = 0;
  let completedWorkouts = 0;
  let rpeSum = 0;
  let rpeCount = 0;
  let complaintDays = 0;

  for (const [dateKey, entry] of Object.entries(journalEntries)) {
    if (!dateKey.startsWith(prefix) || !entry) continue;

    const planned = entry.planned;
    if (planned) {
      const discs = Array.isArray(planned.disciplines) ? planned.disciplines : [planned.type || "rest"];
      const isRest = discs.length === 1 && discs[0] === "rest" && !(planned.duration > 0);
      if (!isRest) plannedWorkouts++;
    }

    const isDone = Boolean(entry.completed || (Array.isArray(entry.mappedActivityIds) && entry.mappedActivityIds.length > 0));
    if (isDone) completedWorkouts++;

    if (entry.rpe != null && entry.rpe >= 1 && entry.rpe <= 5) {
      rpeSum += Number(entry.rpe);
      rpeCount++;
    }

    const hasComplaints =
      (Array.isArray(entry.complaintTags) && entry.complaintTags.length > 0) ||
      Boolean(entry.complaints && entry.complaints.trim() !== "");
    if (hasComplaints) complaintDays++;
  }

  return {
    plannedWorkouts,
    completedWorkouts,
    avgRpe: rpeCount > 0 ? (rpeSum / rpeCount).toFixed(1) : null,
    complaintDays
  };
}

/**
 * Erzeugt die HTML-Zellen des Monatskalenders (Montag bis Sonntag).
 */
function renderCalendarCellsHtml(year, month) {
  const firstDayOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Wochentag des 1. Tags im Monat (0 = Mo, ..., 6 = So)
  const firstDow = (firstDayOfMonth.getDay() + 6) % 7;

  const todayKey = formatDateKey(new Date());
  const cells = [];

  // Leere / Vormonats-Zellen am Anfang
  const prevMonthDays = new Date(year, month, 0).getDate();
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = new Date(year, month - 1, prevMonthDays - i);
    cells.push(renderSingleCalendarCell(d, true, todayKey));
  }

  // Aktueller Monat
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    cells.push(renderSingleCalendarCell(d, false, todayKey));
  }

  // Folgemonats-Zellen zum Auffüllen auf volle Wochen (Vielfaches von 7)
  const remainder = cells.length % 7;
  if (remainder !== 0) {
    const fillCount = 7 - remainder;
    for (let i = 1; i <= fillCount; i++) {
      const d = new Date(year, month + 1, i);
      cells.push(renderSingleCalendarCell(d, true, todayKey));
    }
  }

  return cells.join("");
}

/**
 * Rendert eine einzelne Tageszelle im Journal-Kalender.
 */
function renderSingleCalendarCell(dateObj, isOutsideMonth, todayKey) {
  const dateKey = formatDateKey(dateObj);
  const dayNum = dateObj.getDate();
  const isToday = dateKey === todayKey;
  const isSelected = dateKey === selectedJournalDate;
  const entry = journalEntries[dateKey];

  const planned = entry?.planned;
  const mappedCount = Array.isArray(entry?.mappedActivityIds) ? entry.mappedActivityIds.length : 0;
  const isCompleted = Boolean(entry?.completed || mappedCount > 0);
  const rpe = entry?.rpe;
  const hasComplaints =
    (Array.isArray(entry?.complaintTags) && entry.complaintTags.length > 0) ||
    Boolean(entry?.complaints && entry.complaints.trim() !== "");
  const hasNotes = Boolean(entry?.customNotes && entry.customNotes.trim() !== "");

  let workoutHtml = "";
  if (planned) {
    const rawDiscs = Array.isArray(planned.disciplines) && planned.disciplines.length > 0
      ? planned.disciplines.map(d => d === "mobility" ? "fitness" : d)
      : [planned.type || "rest"];
    const disciplines = Array.from(new Set(rawDiscs.filter(d => PLAN_DISCIPLINES[d])));
    if (disciplines.length === 0) disciplines.push("rest");

    const sportDiscs = disciplines.filter(d => d !== "rest" && d !== "fitness");
    const isRest = sportDiscs.length === 0 && !disciplines.includes("fitness") && !(planned.duration > 0);
    const icons = disciplines.map(d => PLAN_DISCIPLINES[d]?.icon || "🏋️").join("");
    const labelStr = sportDiscs.length > 1
      ? "Koppel"
      : (disciplines.map(d => PLAN_DISCIPLINES[d]?.label || d).join(" + "));

    const badgeClass = sportDiscs.length > 1
      ? "badge-brick"
      : (PLAN_DISCIPLINES[sportDiscs[0] || disciplines[0]]?.badgeClass || "badge-rest");

    const metricsBits = [];
    if (planned.duration > 0) metricsBits.push(`${planned.duration}m`);
    if (planned.distance != null && planned.distance > 0) metricsBits.push(`${planned.distance}km`);

    workoutHtml = `
      <div class="journal-cell-workout ${badgeClass} ${isRest ? "is-rest-entry" : ""}">
        <div class="cell-workout-top">
          <span class="cell-workout-icons">${icons}</span>
          <span class="cell-workout-title">${escapeHtml(labelStr)}</span>
        </div>
        ${metricsBits.length > 0 ? `<div class="cell-workout-meta">${escapeHtml(metricsBits.join(" • "))}</div>` : ""}
      </div>
    `;
  } else if (mappedCount > 0) {
    workoutHtml = `
      <div class="journal-cell-workout badge-mapped-only">
        <div class="cell-workout-top">
          <span class="cell-workout-icons">🏃</span>
          <span class="cell-workout-title">${mappedCount} ${mappedCount === 1 ? "Einheit" : "Einheiten"}</span>
        </div>
      </div>
    `;
  }

  // Status-Badges unten in der Kalenderzelle
  const statusPills = [];
  if (isCompleted) {
    statusPills.push(`<span class="cell-mini-pill pill-done" title="Absolviert${mappedCount > 0 ? ` (${mappedCount} Strava-Aktivität zugeordnet)` : ""}">✅${mappedCount > 0 ? ` ${mappedCount}` : ""}</span>`);
  }
  if (rpe != null && rpe >= 1 && rpe <= 5) {
    statusPills.push(`<span class="cell-mini-pill pill-rpe rpe-badge-${rpe}" title="Empfundene Anstrengung: ${rpe}/5">RPE ${rpe}</span>`);
  }
  if (hasComplaints) {
    statusPills.push(`<span class="cell-mini-pill pill-complaint" title="Beschwerden dokumentiert">⚠️</span>`);
  }
  if (hasNotes && !hasComplaints && !rpe) {
    statusPills.push(`<span class="cell-mini-pill pill-note" title="Notiz vorhanden">💬</span>`);
  }

  return `
    <button type="button"
      class="journal-day-cell ${isOutsideMonth ? "cell-outside" : ""} ${isToday ? "cell-today" : ""} ${isSelected ? "cell-selected" : ""} ${isCompleted ? "cell-completed" : ""}"
      data-date="${dateKey}"
      aria-label="Journal-Eintrag für ${dateKey}">
      <div class="journal-cell-header">
        <span class="cell-day-number">${dayNum}</span>
        ${isToday ? `<span class="cell-today-tag">Heute</span>` : ""}
      </div>
      <div class="journal-cell-body">
        ${workoutHtml}
      </div>
      ${statusPills.length > 0 ? `<div class="journal-cell-footer">${statusPills.join("")}</div>` : ""}
    </button>
  `;
}

/**
 * Rendert die rechte Detailansicht für den ausgewählten Tag `dateKey`.
 */
function renderJournalDetailHtml(dateKey) {
  const dateObj = parseDateKey(dateKey);
  const formattedDate = dateObj.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });

  const entry = journalEntries[dateKey] || {};
  const planned = entry.planned || null;
  const state = detailFormState || {
    dateKey,
    mappedActivityIds: [],
    completed: false,
    rpe: null,
    feeling: "",
    complaintTags: [],
    complaints: "",
    customNotes: ""
  };

  // 1. Geplante Einheit (Soll) aufbereiten
  let plannedSectionHtml = "";
  if (planned) {
    const rawDiscs = Array.isArray(planned.disciplines) && planned.disciplines.length > 0
      ? planned.disciplines.map(d => d === "mobility" ? "fitness" : d)
      : [planned.type || "rest"];
    const disciplines = Array.from(new Set(rawDiscs.filter(d => PLAN_DISCIPLINES[d])));
    if (disciplines.length === 0) disciplines.push("rest");

    const icons = disciplines.map(d => PLAN_DISCIPLINES[d]?.icon || "🏋️").join(" ");
    const discLabels = disciplines.map(d => PLAN_DISCIPLINES[d]?.label || d).join(" + ");

    const partsHtml = Array.isArray(planned.parts) && planned.parts.length > 0
      ? `
        <div class="journal-planned-parts">
          ${planned.parts.map(p => {
            const pInt = p.intensity === "hard" ? "EB" : (p.intensity === "moderate" ? "GA2" : "GA1");
            return `
              <div class="journal-planned-part-row">
                <span class="part-row-label">${p.icon || "•"} <strong>${escapeHtml(p.label)}</strong></span>
                <span class="part-row-metrics">
                  ${p.duration > 0 ? `⏱️ ${p.duration} Min.` : ""}
                  ${p.distance != null && p.distance > 0 ? ` • 📍 ${p.distance} km` : ""}
                  ${p.speed ? ` • ⚡ ${escapeHtml(p.speed)}` : ""}
                  <span class="part-mini-intensity intensity-${p.intensity || "easy"}">${pInt}</span>
                </span>
              </div>
            `;
          }).join("")}
        </div>
      `
      : `
        <div class="journal-planned-summary-metrics">
          <span>⏱️ ${planned.duration > 0 ? `${planned.duration} Min.` : "Ruhetag"}</span>
          ${planned.distance != null && planned.distance > 0 ? `<span>📍 ${planned.distance} km</span>` : ""}
          ${planned.speed ? `<span>⚡ ${escapeHtml(planned.speed)}</span>` : ""}
        </div>
      `;

    plannedSectionHtml = `
      <div class="journal-detail-section planned-box">
        <div class="section-header-row">
          <span class="section-mini-title">📋 GEPLANTE EINHEIT (SOLL-VORGABE)</span>
          <span class="planned-disc-pill">${icons} ${escapeHtml(discLabels)}</span>
        </div>
        ${partsHtml}
        ${(planned.notes || planned.description) ? `
          <p class="journal-planned-note">💬 ${escapeHtml(planned.notes || planned.description)}</p>
        ` : ""}
      </div>
    `;
  } else {
    plannedSectionHtml = `
      <div class="journal-detail-section planned-box planned-empty">
        <div class="section-header-row">
          <span class="section-mini-title">📋 GEPLANTE EINHEIT</span>
        </div>
        <p class="text-muted" style="font-size: 0.82rem; margin: 0;">
          Für diesen Tag wurde noch kein Trainingsplan-Eintrag übertragen. Du kannst im Reiter <strong>📋 Trainingsplan</strong> deinen Plan über den Button <em>„📓 Ins Journal übertragen“</em> eintragen oder hier direkt eine absolvierte Einheit dokumentieren.
        </p>
      </div>
    `;
  }

  // 2. Strava-Aktivitäten für das manuelle Mapping aufbereiten
  const allActivities = Array.isArray(window.stravaActivities) ? window.stravaActivities : [];
  const mappedActivities = state.mappedActivityIds
    .map(id => allActivities.find(a => String(a.id) === String(id)))
    .filter(Boolean);

  // Aktivitäten der aktuellen Kalenderwoche (Mo-So rund um dateObj) hervorheben
  const weekMonday = getMondayOfDate(dateObj);
  const weekSunday = new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate() + 6, 23, 59, 59);

  const unmappedActivities = allActivities.filter(
    a => a && !state.mappedActivityIds.some(id => String(id) === String(a.id))
  );

  const sameWeekActivities = [];
  const otherActivities = [];

  unmappedActivities.forEach(a => {
    const actDate = new Date(a.start_date_local || a.start_date || 0);
    if (actDate >= weekMonday && actDate <= weekSunday) {
      sameWeekActivities.push(a);
    } else {
      otherActivities.push(a);
    }
  });

  const formatActOption = (a, isSameWeek) => {
    const actDateStr = new Date(a.start_date_local || a.start_date || Date.now()).toLocaleDateString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit"
    });
    const km = ((parseFloat(a.distance) || 0) / 1000).toFixed(1);
    const mins = Math.round((parseFloat(a.moving_time) || 0) / 60);
    const icon = getSportEmoji(a.type);
    const prefix = isSameWeek ? "⭐ " : "";
    return `<option value="${a.id}">${prefix}${icon} ${actDateStr}: ${escapeHtml(a.name || a.type)} (${ mins } Min. • ${km} km)</option>`;
  };

  let selectOptionsHtml = `<option value="">— Strava-Aktivität für diesen Tag auswählen (${allActivities.length} verfügbar) —</option>`;
  if (sameWeekActivities.length > 0) {
    selectOptionsHtml += `<optgroup label="⭐ Aktivitäten aus dieser Trainingswoche (${sameWeekActivities.length})">`;
    selectOptionsHtml += sameWeekActivities.map(a => formatActOption(a, true)).join("");
    selectOptionsHtml += `</optgroup>`;
  }
  if (otherActivities.length > 0) {
    selectOptionsHtml += `<optgroup label="Alle weiteren Strava-Aktivitäten">`;
    selectOptionsHtml += otherActivities.slice(0, 80).map(a => formatActOption(a, false)).join("");
    selectOptionsHtml += `</optgroup>`;
  }

  // Gemappte Aktivitäten als Karten + Soll/Ist-Abgleich
  let mappedCardsHtml = "";
  if (mappedActivities.length > 0) {
    const actualTotalMin = mappedActivities.reduce((sum, a) => sum + Math.round((parseFloat(a.moving_time) || 0) / 60), 0);
    const actualTotalKm = mappedActivities.reduce((sum, a) => sum + ((parseFloat(a.distance) || 0) / 1000), 0);

    mappedCardsHtml = `
      <div class="journal-mapped-list">
        ${mappedActivities.map(a => {
          const icon = getSportEmoji(a.type);
          const km = ((parseFloat(a.distance) || 0) / 1000).toFixed(2);
          const mins = Math.round((parseFloat(a.moving_time) || 0) / 60);
          const hr = a.average_heartrate ? `❤️ Ø ${Math.round(a.average_heartrate)} bpm` : "";
          const actDateStr = new Date(a.start_date_local || a.start_date || Date.now()).toLocaleDateString("de-DE", {
            day: "2-digit", month: "2-digit", year: "numeric"
          });
          return `
            <div class="journal-mapped-act-card">
              <div class="mapped-act-info">
                <span class="mapped-act-icon">${icon}</span>
                <div>
                  <div class="mapped-act-name">${escapeHtml(a.name || a.type)}</div>
                  <div class="mapped-act-sub">
                    📅 ${actDateStr} • ⏱️ ${mins} Min. • 📍 ${km} km ${hr ? `• ${hr}` : ""}
                  </div>
                </div>
              </div>
              <button type="button" class="btn-unmap-act" data-action="unmap-activity" data-act-id="${a.id}" title="Zuordnung aufheben">
                ✕
              </button>
            </div>
          `;
        }).join("")}
      </div>
      ${planned && planned.duration > 0 ? `
        <div class="journal-soll-ist-banner">
          <span>📊 <strong>Soll vs. Ist:</strong></span>
          <span>Dauer: <strong>${actualTotalMin} Min.</strong> / ${planned.duration} Min. geplant</span>
          ${planned.distance > 0 ? `<span>• Distanz: <strong>${actualTotalKm.toFixed(1)} km</strong> / ${planned.distance} km geplant</span>` : ""}
        </div>
      ` : ""}
    `;
  } else {
    mappedCardsHtml = `
      <p class="journal-no-mapped-hint">
        Noch keine Strava-Aktivität zugeordnet. Wähle unten die passende absolvierte Einheit aus, um sie diesem Trainingstag zuzuweisen.
      </p>
    `;
  }

  // 3. RPE-Auswahl (1 bis 5)
  const rpeButtonsHtml = RPE_LEVELS.map(lvl => {
    const isActive = state.rpe === lvl.value;
    return `
      <button type="button"
        class="journal-rpe-btn ${lvl.colorClass} ${isActive ? "active" : ""}"
        data-action="select-rpe"
        data-rpe="${lvl.value}"
        title="${lvl.desc}">
        <span class="rpe-num">${lvl.value}</span>
        <span class="rpe-emoji">${lvl.emoji}</span>
        <span class="rpe-lbl">${lvl.label}</span>
      </button>
    `;
  }).join("");

  // 4. Tagesform / Energielevel
  const feelingButtonsHtml = FEELING_OPTIONS.map(f => {
    const isActive = state.feeling === f.id;
    return `
      <button type="button"
        class="journal-chip-btn ${isActive ? "active" : ""}"
        data-action="select-feeling"
        data-feeling="${f.id}">
        <span>${f.emoji}</span>
        <span>${escapeHtml(f.label)}</span>
      </button>
    `;
  }).join("");

  // 5. Beschwerden-Tags
  const complaintChipsHtml = COMPLAINT_TAGS.map(tag => {
    const isActive = state.complaintTags.includes(tag);
    return `
      <button type="button"
        class="journal-chip-btn chip-complaint ${isActive ? "active" : ""}"
        data-action="toggle-complaint-tag"
        data-tag="${escapeHtml(tag)}">
        <span>${isActive ? "⚠️" : "➕"}</span>
        <span>${escapeHtml(tag)}</span>
      </button>
    `;
  }).join("");

  return `
    <div class="journal-detail-card">
      <!-- Detail Header -->
      <div class="journal-detail-header">
        <div>
          <span class="detail-date-sub">AUSGEWÄHLTER TRAININGSTAG</span>
          <h4 class="detail-date-heading">📅 ${escapeHtml(formattedDate)}</h4>
        </div>
        <div class="journal-header-right-actions">
          <label class="journal-completed-toggle" title="Einheit als erledigt/absolviert markieren">
            <input type="checkbox" id="journal-completed-checkbox" ${state.completed ? "checked" : ""} />
            <span class="completed-toggle-pill ${state.completed ? "is-done" : ""}">
              ${state.completed ? "✅ Absolviert" : "⬜ Als erledigt markieren"}
            </span>
          </label>
          <button type="button" class="btn btn-secondary btn-sm mobile-journal-close-btn" data-action="close-journal-overlay" title="Details schließen">
            ✕ Schließen
          </button>
        </div>
      </div>

      <!-- 1. Geplante Einheit -->
      ${plannedSectionHtml}

      <!-- 2. Manuelles Mapping von Strava-Aktivitäten -->
      <div class="journal-detail-section">
        <div class="section-header-row">
          <span class="section-mini-title">🔗 ABSOLVIERTE AKTIVITÄT ZUORDNEN (MAPPING)</span>
          <span class="section-mini-badge">${mappedActivities.length} zugeordnet</span>
        </div>

        ${mappedCardsHtml}

        <div class="journal-map-controls">
          <select id="journal-activity-select" class="plan-select journal-activity-select" aria-label="Strava-Aktivität auswählen">
            ${selectOptionsHtml}
          </select>
          <button type="button" class="btn btn-secondary btn-sm" data-action="map-selected-activity" style="width: auto; white-space: nowrap;">
            ➕ Zuordnen
          </button>
        </div>
      </div>

      <!-- 3. Subjektives Belastungsempfinden (Skala 1-5) -->
      <div class="journal-detail-section">
        <label class="section-mini-title">
          🔥 WIE SCHWER HAT SICH DIE AKTIVITÄT ANGEFÜHLT? (SKALA 1–5)
        </label>
        <div class="journal-rpe-grid" role="group" aria-label="Belastungsempfinden auf einer Skala von 1 bis 5">
          ${rpeButtonsHtml}
        </div>
      </div>

      <!-- 4. Tagesform / Energielevel -->
      <div class="journal-detail-section">
        <label class="section-mini-title">
          ⚡ TAGESFORM &amp; KÖRPERGEFÜHL
        </label>
        <div class="journal-chips-wrap">
          ${feelingButtonsHtml}
        </div>
      </div>

      <!-- 5. Entstandene Beschwerden / Schmerzen -->
      <div class="journal-detail-section">
        <label class="section-mini-title">
          🩺 MÖGLICHERWEISE ENTSTANDENE BESCHWERDEN / SCHMERZEN
        </label>
        <div class="journal-chips-wrap" style="margin-bottom: 0.6rem;">
          ${complaintChipsHtml}
        </div>
        <input type="text"
          id="journal-complaints-input"
          class="plan-input"
          value="${escapeHtml(state.complaints)}"
          placeholder="Genauere Beschreibung (z. B. Leichtes Ziehen in der linken Achillessehne ab km 10)..." />
      </div>

      <!-- 6. Freitext-Beschreibung / Notizen zur Einheit -->
      <div class="journal-detail-section">
        <label for="journal-notes-textarea" class="section-mini-title">
          📝 NOTIZEN &amp; BESCHREIBUNG ZUR EINHEIT
        </label>
        <textarea id="journal-notes-textarea"
          class="plan-textarea"
          rows="3"
          placeholder="Wie lief die Einheit? Pacing, Wetter, Verpflegung, Technik-Fokus...">${escapeHtml(state.customNotes)}</textarea>
      </div>

      <!-- Speichern & Zurücksetzen -->
      <div class="journal-detail-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="reset-day-feedback" style="width: auto;">
          🗑️ Eingaben zurücksetzen
        </button>
        <button type="button" class="btn btn-primary btn-sm" data-action="save-journal-entry" id="journal-save-entry-btn" style="width: auto;">
          💾 Journal-Eintrag speichern
        </button>
      </div>
    </div>
  `;
}

/**
 * Event-Delegation für den gesamten `#journal-content` Container.
 */
let journalDelegationBound = false;
function setupJournalDelegation() {
  if (journalDelegationBound) return;
  const container = document.getElementById("journal-content");
  if (!container) return;

  journalDelegationBound = true;

  // Backdrop-Klick zum Schließen des Mobile Overlays
  container.addEventListener("click", (e) => {
    const detailPanel = document.getElementById("journal-detail-panel");
    if (detailPanel && e.target === detailPanel) {
      detailPanel.classList.remove("mobile-overlay-open");
      document.body.classList.remove("modal-open");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const detailPanel = document.getElementById("journal-detail-panel");
      detailPanel?.classList.remove("mobile-overlay-open");
      document.body.classList.remove("modal-open");
    }
  });

  container.addEventListener("click", async (e) => {
    // 1. Klick auf eine Kalender-Tageszelle
    const dayCell = e.target.closest(".journal-day-cell");
    if (dayCell && dayCell.dataset.date) {
      syncCurrentInputsIntoState();
      const clickedDate = dayCell.dataset.date;
      const clickedObj = parseDateKey(clickedDate);
      selectedJournalDate = clickedDate;

      // Falls auf einen Tag des Vor-/Folgemonats geklickt wurde, Monat mitwechseln
      if (clickedObj.getFullYear() !== currentCalendarYear || clickedObj.getMonth() !== currentCalendarMonth) {
        currentCalendarYear = clickedObj.getFullYear();
        currentCalendarMonth = clickedObj.getMonth();
      }

      initDetailFormState(selectedJournalDate);
      renderJournalUI();
      if (window.innerWidth <= 1120) {
        const detailPanel = document.getElementById("journal-detail-panel");
        detailPanel?.classList.add("mobile-overlay-open");
        document.body.classList.add("modal-open");
      }
      return;
    }

    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === "prev-month") {
      currentCalendarMonth--;
      if (currentCalendarMonth < 0) {
        currentCalendarMonth = 11;
        currentCalendarYear--;
      }
      renderJournalUI();
      return;
    }

    if (action === "next-month") {
      currentCalendarMonth++;
      if (currentCalendarMonth > 11) {
        currentCalendarMonth = 0;
        currentCalendarYear++;
      }
      renderJournalUI();
      return;
    }

    if (action === "go-today") {
      const now = new Date();
      currentCalendarYear = now.getFullYear();
      currentCalendarMonth = now.getMonth();
      selectedJournalDate = formatDateKey(now);
      initDetailFormState(selectedJournalDate);
      renderJournalUI();
      return;
    }

    if (action === "select-rpe") {
      syncCurrentInputsIntoState();
      const val = parseInt(actionEl.dataset.rpe, 10);
      if (detailFormState) {
        detailFormState.rpe = detailFormState.rpe === val ? null : val;
        refreshDetailPanelOnly();
      }
      return;
    }

    if (action === "select-feeling") {
      syncCurrentInputsIntoState();
      const feelingId = actionEl.dataset.feeling;
      if (detailFormState) {
        detailFormState.feeling = detailFormState.feeling === feelingId ? "" : feelingId;
        refreshDetailPanelOnly();
      }
      return;
    }

    if (action === "toggle-complaint-tag") {
      syncCurrentInputsIntoState();
      const tag = actionEl.dataset.tag;
      if (detailFormState && tag) {
        const idx = detailFormState.complaintTags.indexOf(tag);
        if (idx > -1) {
          detailFormState.complaintTags.splice(idx, 1);
        } else {
          detailFormState.complaintTags.push(tag);
        }
        refreshDetailPanelOnly();
      }
      return;
    }

    if (action === "map-selected-activity") {
      syncCurrentInputsIntoState();
      const selectEl = document.getElementById("journal-activity-select");
      const actId = selectEl?.value;
      if (!actId) {
        showToast("Bitte wähle zuerst eine Strava-Aktivität aus der Liste aus.", "info");
        return;
      }
      if (detailFormState) {
        if (!detailFormState.mappedActivityIds.some(id => String(id) === String(actId))) {
          detailFormState.mappedActivityIds.push(actId);
        }
        detailFormState.completed = true;
        await saveCurrentDetailState(false);
        showToast("🔗 Strava-Aktivität dem Trainingstag zugeordnet!", "success");
      }
      return;
    }

    if (action === "unmap-activity") {
      syncCurrentInputsIntoState();
      const actId = actionEl.dataset.actId;
      if (detailFormState && actId) {
        detailFormState.mappedActivityIds = detailFormState.mappedActivityIds.filter(
          id => String(id) !== String(actId)
        );
        await saveCurrentDetailState(false);
        showToast("Zuordnung der Aktivität aufgehoben.", "info");
      }
      return;
    }

    if (action === "close-journal-overlay") {
      const detailPanel = document.getElementById("journal-detail-panel");
      detailPanel?.classList.remove("mobile-overlay-open");
      document.body.classList.remove("modal-open");
      return;
    }

    if (action === "save-journal-entry") {
      syncCurrentInputsIntoState();
      await saveCurrentDetailState(true);
      return;
    }

    if (action === "reset-day-feedback") {
      if (!detailFormState) return;
      detailFormState.mappedActivityIds = [];
      detailFormState.completed = false;
      detailFormState.rpe = null;
      detailFormState.feeling = "";
      detailFormState.complaintTags = [];
      detailFormState.complaints = "";
      detailFormState.customNotes = "";
      await saveCurrentDetailState(false);
      showToast("🗑️ Eingaben für diesen Tag zurückgesetzt.", "info");
      return;
    }
  });

  // Checkbox-Änderung für "Absolviert"
  container.addEventListener("change", (e) => {
    if (e.target && e.target.id === "journal-completed-checkbox") {
      syncCurrentInputsIntoState();
      if (detailFormState) {
        detailFormState.completed = Boolean(e.target.checked);
        refreshDetailPanelOnly();
      }
    }
  });
}

/**
 * Liest die Textfelder (`#journal-complaints-input` und `#journal-notes-textarea`)
 * in `detailFormState` ein, bevor neu gerendert oder gespeichert wird.
 */
function syncCurrentInputsIntoState() {
  if (!detailFormState) return;
  const complaintsEl = document.getElementById("journal-complaints-input");
  const notesEl = document.getElementById("journal-notes-textarea");
  const completedEl = document.getElementById("journal-completed-checkbox");

  if (complaintsEl) detailFormState.complaints = complaintsEl.value;
  if (notesEl) detailFormState.customNotes = notesEl.value;
  if (completedEl) detailFormState.completed = Boolean(completedEl.checked);
}

/**
 * Aktualisiert nur das rechte Detail-Panel ohne den Kalender neu aufzubauen.
 */
function refreshDetailPanelOnly() {
  const detailPanel = document.getElementById("journal-detail-panel");
  if (detailPanel && selectedJournalDate) {
    detailPanel.innerHTML = renderJournalDetailHtml(selectedJournalDate);
  }
}

/**
 * Speichert `detailFormState` für `selectedJournalDate` in `journalEntries` + Firestore.
 */
async function saveCurrentDetailState(showSuccessToast = true) {
  if (!detailFormState || !selectedJournalDate) return;

  const saveBtn = document.getElementById("journal-save-entry-btn");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Speichere…";
  }

  try {
    const existing = journalEntries[selectedJournalDate] || {};
    journalEntries[selectedJournalDate] = {
      ...existing,
      dateKey: selectedJournalDate,
      planned: existing.planned || null,
      mappedActivityIds: [...detailFormState.mappedActivityIds],
      completed: Boolean(detailFormState.completed || detailFormState.mappedActivityIds.length > 0),
      rpe: detailFormState.rpe,
      feeling: detailFormState.feeling,
      complaintTags: [...detailFormState.complaintTags],
      complaints: (detailFormState.complaints || "").trim(),
      customNotes: (detailFormState.customNotes || "").trim(),
      updatedAt: new Date().toISOString()
    };

    await persistJournalEntries();
    renderJournalUI();

    if (typeof window.updateAiPreview === "function") {
      window.updateAiPreview();
    }

    if (showSuccessToast) {
      showToast("💾 Journal-Eintrag erfolgreich gespeichert!", "success");
    }
  } catch (err) {
    showToast("Fehler beim Speichern des Journal-Eintrags: " + err.message, "error");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "💾 Journal-Eintrag speichern";
    }
  }
}

/**
 * Erstellt die strukturierte Journal-Zusammenfassung für die KI-Prompts im Tab "KI-Assistenz".
 * Wird sowohl bei der Plan-Analyse als auch bei der Generierung eines neuen Trainingsplans übergeben.
 */
export async function getJournalContextForAI(timeframeDays = 30) {
  await ensureJournalLoaded();
  await ensureActivitiesForJournal();

  const allActivities = Array.isArray(window.stravaActivities) ? window.stravaActivities : [];
  const now = new Date();
  const cutoffPast = new Date(now.getFullYear(), now.getMonth(), now.getDate() - timeframeDays);
  const cutoffPastKey = formatDateKey(cutoffPast);
  const todayKey = formatDateKey(now);

  // Alle relevanten Einträge seit cutoffPast bis heute (plus Einträge mit explizitem Nutzer-Feedback)
  const relevantEntries = Object.values(journalEntries || {})
    .filter(e => {
      if (!e || !e.dateKey) return false;
      const hasFeedback =
        Boolean(e.completed) ||
        (Array.isArray(e.mappedActivityIds) && e.mappedActivityIds.length > 0) ||
        e.rpe != null ||
        Boolean(e.feeling) ||
        (Array.isArray(e.complaintTags) && e.complaintTags.length > 0) ||
        Boolean(e.complaints && e.complaints.trim() !== "") ||
        Boolean(e.customNotes && e.customNotes.trim() !== "");
      if (hasFeedback && e.dateKey >= cutoffPastKey) return true;
      if (e.planned && e.dateKey >= cutoffPastKey && e.dateKey <= todayKey) return true;
      return false;
    })
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  if (relevantEntries.length === 0) {
    return {
      entriesCount: 0,
      feedbackCount: 0,
      complaintsCount: 0,
      promptText: "Keine dokumentierten Journal-Einträge im gewählten Analyse-Zeitraum vorhanden."
    };
  }

  const feelingMap = {
    great: "Topfit & Energiegeladen",
    good: "Gut / Normal",
    heavy: "Müde / Schwere Beine",
    drained: "Erschöpft"
  };

  let feedbackCount = 0;
  let rpeSum = 0;
  let rpeCount = 0;
  const allComplaintsList = [];
  const entryLines = [];

  relevantEntries.forEach(e => {
    const dObj = parseDateKey(e.dateKey);
    const dateLabel = dObj.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });

    const planned = e.planned;
    let plannedStr = "Keine geplante Vorgabe";
    if (planned) {
      const discs = Array.isArray(planned.disciplines) ? planned.disciplines.join("+") : (planned.type || "rest");
      plannedStr = `${planned.description || discs}${planned.duration > 0 ? ` (${planned.duration} Min.${planned.distance ? `, ${planned.distance} km` : ""})` : ""}`;
    }

    const mappedActs = (e.mappedActivityIds || [])
      .map(id => allActivities.find(a => String(a.id) === String(id)))
      .filter(Boolean);

    const mappedStr = mappedActs.length > 0
      ? mappedActs.map(a => {
          const km = ((parseFloat(a.distance) || 0) / 1000).toFixed(1);
          const mins = Math.round((parseFloat(a.moving_time) || 0) / 60);
          return `${a.name || a.type} (${mins} Min., ${km} km${a.average_heartrate ? `, Ø HF ${Math.round(a.average_heartrate)} bpm` : ""})`;
        }).join(" + ")
      : (e.completed ? "Manuell als absolviert markiert" : "Noch keine Aktivität zugeordnet / offen");

    const details = [];
    if (e.rpe != null) {
      const rpeMeta = RPE_LEVELS.find(r => r.value === Number(e.rpe));
      details.push(`Subjektive Anstrengung (RPE): ${e.rpe}/5 (${rpeMeta?.label || ""})`);
      rpeSum += Number(e.rpe);
      rpeCount++;
    }
    if (e.feeling && feelingMap[e.feeling]) {
      details.push(`Tagesform: ${feelingMap[e.feeling]}`);
    }

    const complaintItems = [
      ...(Array.isArray(e.complaintTags) ? e.complaintTags : []),
      ...(e.complaints ? [e.complaints] : [])
    ];
    if (complaintItems.length > 0) {
      const cStr = complaintItems.join(" – ");
      details.push(`⚠️ BESCHWERDEN/SCHMERZEN: ${cStr}`);
      allComplaintsList.push(`${dateLabel}: ${cStr}`);
    }

    if (e.customNotes) {
      details.push(`Athleten-Notiz: "${e.customNotes}"`);
    }

    if (e.completed || mappedActs.length > 0 || e.rpe != null || complaintItems.length > 0 || e.customNotes) {
      feedbackCount++;
    }

    entryLines.push(
      `- [${dateLabel}] Soll: ${plannedStr} | Ist: ${mappedStr}${details.length > 0 ? `\n    -> ${details.join(" | ")}` : ""}`
    );
  });

  const avgRpeStr = rpeCount > 0 ? `${(rpeSum / rpeCount).toFixed(1)} / 5 (aus ${rpeCount} bewerteten Einheiten)` : "Keine RPE-Bewertungen";
  const complaintsSummary = allComplaintsList.length > 0
    ? `⚠️ ACHTUNG – Dokumentierte Beschwerden (${allComplaintsList.length}):\n  * ${allComplaintsList.join("\n  * ")}`
    : "Keine körperlichen Beschwerden im Journal dokumentiert.";

  const promptText = `Zusammenfassung aus dem Trainings-Journal (letzte ${timeframeDays} Tage):
- Dokumentierte Journal-Tage im Zeitraum: ${relevantEntries.length} (davon ${feedbackCount} mit Rückmeldung/Abschluss)
- Durchschnittliches subjektives Belastungsempfinden (RPE 1-5): ${avgRpeStr}
- ${complaintsSummary}

Detaillierte Journal-Einträge (Soll vs. Ist, RPE 1-5, Tagesform, Beschwerden & Notizen):
${entryLines.slice(-28).join("\n")}`;

  return {
    entriesCount: relevantEntries.length,
    feedbackCount,
    complaintsCount: allComplaintsList.length,
    promptText
  };
}

function getSportEmoji(type = "") {
  const t = type.toLowerCase();
  if (t.includes("swim")) return "🏊";
  if (t.includes("ride") || t.includes("bike") || t.includes("virtualride")) return "🚴";
  if (t.includes("run")) return "🏃";
  return "🏋️";
}

function escapeHtml(str) {
  return (str || "").toString().replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

