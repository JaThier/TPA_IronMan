// ============================================================
// js/account.js
// Benutzer-Konto, Profilverwaltung & Onboarding-Namensabfrage
// ============================================================

import { auth, db } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, addDoc, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";
import { loadAndRenderHub, publishUserStatsToHub } from "./hub.js";

let currentUser = null;
let currentAccountPlan = null;
let editorState = {};

/**
 * Initialisiert den Konto-Reiter.
 * @param {import("firebase/auth").User} user
 */
export async function initAccount(user) {
  currentUser = user;

  // Profil-Daten laden und Formular befüllen
  await renderAccountProfile();

  // Onboarding prüfen: Falls kein Anzeigename existiert, Modal anzeigen
  await checkAndPromptFirstLoginName(user);

  // Formular-Listener
  const form = document.getElementById("account-profile-form");
  form?.addEventListener("submit", handleAccountFormSubmit);

  // Trainingsplan auf der Konto-Seite initialisieren und laden
  setupAccountPlanListeners();
  await loadAndRenderAccountPlan();
}

/**
 * Prüft beim Login, ob der Nutzer bereits einen Namen hinterlegt hat.
 * Falls nicht, öffnet sich das Willkommens-Modal zur Namenseingabe.
 * @param {import("firebase/auth").User} user
 */
export async function checkAndPromptFirstLoginName(user) {
  if (!user) return;

  try {
    const profileRef = doc(db, "users", user.uid, "profile", "main");
    const snap = await getDoc(profileRef);
    const profileData = snap.exists() ? snap.data() : null;

    const existingName = user.displayName || profileData?.displayName || profileData?.name;

    // Wenn noch kein richtiger Name hinterlegt ist (oder nur E-Mail)
    if (!existingName || existingName.trim() === "" || existingName.includes("@")) {
      const modal = document.getElementById("name-modal");
      const input = document.getElementById("onboarding-name-input");
      if (modal && input) {
        // Vorschlag aus E-Mail oder Strava generieren
        const stravaRef = doc(db, "users", user.uid, "profile", "strava");
        const stravaSnap = await getDoc(stravaRef);
        let suggestedName = "";
        if (stravaSnap.exists() && stravaSnap.data()?.athleteName) {
          suggestedName = stravaSnap.data().athleteName;
        } else {
          suggestedName = user.email.split("@")[0];
        }

        input.value = suggestedName;
        modal.classList.remove("hidden");
        input.focus();
      }
    }
  } catch (err) {
    console.error("[account] Fehler beim Prüfen des Profilnamens:", err);
  }
}

/**
 * Speichert den Onboarding-Namen aus dem Modal.
 */
window.saveOnboardingName = async function () {
  const input = document.getElementById("onboarding-name-input");
  const modal = document.getElementById("name-modal");
  const btn = document.getElementById("onboarding-save-btn");

  const name = input?.value.trim();
  if (!name) {
    showToast("Bitte gib einen Namen ein.", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Speichere Name…";
  }

  try {
    await updateAthleteName(name);
    modal?.classList.add("hidden");
    showToast(`Willkommen, ${name}! Dein Name wurde gespeichert. 🎉`, "success");
    await renderAccountProfile();
  } catch (err) {
    console.error("[account] Fehler beim Speichern des Onboarding-Namens:", err);
    showToast("Konnte Name nicht speichern: " + err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Speichern & Dashboard starten";
    }
  }
};

/**
 * Behandelt das Absenden des Profil-Formulars im Reiter "Konto".
 */
async function handleAccountFormSubmit(e) {
  e.preventDefault();

  const nameInput = document.getElementById("account-name-input");
  const saveBtn = document.getElementById("account-save-btn");
  const newName = nameInput?.value.trim();

  if (!newName) {
    showToast("Der Name darf nicht leer sein.", "error");
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Speichere…";
  }

  try {
    await updateAthleteName(newName);
    await renderAccountProfile();
    showToast("Profilname erfolgreich aktualisiert! ✅", "success");
  } catch (err) {
    console.error("[account] Fehler beim Aktualisieren des Namens:", err);
    showToast("Fehler beim Speichern: " + err.message, "error");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "💾 Änderungen speichern";
    }
  }
}

/**
 * Zentrale Funktion zum Aktualisieren des Namens an allen Stellen:
 * 1. Firebase Auth Profile
 * 2. Firestore: users/{uid}/profile/main
 * 3. Firestore: hub/{uid} (sofortige Synchronisation im Hub)
 * 4. UI: Navbar Badge & Avatar
 * @param {string} newName
 */
export async function updateAthleteName(newName) {
  const user = currentUser || auth.currentUser;
  if (!user) return;

  // 1. Firebase Auth Profile aktualisieren
  if (auth.currentUser) {
    await updateProfile(auth.currentUser, {
      displayName: newName,
    });
  }

  // 2. Firestore Profil speichern
  const profileRef = doc(db, "users", user.uid, "profile", "main");
  await setDoc(profileRef, {
    displayName: newName,
    name: newName,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // 3. Im Hub aktualisieren (inkl. UID und E-Mail)
  const hubRef = doc(db, "hub", user.uid);
  await setDoc(hubRef, {
    uid: user.uid,
    name: newName,
    email: user.email,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // 4. Navbar aktualisieren
  updateNavbarUserBadge(newName, user.email);

  // 5. Hub-Statistiken sofort mit neuem Namen synchronisieren & neu rendern
  const acts = window.stravaActivities || [];
  const tokens = window.stravaTokens || null;
  if (acts.length > 0) {
    await publishUserStatsToHub(acts, tokens);
  } else {
    await loadAndRenderHub();
  }
}

/**
 * Rendert die Profilübersicht im Konto-Reiter.
 */
async function renderAccountProfile() {
  if (!currentUser) return;

  try {
    const profileRef = doc(db, "users", currentUser.uid, "profile", "main");
    const snap = await getDoc(profileRef);
    const profile = snap.exists() ? snap.data() : {};

    const stravaRef = doc(db, "users", currentUser.uid, "profile", "strava");
    const stravaSnap = await getDoc(stravaRef);
    const strava = stravaSnap.exists() ? stravaSnap.data() : null;

    const currentName = currentUser.displayName || profile.displayName || profile.name || currentUser.email.split("@")[0];

    // Formular-Werte setzen
    const nameInput = document.getElementById("account-name-input");
    const emailInput = document.getElementById("account-email-input");
    const avatarLarge = document.getElementById("account-avatar-large");
    const heroName = document.getElementById("account-hero-name");
    const heroEmail = document.getElementById("account-hero-email");
    const stravaBadge = document.getElementById("account-strava-badge");

    if (nameInput) nameInput.value = currentName;
    if (emailInput) emailInput.value = currentUser.email;
    if (heroName) heroName.textContent = currentName;
    if (heroEmail) heroEmail.textContent = currentUser.email;
    if (avatarLarge) avatarLarge.textContent = currentName.charAt(0).toUpperCase();

    // Strava-Status Badge
    if (stravaBadge) {
      if (strava?.accessToken) {
        stravaBadge.innerHTML = `
          <span class="badge-status-dot dot-green"></span>
          <span>Verbunden mit Strava (${strava.athleteName || 'Aktiv'})</span>
        `;
      } else {
        stravaBadge.innerHTML = `
          <span class="badge-status-dot dot-gray"></span>
          <span>Nicht mit Strava verbunden</span>
        `;
      }
    }

    // Navbar Badge synchronisieren
    updateNavbarUserBadge(currentName, currentUser.email);

  } catch (err) {
    console.error("[account] Fehler beim Laden des Kontoprofils:", err);
  }
}

/** Hilfsfunktion zum Aktualisieren des Avatar/Name-Badges in der Navbar */
export function updateNavbarUserBadge(displayName, email) {
  const nameEl = document.getElementById("user-email");
  const avatarEl = document.getElementById("user-avatar");

  const nameToShow = displayName || email?.split("@")[0] || "Athlet";
  if (nameEl) nameEl.textContent = nameToShow;
  if (avatarEl) avatarEl.textContent = nameToShow.charAt(0).toUpperCase();
}

// ============================================================
// TRAININGSPLAN AUF DER KONTO-SEITE (VIEWER & MANUELLER EDITOR)
// ============================================================

const PLAN_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const PLAN_WEEKDAY_CONFIG = {
  monday:    { short: "Mo", full: "Montag" },
  tuesday:   { short: "Di", full: "Dienstag" },
  wednesday: { short: "Mi", full: "Mittwoch" },
  thursday:  { short: "Do", full: "Donnerstag" },
  friday:    { short: "Fr", full: "Freitag" },
  saturday:  { short: "Sa", full: "Samstag" },
  sunday:    { short: "So", full: "Sonntag" },
};

export const PLAN_DISCIPLINES = {
  ride: {
    id: "ride",
    label: "Rad",
    fullLabel: "Radfahren",
    icon: "🚴",
    badgeClass: "badge-ride",
    speedPlaceholder: "z. B. 32 km/h oder 220 W",
    subtypes: [
      { id: "intervalle", label: "Intervalle", icon: "⚡" },
      { id: "endurance",  label: "Endurance",  icon: "🔋" },
      { id: "schwelle",   label: "Schwelle",   icon: "🔥" },
    ]
  },
  run: {
    id: "run",
    label: "Laufen",
    fullLabel: "Laufen",
    icon: "🏃",
    badgeClass: "badge-run",
    speedPlaceholder: "z. B. 5:15 min/km",
    subtypes: [
      { id: "longrun",    label: "Longrun",    icon: "🏃‍♂️" },
      { id: "intervalle", label: "Intervalle", icon: "⚡" },
      { id: "zone2",      label: "Zone 2",     icon: "💚" },
    ]
  },
  swim: {
    id: "swim",
    label: "Schwimmen",
    fullLabel: "Schwimmen",
    icon: "🏊",
    badgeClass: "badge-swim",
    speedPlaceholder: "z. B. 1:45 min/100m",
    subtypes: [
      { id: "technik",    label: "Technik",    icon: "🎯" },
      { id: "distance",   label: "Distance",   icon: "🌊" },
      { id: "intervalle", label: "Intervalle", icon: "⚡" },
    ]
  },
  rest: {
    id: "rest",
    label: "Restday",
    fullLabel: "Ruhetag",
    icon: "😴",
    badgeClass: "badge-rest",
    speedPlaceholder: "–",
    subtypes: [
      { id: "ruhe",       label: "Komplette Ruhe",         icon: "🛏️" },
      { id: "mobility",   label: "Stretching & Mobilität", icon: "🧘" },
      { id: "blackroll",  label: "Faszien / Blackroll",   icon: "🪵" },
    ]
  },
  brick: {
    id: "brick",
    label: "Koppel",
    fullLabel: "Koppeltraining",
    icon: "🏊🚴",
    badgeClass: "badge-brick",
    speedPlaceholder: "z. B. Race Pace",
    subtypes: [
      { id: "rad_lauf",   label: "Rad + Lauf Kopplung",   icon: "🔄" },
      { id: "race_pace",  label: "Wettkampftempo",        icon: "🏁" },
      { id: "wechsel",    label: "Wechselzone",           icon: "⏱️" },
    ]
  }
};

/** Vorlagen für 1-Klick-Erstellung */
const IRONMAN_TEMPLATE = {
  coachNote: "Solide Ironman-Woche: Fokus auf Schwellenintervallen am Dienstag, saubere Kraul-Technik am Mittwoch und Longrun mit Verpflegungstest am Sonntag.",
  weekPlan: {
    monday: {
      type: "rest",
      subtypes: ["ruhe", "mobility"],
      duration: 0,
      distance: null,
      speed: "",
      intensity: "easy",
      description: "Ruhetag & Mobilität",
      notes: "Aktive Erholung, 20 Min. Dehnen und Faszienrolle für Beine und Rücken."
    },
    tuesday: {
      type: "ride",
      subtypes: ["intervalle", "schwelle"],
      duration: 75,
      distance: 35,
      speed: "32 km/h",
      intensity: "hard",
      description: "Rad-Schwellenintervalle",
      notes: "15min Warmup, 3x 10min Schwellenbereich (85-90 rpm, 5min Pause), 15min Cooldown."
    },
    wednesday: {
      type: "swim",
      subtypes: ["technik", "intervalle"],
      duration: 60,
      distance: 2.5,
      speed: "1:45 min/100m",
      intensity: "moderate",
      description: "Schwimmtechnik & Intervalle",
      notes: "400m Einschwimmen, 400m Technik (Abschlag, Einarmig), 10x 100m zügig (20s Pause), 200m Ausschwimmen."
    },
    thursday: {
      type: "run",
      subtypes: ["zone2"],
      duration: 60,
      distance: 11,
      speed: "5:25 min/km",
      intensity: "easy",
      description: "Grundlagenlauf (Zone 2)",
      notes: "Lockerer Dauerlauf im Grundlagenbereich. Puls strikt unter 145 bpm halten."
    },
    friday: {
      type: "swim",
      subtypes: ["distance", "technik"],
      duration: 50,
      distance: 2.2,
      speed: "1:50 min/100m",
      intensity: "easy",
      description: "Dauerschwimmen & Ausdauer",
      notes: "Ausdauerserie mit Pullbuoy und Paddles, Fokus auf sauberen Zug und hohe Ellbogen."
    },
    saturday: {
      type: "ride",
      subtypes: ["endurance", "schwelle"],
      duration: 150,
      distance: 75,
      speed: "30 km/h",
      intensity: "moderate",
      description: "Lange Ausfahrt mit Tempoblöcken",
      notes: "Grundlagenausfahrt mit 2x 15min im geplanten Wettkampftempo. Regelmäßig Kohlenhydrate zuführen."
    },
    sunday: {
      type: "run",
      subtypes: ["longrun", "zone2"],
      duration: 105,
      distance: 18,
      speed: "5:45 min/km",
      intensity: "moderate",
      description: "Langer Vorbereitungslauf (Longrun)",
      notes: "Konstantes Wohlfühltempo, die letzten 3 km leicht progressiv. Gels alle 25 Min. testen."
    }
  }
};

const RESET_TEMPLATE = {
  coachNote: "Regenerationswoche / Komplette Erholung",
  weekPlan: {
    monday:    { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    tuesday:   { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    wednesday: { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    thursday:  { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    friday:    { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    saturday:  { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    sunday:    { type: "rest", subtypes: ["ruhe"], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." }
  }
};

/**
 * Lädt den aktuellsten Trainingsplan des Athleten aus Firestore.
 */
export async function loadAndRenderAccountPlan() {
  const user = currentUser || auth.currentUser;
  if (!user?.uid) return;

  setupAccountPlanListeners();

  try {
    const plansRef = collection(db, "users", user.uid, "trainingPlans");
    const q = query(plansRef, orderBy("createdAt", "desc"), limit(1));
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      const planDoc = snapshot.docs[0];
      currentAccountPlan = { id: planDoc.id, ...planDoc.data() };
      renderAccountPlanView(currentAccountPlan);
    } else {
      currentAccountPlan = null;
      renderAccountPlanView(null);
    }
  } catch (err) {
    console.error("[account] Fehler beim Laden des aktuellen Trainingsplans:", err);
    renderAccountPlanView(null);
  }
}

/**
 * Rendert die Wochenübersicht (Anzeigemodus).
 */
function renderAccountPlanView(plan) {
  const viewContainer = document.getElementById("account-plan-view-container");
  const editContainer = document.getElementById("account-plan-edit-container");
  const toggleBtn = document.getElementById("account-plan-toggle-mode-btn");
  const statusBadge = document.getElementById("account-plan-status-badge");
  const daysGrid = document.getElementById("account-plan-days-grid");
  const coachNoteBox = document.getElementById("account-plan-coach-note-box");
  const coachNoteText = document.getElementById("account-plan-coach-note-text");

  if (viewContainer) viewContainer.classList.remove("hidden");
  if (editContainer) editContainer.classList.add("hidden");
  if (toggleBtn) {
    toggleBtn.innerHTML = `<span class="btn-icon">✏️</span> <span id="account-plan-toggle-text">Plan bearbeiten</span>`;
  }

  if (!plan || !plan.weekPlan) {
    if (statusBadge) statusBadge.textContent = "Kein Plan hinterlegt";
    if (coachNoteBox) coachNoteBox.classList.add("hidden");
    if (daysGrid) {
      daysGrid.innerHTML = `
        <div class="empty-plan-card account-empty-plan" style="grid-column: 1 / -1;">
          <span class="empty-icon" style="font-size: 2.5rem; display: block; margin-bottom: 0.5rem;">📋</span>
          <h4 style="margin-bottom: 0.5rem; font-size: 1.15rem;">Noch kein Trainingsplan hinterlegt</h4>
          <p style="color: var(--clr-text-muted); max-width: 500px; margin: 0 auto 1.25rem;">
            Du kannst deinen individuellen Trainingsplan für die Woche jetzt manuell erstellen oder im Reiter <strong>Trainingsplan</strong> von der KI generieren lassen.
          </p>
          <button type="button" id="btn-create-first-plan" class="btn btn-primary" style="width: auto;">
            ➕ Trainingsplan jetzt manuell erstellen
          </button>
        </div>
      `;
      document.getElementById("btn-create-first-plan")?.addEventListener("click", () => {
        openAccountPlanEditor(null);
      });
    }
    return;
  }

  // Status-Badge
  if (statusBadge) {
    const dateFormatted = plan.createdAt ? formatPlanDate(plan.createdAt) : "Aktuell";
    const originLabel = plan.aiGenerated ? "🤖 KI-optimiert" : "✏️ Manuell erstellt";
    statusBadge.textContent = `${originLabel} • ${dateFormatted}`;
  }

  // Coach-Notiz
  if (plan.coachNote && plan.coachNote.trim() !== "" && coachNoteBox && coachNoteText) {
    coachNoteText.textContent = plan.coachNote;
    coachNoteBox.classList.remove("hidden");
  } else if (coachNoteBox) {
    coachNoteBox.classList.add("hidden");
  }

  // 7-Tage-Grid rendern
  const week = plan.weekPlan || {};
  if (daysGrid) {
    daysGrid.innerHTML = PLAN_WEEKDAYS.map((dayKey) => {
      const dayConf = PLAN_WEEKDAY_CONFIG[dayKey];
      const day = week[dayKey] || { type: "rest", duration: 0, description: "Ruhetag", intensity: "easy" };
      const disc = PLAN_DISCIPLINES[day.type] || PLAN_DISCIPLINES.rest;
      const isRest = day.type === "rest";

      // Subtype-Chips
      let chipsHtml = "";
      if (Array.isArray(day.subtypes) && day.subtypes.length > 0) {
        chipsHtml = day.subtypes.map((st) => {
          const lbl = getSubtypeLabel(day.type, st);
          const icon = getSubtypeIcon(day.type, st);
          return `<span class="subtype-pill"><span class="pill-icon">${icon}</span>${escapeHtml(lbl)}</span>`;
        }).join("");
      }

      // Metriken (Dauer, Distanz, Speed/Pace)
      const metricItems = [];
      metricItems.push(`<span class="metric-pill" title="Dauer">⏱️ ${day.duration > 0 ? `${day.duration} Min.` : 'Ruhetag'}</span>`);
      if (day.distance !== null && day.distance !== "" && day.distance !== undefined && day.distance > 0) {
        metricItems.push(`<span class="metric-pill" title="Distanz">📍 ${day.distance} km</span>`);
      }
      if (day.speed && day.speed.trim() !== "") {
        metricItems.push(`<span class="metric-pill" title="Geschwindigkeit/Pace">⚡ ${escapeHtml(day.speed)}</span>`);
      }

      // Notizen / Sonstige Infos
      const noteContent = day.notes || day.description || "";

      return `
        <div class="account-plan-day-card ${isRest ? 'card-rest' : ''}">
          <div class="day-card-top">
            <span class="day-label-short">${dayConf.short}</span>
            <span class="day-discipline-icon" aria-hidden="true">${disc.icon}</span>
          </div>

          <div class="day-card-body">
            <div class="day-badge-wrap">
              <span class="day-badge ${disc.badgeClass}">${disc.label.toUpperCase()}</span>
            </div>

            ${chipsHtml ? `<div class="day-subtype-pills">${chipsHtml}</div>` : ''}

            <div class="day-metrics-row">
              ${metricItems.join("")}
            </div>

            ${noteContent ? `<p class="day-note-text" title="${escapeHtml(noteContent)}">${escapeHtml(noteContent)}</p>` : ''}
          </div>

          <div class="intensity-bar-footer intensity-${day.intensity || 'easy'}" title="Intensität: ${day.intensity || 'easy'}"></div>
        </div>
      `;
    }).join("");
  }
}

/**
 * Öffnet den manuellen Editor und befüllt ihn mit dem aktuellen Zustand.
 */
function openAccountPlanEditor(plan) {
  const planToUse = plan || currentAccountPlan;
  editorState = {};

  const existingWeek = planToUse?.weekPlan || {};
  for (const dayKey of PLAN_WEEKDAYS) {
    const existing = existingWeek[dayKey] || {};
    let type = existing.type || "rest";
    if (!PLAN_DISCIPLINES[type]) type = "rest";

    let subtypes = [];
    if (Array.isArray(existing.subtypes)) {
      subtypes = [...existing.subtypes];
    } else if (typeof existing.subtypes === "string" && existing.subtypes) {
      subtypes = [existing.subtypes];
    }

    editorState[dayKey] = {
      type,
      subtypes,
      duration: typeof existing.duration === "number" ? existing.duration : (type === "rest" ? 0 : 60),
      distance: existing.distance != null ? existing.distance : "",
      speed: existing.speed || "",
      intensity: existing.intensity || (type === "rest" ? "easy" : "moderate"),
      notes: existing.notes || existing.description || ""
    };
  }

  const coachNoteInput = document.getElementById("account-plan-edit-coachnote");
  if (coachNoteInput) {
    coachNoteInput.value = planToUse?.coachNote || "";
  }

  const editorList = document.getElementById("account-plan-editor-days");
  if (editorList) {
    editorList.innerHTML = PLAN_WEEKDAYS.map(dayKey => renderDayEditorCard(dayKey)).join("");
  }

  const viewContainer = document.getElementById("account-plan-view-container");
  const editContainer = document.getElementById("account-plan-edit-container");
  const toggleBtn = document.getElementById("account-plan-toggle-mode-btn");

  if (viewContainer) viewContainer.classList.add("hidden");
  if (editContainer) editContainer.classList.remove("hidden");
  if (toggleBtn) {
    toggleBtn.innerHTML = `<span class="btn-icon">👁️</span> <span id="account-plan-toggle-text">Zurück zur Übersicht</span>`;
  }
}

/**
 * Schaltet zwischen Anzeige und Editor um.
 */
function toggleAccountPlanMode() {
  const editContainer = document.getElementById("account-plan-edit-container");
  if (editContainer && !editContainer.classList.contains("hidden")) {
    renderAccountPlanView(currentAccountPlan);
  } else {
    openAccountPlanEditor(currentAccountPlan);
  }
}

/**
 * Rendert das Formular für einen einzelnen Tag im Editor.
 */
function renderDayEditorCard(dayKey) {
  const dayConf = PLAN_WEEKDAY_CONFIG[dayKey];
  const state = editorState[dayKey];
  const currentDisc = PLAN_DISCIPLINES[state.type] || PLAN_DISCIPLINES.rest;

  // Buttons zur Disziplinauswahl
  const discButtons = Object.values(PLAN_DISCIPLINES).map(disc => {
    const isActive = disc.id === state.type;
    return `
      <button type="button" class="discipline-select-btn ${isActive ? 'active ' + disc.badgeClass : ''}"
        data-day="${dayKey}" data-type="${disc.id}">
        <span class="disc-icon">${disc.icon}</span>
        <span class="disc-label">${disc.label}</span>
      </button>
    `;
  }).join("");

  // Subtype-Toggle-Chips (kombinierbar)
  const subtypeChips = currentDisc.subtypes.map(st => {
    const isSelected = state.subtypes.includes(st.id) || state.subtypes.includes(st.label);
    return `
      <button type="button" class="subtype-toggle-btn ${isSelected ? 'active' : ''}"
        data-day="${dayKey}" data-subtype="${st.id}">
        <span class="subtype-icon">${st.icon}</span>
        <span class="subtype-name">${st.label}</span>
      </button>
    `;
  }).join("");

  return `
    <div class="plan-day-editor-card" id="editor-day-${dayKey}" data-day="${dayKey}">
      <div class="day-editor-header">
        <div class="day-editor-title">
          <span class="day-short-badge">${dayConf.short}</span>
          <h4>${dayConf.full}</h4>
        </div>
        <span class="day-current-type-badge ${currentDisc.badgeClass}">
          ${currentDisc.icon} ${currentDisc.fullLabel}
        </span>
      </div>

      <div class="day-editor-row">
        <label class="editor-field-label">1. Disziplin festlegen:</label>
        <div class="discipline-btn-group" role="group" aria-label="Disziplin für ${dayConf.full}">
          ${discButtons}
        </div>
      </div>

      <div class="day-editor-row">
        <label class="editor-field-label">
          2. Art der Aktivität (mehrere kombinierbar):
        </label>
        <div class="subtype-chips-group" role="group" aria-label="Aktivitätsarten">
          ${subtypeChips}
        </div>
      </div>

      <div class="day-editor-row">
        <label class="editor-field-label">3. Weitere Einstellungen:</label>
        <div class="day-settings-grid">
          <div class="form-group-sm">
            <label for="input-duration-${dayKey}">⏱️ Dauer (Min.)</label>
            <input type="number" id="input-duration-${dayKey}" class="plan-input plan-input-duration"
              data-day="${dayKey}" min="0" max="720" step="5" value="${state.duration}" placeholder="0" />
          </div>

          <div class="form-group-sm">
            <label for="input-distance-${dayKey}">📍 Distanz (km)</label>
            <input type="number" id="input-distance-${dayKey}" class="plan-input plan-input-distance"
              data-day="${dayKey}" min="0" max="300" step="0.1" value="${state.distance !== '' && state.distance != null ? state.distance : ''}" placeholder="z. B. 45" />
          </div>

          <div class="form-group-sm">
            <label for="input-speed-${dayKey}">⚡ Pace / Tempo</label>
            <input type="text" id="input-speed-${dayKey}" class="plan-input plan-input-speed"
              data-day="${dayKey}" value="${escapeHtml(state.speed)}" placeholder="${currentDisc.speedPlaceholder}" />
          </div>

          <div class="form-group-sm">
            <label for="input-intensity-${dayKey}">🔥 Intensität</label>
            <select id="input-intensity-${dayKey}" class="plan-select plan-input-intensity" data-day="${dayKey}">
              <option value="easy" ${state.intensity === 'easy' ? 'selected' : ''}>Niedrig (Easy / GA1)</option>
              <option value="moderate" ${state.intensity === 'moderate' ? 'selected' : ''}>Mittel (Moderate / GA2)</option>
              <option value="hard" ${state.intensity === 'hard' ? 'selected' : ''}>Hoch (Hard / Schwellenbereich)</option>
            </select>
          </div>
        </div>
      </div>

      <div class="day-editor-row">
        <label for="input-notes-${dayKey}" class="editor-field-label">
          4. Sonstige Infos &amp; Notizen zur Einheit:
        </label>
        <textarea id="input-notes-${dayKey}" class="plan-textarea plan-input-notes"
          data-day="${dayKey}" rows="2"
          placeholder="z. B. 3x 10min Schwellenintervalle bei 85-90 rpm, Verpflegung alle 20 Min. testen...">${escapeHtml(state.notes)}</textarea>
      </div>
    </div>
  `;
}

/**
 * Aktualisiert eine einzelne Tageskarte im Editor ohne Flackern.
 */
function updateDayEditorCard(dayKey) {
  const cardEl = document.getElementById("editor-day-" + dayKey);
  if (cardEl) {
    cardEl.outerHTML = renderDayEditorCard(dayKey);
  }
}

/**
 * Wendet eine Vorlage (z.B. Ironman oder Reset) auf den Editor an.
 */
function applyTemplate(templateData) {
  for (const dayKey of PLAN_WEEKDAYS) {
    const tpl = templateData.weekPlan[dayKey];
    if (tpl) {
      editorState[dayKey] = {
        type: tpl.type,
        subtypes: [...(tpl.subtypes || [])],
        duration: tpl.duration,
        distance: tpl.distance != null ? tpl.distance : "",
        speed: tpl.speed || "",
        intensity: tpl.intensity || "easy",
        notes: tpl.notes || tpl.description || ""
      };
    }
  }

  const coachNoteInput = document.getElementById("account-plan-edit-coachnote");
  if (coachNoteInput && templateData.coachNote) {
    coachNoteInput.value = templateData.coachNote;
  }

  const editorList = document.getElementById("account-plan-editor-days");
  if (editorList) {
    editorList.innerHTML = PLAN_WEEKDAYS.map(dayKey => renderDayEditorCard(dayKey)).join("");
  }
}

/**
 * Speichert den manuell erstellten Trainingsplan in Firestore.
 */
async function saveAccountPlan() {
  const user = currentUser || auth.currentUser;
  if (!user) {
    showToast("Bitte logge dich ein, um den Plan zu speichern.", "error");
    return;
  }

  const saveBtn = document.getElementById("account-plan-save-btn");
  const saveBtnTop = document.getElementById("account-plan-save-btn-top");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Speichere Plan…"; }
  if (saveBtnTop) { saveBtnTop.disabled = true; saveBtnTop.textContent = "Speichere…"; }

  try {
    const finalWeekPlan = {};
    for (const dayKey of PLAN_WEEKDAYS) {
      const st = editorState[dayKey] || { type: "rest", subtypes: [], duration: 0, distance: "", speed: "", intensity: "easy", notes: "" };
      const disc = PLAN_DISCIPLINES[st.type] || PLAN_DISCIPLINES.rest;
      const subtypeLabels = (st.subtypes || []).map(s => getSubtypeLabel(st.type, s));

      let description = st.notes?.trim() || "";
      if (!description) {
        if (subtypeLabels.length > 0) {
          description = subtypeLabels.join(" + ") + ` (${disc.label})`;
        } else {
          description = disc.fullLabel;
        }
      }

      finalWeekPlan[dayKey] = {
        type: st.type,
        subtypes: st.subtypes || [],
        duration: parseInt(st.duration, 10) || 0,
        distance: st.distance !== "" && !isNaN(parseFloat(st.distance)) ? parseFloat(st.distance) : null,
        speed: (st.speed || "").trim(),
        intensity: st.intensity || (st.type === "rest" ? "easy" : "moderate"),
        description,
        notes: st.notes?.trim() || ""
      };
    }

    const coachNote = document.getElementById("account-plan-edit-coachnote")?.value.trim() || "";

    const planPayload = {
      weekPlan: finalWeekPlan,
      coachNote,
      ownerId: user.uid,
      createdAt: new Date().toISOString(),
      aiGenerated: false
    };

    const plansRef = collection(db, "users", user.uid, "trainingPlans");
    const docRef = await addDoc(plansRef, planPayload);
    const savedPlan = { id: docRef.id, ...planPayload };

    currentAccountPlan = savedPlan;

    // Cross-Tab & Cross-Module Synchronisation
    window.dispatchEvent(new CustomEvent("planUpdated", { detail: savedPlan }));

    renderAccountPlanView(currentAccountPlan);
    showToast("Trainingsplan erfolgreich gespeichert! 🚀", "success");
  } catch (err) {
    console.error("[account] Fehler beim Speichern des Trainingsplans:", err);
    showToast("Fehler beim Speichern: " + err.message, "error");
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "💾 Trainingsplan speichern & übernehmen"; }
    if (saveBtnTop) { saveBtnTop.disabled = false; saveBtnTop.textContent = "💾 Speichern"; }
  }
}

/**
 * Event-Listener für Buttons und Delegationen initialisieren.
 */
let planListenersInitialized = false;
function setupAccountPlanListeners() {
  if (planListenersInitialized) return;
  planListenersInitialized = true;

  document.getElementById("account-plan-toggle-mode-btn")?.addEventListener("click", toggleAccountPlanMode);
  document.getElementById("account-plan-save-btn")?.addEventListener("click", saveAccountPlan);
  document.getElementById("account-plan-save-btn-top")?.addEventListener("click", saveAccountPlan);

  const cancelHandler = () => {
    renderAccountPlanView(currentAccountPlan);
  };
  document.getElementById("account-plan-cancel-btn")?.addEventListener("click", cancelHandler);
  document.getElementById("account-plan-cancel-btn-top")?.addEventListener("click", cancelHandler);

  document.getElementById("btn-template-ironman")?.addEventListener("click", () => {
    applyTemplate(IRONMAN_TEMPLATE);
    showToast("⚡ Ironman-Trainingswoche geladen!", "info");
  });

  document.getElementById("btn-template-reset")?.addEventListener("click", () => {
    applyTemplate(RESET_TEMPLATE);
    showToast("🧹 Alle Tage auf Ruhetag gesetzt.", "info");
  });

  const editorList = document.getElementById("account-plan-editor-days");
  if (editorList) {
    // Input Delegation
    editorList.addEventListener("input", (e) => {
      const target = e.target;
      const dayKey = target.dataset.day;
      if (!dayKey || !editorState[dayKey]) return;

      if (target.classList.contains("plan-input-duration")) {
        editorState[dayKey].duration = parseInt(target.value, 10) || 0;
      } else if (target.classList.contains("plan-input-distance")) {
        editorState[dayKey].distance = target.value;
      } else if (target.classList.contains("plan-input-speed")) {
        editorState[dayKey].speed = target.value;
      } else if (target.classList.contains("plan-input-notes")) {
        editorState[dayKey].notes = target.value;
      }
    });

    // Change Delegation
    editorList.addEventListener("change", (e) => {
      const target = e.target;
      const dayKey = target.dataset.day;
      if (!dayKey || !editorState[dayKey]) return;

      if (target.classList.contains("plan-input-intensity")) {
        editorState[dayKey].intensity = target.value;
      }
    });

    // Click Delegation (Disziplin-Buttons & Subtype-Chips)
    editorList.addEventListener("click", (e) => {
      const discBtn = e.target.closest(".discipline-select-btn");
      if (discBtn) {
        const dayKey = discBtn.dataset.day;
        const newType = discBtn.dataset.type;
        if (dayKey && newType && editorState[dayKey]) {
          if (editorState[dayKey].type !== newType) {
            editorState[dayKey].type = newType;
            if (newType === "rest") {
              editorState[dayKey].duration = 0;
              editorState[dayKey].distance = "";
              editorState[dayKey].speed = "";
              editorState[dayKey].intensity = "easy";
              editorState[dayKey].subtypes = ["ruhe"];
            } else {
              if (editorState[dayKey].duration === 0) editorState[dayKey].duration = 60;
              const disc = PLAN_DISCIPLINES[newType];
              editorState[dayKey].subtypes = disc && disc.subtypes.length > 0 ? [disc.subtypes[0].id] : [];
            }
            updateDayEditorCard(dayKey);
          }
        }
        return;
      }

      const subtypeBtn = e.target.closest(".subtype-toggle-btn");
      if (subtypeBtn) {
        const dayKey = subtypeBtn.dataset.day;
        const subtypeId = subtypeBtn.dataset.subtype;
        if (dayKey && subtypeId && editorState[dayKey]) {
          const arr = editorState[dayKey].subtypes;
          const idx = arr.indexOf(subtypeId);
          if (idx > -1) {
            arr.splice(idx, 1);
            subtypeBtn.classList.remove("active");
          } else {
            arr.push(subtypeId);
            subtypeBtn.classList.add("active");
          }
        }
        return;
      }
    });
  }

  // Synchronisation bei externen Updates (z. B. durch KI-Generierung im Plan-Tab)
  window.addEventListener("planUpdated", (e) => {
    if (e.detail && (!currentAccountPlan || e.detail.createdAt >= (currentAccountPlan.createdAt || ""))) {
      currentAccountPlan = e.detail;
      const editContainer = document.getElementById("account-plan-edit-container");
      if (editContainer && editContainer.classList.contains("hidden")) {
        renderAccountPlanView(currentAccountPlan);
      }
    }
  });
}

function getSubtypeLabel(disciplineId, subtypeIdOrLabel) {
  const disc = PLAN_DISCIPLINES[disciplineId];
  if (!disc) return subtypeIdOrLabel;
  const found = disc.subtypes.find(s => s.id === subtypeIdOrLabel || s.label.toLowerCase() === (subtypeIdOrLabel || "").toLowerCase());
  return found ? found.label : subtypeIdOrLabel;
}

function getSubtypeIcon(disciplineId, subtypeIdOrLabel) {
  const disc = PLAN_DISCIPLINES[disciplineId];
  if (!disc) return "•";
  const found = disc.subtypes.find(s => s.id === subtypeIdOrLabel || s.label.toLowerCase() === (subtypeIdOrLabel || "").toLowerCase());
  return found ? found.icon : "•";
}

function formatPlanDate(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return isoStr;
  }
}

function escapeHtml(str) {
  return (str || "").toString().replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}


