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
  rest: {
    id: "rest",
    label: "Ruhetag",
    fullLabel: "Ruhetag",
    icon: "😴",
    badgeClass: "badge-rest",
    speedPlaceholder: "–",
    isRest: true,
    subtypes: [
      { id: "ruhe",      label: "Komplette Erholung",    icon: "🛏️" },
      { id: "mobility",  label: "Stretching & Mobilität", icon: "🧘" },
      { id: "blackroll", label: "Faszien & Blackroll",   icon: "🪵" },
    ]
  },
  swim: {
    id: "swim",
    label: "Schwimmen",
    fullLabel: "Schwimmen",
    icon: "🏊",
    badgeClass: "badge-swim",
    speedPlaceholder: "z. B. 1:45 min/100m",
    isRest: false,
    subtypes: [
      { id: "technik",    label: "Technik",    icon: "🎯" },
      { id: "distance",   label: "Distance",   icon: "🌊" },
      { id: "intervalle", label: "Intervalle", icon: "⚡" },
    ]
  },
  ride: {
    id: "ride",
    label: "Rad",
    fullLabel: "Radfahren",
    icon: "🚴",
    badgeClass: "badge-ride",
    speedPlaceholder: "z. B. 32 km/h oder 220 W",
    isRest: false,
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
    isRest: false,
    subtypes: [
      { id: "longrun",    label: "Longrun",    icon: "🏃‍♂️" },
      { id: "intervalle", label: "Intervalle", icon: "⚡" },
      { id: "zone2",      label: "Zone 2",     icon: "💚" },
    ]
  }
};

/** Vorlagen für 1-Klick-Erstellung */
const IRONMAN_TEMPLATE = {
  coachNote: "Solide Ironman-Woche: Schwellenintervalle am Dienstag, Kraul-Technik am Mittwoch, Koppeltraining (Rad + Lauf) am Samstag und Longrun am Sonntag.",
  weekPlan: {
    monday: {
      type: "rest",
      disciplines: ["rest"],
      subtypes: ["ruhe", "mobility"],
      subtypesByDisc: { rest: ["ruhe", "mobility"] },
      parts: [
        { discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" },
        { discId: "rest", id: "mobility", label: "Ruhetag: Stretching & Mobilität", icon: "🧘", duration: 20, distance: null, speed: "", intensity: "easy" }
      ],
      duration: 20,
      distance: null,
      speed: "",
      intensity: "easy",
      description: "Ruhetag & Mobilität",
      notes: "Aktive Erholung, 20 Min. Dehnen und Faszienrolle für Beine und Rücken."
    },
    tuesday: {
      type: "ride",
      disciplines: ["ride"],
      subtypes: ["intervalle", "schwelle"],
      subtypesByDisc: { ride: ["intervalle", "schwelle"] },
      parts: [
        { discId: "ride", id: "intervalle", label: "Rad: Intervalle", icon: "⚡", duration: 45, distance: 20, speed: "34 km/h", intensity: "hard" },
        { discId: "ride", id: "schwelle", label: "Rad: Schwelle", icon: "🔥", duration: 30, distance: 15, speed: "32 km/h", intensity: "hard" }
      ],
      duration: 75,
      distance: 35,
      speed: "Rad: 34 km/h • Rad: 32 km/h",
      intensity: "hard",
      description: "Rad (Intervalle & Schwelle)",
      notes: "15min Warmup, 3x 10min Schwellenbereich (85-90 rpm, 5min Pause), 15min Cooldown."
    },
    wednesday: {
      type: "swim",
      disciplines: ["swim"],
      subtypes: ["technik", "intervalle"],
      subtypesByDisc: { swim: ["technik", "intervalle"] },
      parts: [
        { discId: "swim", id: "technik", label: "Schwimmen: Technik", icon: "🎯", duration: 25, distance: 1.0, speed: "1:55 min/100m", intensity: "easy" },
        { discId: "swim", id: "intervalle", label: "Schwimmen: Intervalle", icon: "⚡", duration: 35, distance: 1.5, speed: "1:40 min/100m", intensity: "moderate" }
      ],
      duration: 60,
      distance: 2.5,
      speed: "Schwimmen: 1:55 min/100m • Schwimmen: 1:40 min/100m",
      intensity: "moderate",
      description: "Schwimmen (Technik & Intervalle)",
      notes: "400m Einschwimmen, 400m Technik (Abschlag, Einarmig), 10x 100m zügig (20s Pause), 200m Ausschwimmen."
    },
    thursday: {
      type: "run",
      disciplines: ["run"],
      subtypes: ["zone2"],
      subtypesByDisc: { run: ["zone2"] },
      parts: [
        { discId: "run", id: "zone2", label: "Laufen: Zone 2", icon: "💚", duration: 60, distance: 11, speed: "5:25 min/km", intensity: "easy" }
      ],
      duration: 60,
      distance: 11,
      speed: "Laufen: 5:25 min/km",
      intensity: "easy",
      description: "Laufen (Zone 2)",
      notes: "Lockerer Dauerlauf im Grundlagenbereich. Puls strikt unter 145 bpm halten."
    },
    friday: {
      type: "swim",
      disciplines: ["swim"],
      subtypes: ["distance", "technik"],
      subtypesByDisc: { swim: ["distance", "technik"] },
      parts: [
        { discId: "swim", id: "distance", label: "Schwimmen: Distance", icon: "🌊", duration: 35, distance: 1.6, speed: "1:48 min/100m", intensity: "moderate" },
        { discId: "swim", id: "technik", label: "Schwimmen: Technik", icon: "🎯", duration: 15, distance: 0.6, speed: "1:55 min/100m", intensity: "easy" }
      ],
      duration: 50,
      distance: 2.2,
      speed: "Schwimmen: 1:48 min/100m • Schwimmen: 1:55 min/100m",
      intensity: "moderate",
      description: "Schwimmen (Distance & Technik)",
      notes: "Ausdauerserie mit Pullbuoy und Paddles, Fokus auf sauberen Zug und hohe Ellbogen."
    },
    saturday: {
      type: "brick",
      disciplines: ["ride", "run"],
      subtypes: ["endurance", "zone2"],
      subtypesByDisc: { ride: ["endurance"], run: ["zone2"] },
      parts: [
        { discId: "ride", id: "endurance", label: "Rad: Endurance", icon: "🔋", duration: 120, distance: 60, speed: "30 km/h", intensity: "moderate" },
        { discId: "run", id: "zone2", label: "Laufen: Koppellauf Zone 2", icon: "💚", duration: 25, distance: 4.5, speed: "5:30 min/km", intensity: "easy" }
      ],
      duration: 145,
      distance: 64.5,
      speed: "Rad: 30 km/h • Laufen: 5:30 min/km",
      intensity: "moderate",
      description: "Koppeltraining: Rad (Endurance) + Laufen (Zone 2)",
      notes: "Spezifisches Koppeltraining: 2 Stunden zügiges Radfahren, direkt danach 25 Min. Koppellauf im Wohlfühltempo."
    },
    sunday: {
      type: "run",
      disciplines: ["run"],
      subtypes: ["longrun", "zone2"],
      subtypesByDisc: { run: ["longrun", "zone2"] },
      parts: [
        { discId: "run", id: "longrun", label: "Laufen: Longrun", icon: "🏃‍♂️", duration: 75, distance: 13, speed: "5:45 min/km", intensity: "moderate" },
        { discId: "run", id: "zone2", label: "Laufen: Zone 2", icon: "💚", duration: 30, distance: 5, speed: "5:30 min/km", intensity: "easy" }
      ],
      duration: 105,
      distance: 18,
      speed: "Laufen: 5:45 min/km • Laufen: 5:30 min/km",
      intensity: "moderate",
      description: "Laufen (Longrun & Zone 2)",
      notes: "Konstantes Wohlfühltempo, die letzten 3 km leicht progressiv. Gels alle 25 Min. testen."
    }
  }
};

const RESET_TEMPLATE = {
  coachNote: "Regenerationswoche / Komplette Erholung",
  weekPlan: {
    monday:    { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    tuesday:   { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    wednesday: { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    thursday:  { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    friday:    { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    saturday:  { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." },
    sunday:    { type: "rest", disciplines: ["rest"], subtypes: ["ruhe"], subtypesByDisc: { rest: ["ruhe"] }, parts: [{ discId: "rest", id: "ruhe", label: "Ruhetag: Komplette Erholung", icon: "🛏️", duration: 0, distance: null, speed: "", intensity: "easy" }], duration: 0, distance: null, speed: "", intensity: "easy", description: "Ruhetag", notes: "Volle Regeneration." }
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
            Du kannst deinen individuellen Trainingsplan für die Woche jetzt manuell erstellen oder im Reiter <strong>KI-Assistenz</strong> von Gemini einen Vorschlag generieren lassen.
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

      // Multi-Disziplinen ermitteln
      const disciplines = Array.isArray(day.disciplines) && day.disciplines.length > 0
        ? day.disciplines.filter(d => PLAN_DISCIPLINES[d])
        : (day.type === "brick" ? ["ride", "run"] : [day.type || "rest"]);

      const isRest = disciplines.length === 1 && disciplines[0] === "rest";
      const isMulti = disciplines.length > 1;

      // Icons oben rechts
      const topIcons = disciplines.map(d => PLAN_DISCIPLINES[d]?.icon || "🏋️").join("");

      // Badge
      let badgeHtml = "";
      if (isMulti) {
        const discLabels = disciplines.map(d => PLAN_DISCIPLINES[d]?.label || d).join(" + ");
        badgeHtml = `<span class="day-badge badge-brick">${escapeHtml(discLabels.toUpperCase())}</span>`;
      } else {
        const singleDisc = PLAN_DISCIPLINES[disciplines[0]] || PLAN_DISCIPLINES.rest;
        badgeHtml = `<span class="day-badge ${singleDisc.badgeClass}">${singleDisc.label.toUpperCase()}</span>`;
      }

      let partsOrMetricsHtml = "";

      if (Array.isArray(day.parts) && day.parts.length > 0) {
        partsOrMetricsHtml = `
          <div class="day-parts-view-list">
            ${day.parts.map(p => {
              const discMeta = p.discId ? PLAN_DISCIPLINES[p.discId] : null;
              const displayIcon = p.icon || discMeta?.icon || "•";
              return `
                <div class="day-part-item">
                  <div class="part-item-header">
                    <span class="subtype-pill">
                      <span class="pill-icon">${displayIcon}</span>
                      <span>${escapeHtml(p.label)}</span>
                    </span>
                    <span class="part-mini-intensity intensity-${p.intensity || 'easy'}">
                      ${p.intensity === 'hard' ? 'EB' : (p.intensity === 'moderate' ? 'GA2' : 'GA1')}
                    </span>
                  </div>
                  <div class="part-metrics-subline">
                    <span class="metric-mini" title="Dauer">⏱️ ${p.duration > 0 ? `${p.duration} Min.` : '–'}</span>
                    ${p.distance != null ? `<span class="metric-mini" title="Distanz">📍 ${p.distance} km</span>` : ''}
                    ${p.speed ? `<span class="metric-mini" title="Pace/Speed">⚡ ${escapeHtml(p.speed)}</span>` : ''}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
          ${day.parts.length > 1 ? `
            <div class="day-total-badge">
              Gesamt: ⏱️ ${day.duration} Min.${day.distance != null ? ` • 📍 ${day.distance} km` : ''}
            </div>
          ` : ''}
        `;
      } else {
        const metricItems = [];
        metricItems.push(`<span class="metric-pill" title="Dauer">⏱️ ${day.duration > 0 ? `${day.duration} Min.` : 'Ruhetag'}</span>`);
        if (day.distance !== null && day.distance !== "" && day.distance !== undefined && day.distance > 0) {
          metricItems.push(`<span class="metric-pill" title="Distanz">📍 ${day.distance} km</span>`);
        }
        if (day.speed && day.speed.trim() !== "") {
          metricItems.push(`<span class="metric-pill" title="Geschwindigkeit/Pace">⚡ ${escapeHtml(day.speed)}</span>`);
        }

        partsOrMetricsHtml = `
          <div class="day-metrics-row">
            ${metricItems.join("")}
          </div>
        `;
      }

      // Notizen / Sonstige Infos
      const noteContent = day.notes || day.description || "";

      return `
        <div class="account-plan-day-card ${isRest ? 'card-rest' : ''}">
          <div class="day-card-top">
            <span class="day-label-short">${dayConf.short}</span>
            <div class="day-top-right">
              ${day.locked ? `<span class="day-locked-pill" title="Disziplin ist für die KI-Generierung fixiert">🔒</span>` : ''}
              <span class="day-discipline-icon" aria-hidden="true">${topIcons}</span>
            </div>
          </div>

          <div class="day-card-body">
            <div class="day-badge-wrap">
              ${badgeHtml}
            </div>

            ${partsOrMetricsHtml}

            ${noteContent ? `<p class="day-note-text" title="${escapeHtml(noteContent)}">${escapeHtml(noteContent)}</p>` : ''}
          </div>

          <div class="intensity-bar-footer intensity-${day.intensity || 'easy'}" title="Intensität: ${day.intensity || 'easy'}"></div>
        </div>
      `;
    }).join("");
  }
}

/**
 * Parst und initialisiert einen Tag für den Editor aus einem bestehenden Plan oder Template.
 */
function initEditorDayFromPlanDay(tpl) {
  if (!tpl) {
    return {
      disciplines: ["rest"],
      subtypesByDisc: { rest: ["ruhe"] },
      parts: { rest_ruhe: { duration: 0, distance: "", speed: "", intensity: "easy" } },
      notes: "",
      locked: false
    };
  }

  // 1. Disziplinen ermitteln
  let disciplines = [];
  if (Array.isArray(tpl.disciplines) && tpl.disciplines.length > 0) {
    disciplines = tpl.disciplines.filter(d => PLAN_DISCIPLINES[d]);
  } else if (tpl.type === "brick") {
    if (Array.isArray(tpl.parts) && tpl.parts.some(p => p.discId)) {
      const set = new Set();
      tpl.parts.forEach(p => { if (p.discId && PLAN_DISCIPLINES[p.discId]) set.add(p.discId); });
      disciplines = Array.from(set);
    }
    if (disciplines.length === 0) disciplines = ["ride", "run"];
  } else if (tpl.type && PLAN_DISCIPLINES[tpl.type]) {
    disciplines = [tpl.type];
  } else {
    disciplines = ["rest"];
  }
  if (disciplines.length === 0) disciplines = ["rest"];

  // 2. Subtypes je Disziplin & Parts parsen
  const subtypesByDisc = {};
  disciplines.forEach(d => { subtypesByDisc[d] = []; });
  const partsObj = {};

  if (Array.isArray(tpl.parts) && tpl.parts.length > 0) {
    for (const p of tpl.parts) {
      if (p && p.id) {
        let discId = p.discId;
        if (!discId || !PLAN_DISCIPLINES[discId]) {
          for (const d of disciplines) {
            if (PLAN_DISCIPLINES[d]?.subtypes.some(s => s.id === p.id || s.label === p.label)) {
              discId = d;
              break;
            }
          }
        }
        if (!discId) discId = disciplines[0] || "ride";

        if (!subtypesByDisc[discId]) subtypesByDisc[discId] = [];
        if (!subtypesByDisc[discId].includes(p.id)) subtypesByDisc[discId].push(p.id);

        const pKey = `${discId}_${p.id}`;
        partsObj[pKey] = {
          duration: typeof p.duration === "number" ? p.duration : (discId === "rest" ? 0 : 30),
          distance: p.distance != null ? p.distance : "",
          speed: p.speed || "",
          intensity: p.intensity || (discId === "rest" ? "easy" : "moderate")
        };
      }
    }
  }

  // Falls in tpl.subtypesByDisc oder tpl.subtypes noch Einträge vorhanden waren
  if (tpl.subtypesByDisc && typeof tpl.subtypesByDisc === "object") {
    for (const [d, list] of Object.entries(tpl.subtypesByDisc)) {
      if (disciplines.includes(d) && Array.isArray(list)) {
        list.forEach(stId => {
          if (!subtypesByDisc[d].includes(stId)) subtypesByDisc[d].push(stId);
        });
      }
    }
  } else if (Array.isArray(tpl.subtypes)) {
    for (const stId of tpl.subtypes) {
      for (const d of disciplines) {
        if (PLAN_DISCIPLINES[d]?.subtypes.some(s => s.id === stId)) {
          if (!subtypesByDisc[d].includes(stId)) subtypesByDisc[d].push(stId);
        }
      }
    }
  }

  // Fehlende Parts mit Defaults auffüllen
  for (const d of disciplines) {
    if (!subtypesByDisc[d] || subtypesByDisc[d].length === 0) {
      const defSt = PLAN_DISCIPLINES[d]?.subtypes[0]?.id || "ruhe";
      subtypesByDisc[d] = [defSt];
    }
    for (const stId of subtypesByDisc[d]) {
      const pKey = `${d}_${stId}`;
      if (!partsObj[pKey]) {
        let defInt = "moderate";
        if (stId.includes("intervalle") || stId.includes("schwelle") || stId.includes("race")) defInt = "hard";
        if (stId.includes("ruhe") || stId.includes("mobility") || stId.includes("zone2")) defInt = "easy";
        partsObj[pKey] = {
          duration: typeof tpl.duration === "number" && disciplines.length === 1 && subtypesByDisc[d].length === 1 ? tpl.duration : (d === "rest" ? 0 : 30),
          distance: disciplines.length === 1 && subtypesByDisc[d].length === 1 && tpl.distance != null ? tpl.distance : "",
          speed: disciplines.length === 1 && subtypesByDisc[d].length === 1 && tpl.speed ? tpl.speed : "",
          intensity: disciplines.length === 1 && subtypesByDisc[d].length === 1 && tpl.intensity ? tpl.intensity : defInt
        };
      }
    }
  }

  return {
    disciplines,
    subtypesByDisc,
    parts: partsObj,
    notes: tpl.notes || tpl.description || "",
    locked: Boolean(tpl.locked)
  };
}

/**
 * Öffnet den manuellen Editor und befüllt ihn mit dem aktuellen Zustand.
 */
function openAccountPlanEditor(plan) {
  const planToUse = plan || currentAccountPlan;
  editorState = {};

  const existingWeek = planToUse?.weekPlan || {};
  for (const dayKey of PLAN_WEEKDAYS) {
    const existing = existingWeek[dayKey];
    editorState[dayKey] = initEditorDayFromPlanDay(existing);
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
  const state = editorState[dayKey] || { disciplines: ["rest"], subtypesByDisc: { rest: ["ruhe"] }, parts: {}, notes: "", locked: false };
  const disciplines = (state.disciplines && state.disciplines.length > 0) ? state.disciplines : ["rest"];
  const isMulti = disciplines.length > 1;
  const isRest = disciplines.length === 1 && disciplines[0] === "rest";
  const isLocked = Boolean(state.locked);

  // Badges oben rechts in der Tageskarte
  let headerBadgeHtml = "";
  if (isMulti) {
    const labelStr = disciplines.map(d => PLAN_DISCIPLINES[d]?.label || d).join(" + ");
    headerBadgeHtml = `<span class="day-current-type-badge badge-brick">🔄 ${escapeHtml(labelStr)} (Koppel)</span>`;
  } else {
    const singleDisc = PLAN_DISCIPLINES[disciplines[0]] || PLAN_DISCIPLINES.rest;
    headerBadgeHtml = `<span class="day-current-type-badge ${singleDisc.badgeClass}">${singleDisc.icon} ${singleDisc.fullLabel}</span>`;
  }

  // 1. Disziplin-Buttons
  const discButtons = Object.values(PLAN_DISCIPLINES).map(disc => {
    const isActive = disciplines.includes(disc.id);
    return `
      <button type="button" class="discipline-select-btn ${isActive ? 'active ' + disc.badgeClass : ''}"
        data-day="${dayKey}" data-type="${disc.id}">
        <span class="disc-icon">${disc.icon}</span>
        <span class="disc-label">${disc.label}</span>
        ${isActive ? '<span class="disc-check">✓</span>' : ''}
      </button>
    `;
  }).join("");

  // 2. Arten je ausgewählter Disziplin
  const discSubtypesSectionsHtml = disciplines.map(discId => {
    const disc = PLAN_DISCIPLINES[discId] || PLAN_DISCIPLINES.rest;
    const selectedSubs = (state.subtypesByDisc && state.subtypesByDisc[discId]) || [];

    const chips = disc.subtypes.map(st => {
      const isSelected = selectedSubs.includes(st.id);
      return `
        <button type="button" class="subtype-toggle-btn ${isSelected ? 'active' : ''}"
          data-day="${dayKey}" data-disc="${disc.id}" data-subtype="${st.id}">
          <span class="subtype-icon">${st.icon}</span>
          <span class="subtype-name">${st.label}</span>
        </button>
      `;
    }).join("");

    return `
      <div class="discipline-subtypes-section">
        <div class="disc-section-title">
          <span class="disc-mini-badge ${disc.badgeClass}">${disc.icon} ${disc.label}</span>
          <span class="disc-section-subtitle">Trainingsarten auswählen:</span>
        </div>
        <div class="subtype-chips-group" role="group" aria-label="Arten für ${disc.label}">
          ${chips}
        </div>
      </div>
    `;
  }).join("");

  // 3. Einstellungs-Zeilen: PRO ART JEDER DISZIPLIN EINE EIGENE KARTE!
  const settingsCards = [];
  disciplines.forEach(discId => {
    const disc = PLAN_DISCIPLINES[discId] || PLAN_DISCIPLINES.rest;
    const selectedSubs = (state.subtypesByDisc && state.subtypesByDisc[discId]) || [];

    if (selectedSubs.length === 0) {
      const pKey = `${discId}_default`;
      if (!state.parts) state.parts = {};
      if (!state.parts[pKey]) {
        state.parts[pKey] = {
          duration: disc.isRest ? 0 : 30,
          distance: "",
          speed: "",
          intensity: disc.isRest ? "easy" : "moderate"
        };
      }
      const p = state.parts[pKey];

      settingsCards.push(`
        <div class="subtype-part-editor-card disc-border-${discId}">
          <div class="subtype-part-card-header">
            <span class="part-card-badge ${disc.badgeClass}">
              <span class="part-card-icon">${disc.icon}</span>
              <span class="part-card-label">${disc.label}</span>
            </span>
            <span class="part-card-hint">Werte für ${disc.label}</span>
          </div>

          <div class="day-settings-grid">
            <div class="form-group-sm">
              <label for="input-dur-${dayKey}-${discId}-default">⏱️ Dauer (Min.)</label>
              <input type="number" id="input-dur-${dayKey}-${discId}-default" class="plan-input part-input-duration"
                data-day="${dayKey}" data-disc="${discId}" data-subtype="default" min="0" max="720" step="5"
                value="${p.duration != null ? p.duration : ''}" placeholder="${disc.isRest ? '0' : '30'}" />
            </div>

            <div class="form-group-sm">
              <label for="input-dist-${dayKey}-${discId}-default">📍 Distanz (km)</label>
              <input type="number" id="input-dist-${dayKey}-${discId}-default" class="plan-input part-input-distance"
                data-day="${dayKey}" data-disc="${discId}" data-subtype="default" min="0" max="300" step="0.1"
                value="${p.distance !== '' && p.distance != null ? p.distance : ''}" placeholder="${disc.isRest ? '–' : 'z. B. 20'}" />
            </div>

            <div class="form-group-sm">
              <label for="input-spd-${dayKey}-${discId}-default">⚡ Pace / Tempo</label>
              <input type="text" id="input-spd-${dayKey}-${discId}-default" class="plan-input part-input-speed"
                data-day="${dayKey}" data-disc="${discId}" data-subtype="default"
                value="${escapeHtml(p.speed || '')}" placeholder="${disc.speedPlaceholder}" />
            </div>

            <div class="form-group-sm">
              <label for="input-int-${dayKey}-${discId}-default">🔥 Intensität</label>
              <select id="input-int-${dayKey}-${discId}-default" class="plan-select part-input-intensity"
                data-day="${dayKey}" data-disc="${discId}" data-subtype="default">
                <option value="easy" ${p.intensity === 'easy' ? 'selected' : ''}>Niedrig (Easy / GA1)</option>
                <option value="moderate" ${p.intensity === 'moderate' ? 'selected' : ''}>Mittel (Moderate / GA2)</option>
                <option value="hard" ${p.intensity === 'hard' ? 'selected' : ''}>Hoch (Hard / EB)</option>
              </select>
            </div>
          </div>
        </div>
      `);
    } else {
      selectedSubs.forEach(stId => {
        const stConf = disc.subtypes.find(s => s.id === stId) || { id: stId, label: stId, icon: "•" };
        const pKey = `${discId}_${stId}`;
        if (!state.parts) state.parts = {};
        if (!state.parts[pKey]) {
          let defInt = "moderate";
          if (stId.includes("intervalle") || stId.includes("schwelle") || stId.includes("race")) defInt = "hard";
          if (stId.includes("ruhe") || stId.includes("mobility") || stId.includes("zone2")) defInt = "easy";
          state.parts[pKey] = {
            duration: disc.isRest ? 0 : 30,
            distance: "",
            speed: "",
            intensity: defInt
          };
        }
        const p = state.parts[pKey];

        settingsCards.push(`
          <div class="subtype-part-editor-card disc-border-${discId}">
            <div class="subtype-part-card-header">
              <span class="part-card-badge ${disc.badgeClass}">
                <span class="part-card-icon">${disc.icon} ${stConf.icon}</span>
                <span class="part-card-label">${disc.label}: ${escapeHtml(stConf.label)}</span>
              </span>
              <span class="part-card-hint">Werte für ${disc.label} (${escapeHtml(stConf.label)})</span>
            </div>

            <div class="day-settings-grid">
              <div class="form-group-sm">
                <label for="input-dur-${dayKey}-${discId}-${stId}">⏱️ Dauer (Min.)</label>
                <input type="number" id="input-dur-${dayKey}-${discId}-${stId}" class="plan-input part-input-duration"
                  data-day="${dayKey}" data-disc="${discId}" data-subtype="${stId}" min="0" max="720" step="5"
                  value="${p.duration != null ? p.duration : ''}" placeholder="${disc.isRest ? '0' : '30'}" />
              </div>

              <div class="form-group-sm">
                <label for="input-dist-${dayKey}-${discId}-${stId}">📍 Distanz (km)</label>
                <input type="number" id="input-dist-${dayKey}-${discId}-${stId}" class="plan-input part-input-distance"
                  data-day="${dayKey}" data-disc="${discId}" data-subtype="${stId}" min="0" max="300" step="0.1"
                  value="${p.distance !== '' && p.distance != null ? p.distance : ''}" placeholder="${disc.isRest ? '–' : 'z. B. 20'}" />
              </div>

              <div class="form-group-sm">
                <label for="input-spd-${dayKey}-${discId}-${stId}">⚡ Pace / Tempo</label>
                <input type="text" id="input-spd-${dayKey}-${discId}-${stId}" class="plan-input part-input-speed"
                  data-day="${dayKey}" data-disc="${discId}" data-subtype="${stId}"
                  value="${escapeHtml(p.speed || '')}" placeholder="${disc.speedPlaceholder}" />
              </div>

              <div class="form-group-sm">
                <label for="input-int-${dayKey}-${discId}-${stId}">🔥 Intensität</label>
                <select id="input-int-${dayKey}-${discId}-${stId}" class="plan-select part-input-intensity"
                  data-day="${dayKey}" data-disc="${discId}" data-subtype="${stId}">
                  <option value="easy" ${p.intensity === 'easy' ? 'selected' : ''}>Niedrig (Easy / GA1)</option>
                  <option value="moderate" ${p.intensity === 'moderate' ? 'selected' : ''}>Mittel (Moderate / GA2)</option>
                  <option value="hard" ${p.intensity === 'hard' ? 'selected' : ''}>Hoch (Hard / EB)</option>
                </select>
              </div>
            </div>
          </div>
        `);
      });
    }
  });

  return `
    <div class="plan-day-editor-card ${isLocked ? 'is-locked' : ''}" id="editor-day-${dayKey}" data-day="${dayKey}">
      <div class="day-editor-header">
        <div class="day-editor-title">
          <span class="day-short-badge">${dayConf.short}</span>
          <h4>${dayConf.full}</h4>
        </div>
        <div class="day-editor-header-actions">
          <button type="button" class="day-lock-btn ${isLocked ? 'is-locked' : ''}" data-day="${dayKey}"
            title="${isLocked ? 'Disziplin ist für die KI-Generierung fixiert (Klick zum Entsperren)' : 'Disziplin für die KI-Generierung fixieren (Klick zum Sperren)'}">
            <span class="lock-icon">${isLocked ? '🔒' : '🔓'}</span>
            <span class="lock-label">${isLocked ? 'Fixiert' : 'Frei'}</span>
          </button>
          ${headerBadgeHtml}
        </div>
      </div>

      <div class="day-editor-row">
        <label class="editor-field-label">1. Disziplin(en) festlegen (Tippe auf mehrere für Koppeltraining, Ruhetag setzt zurück):</label>
        <div class="discipline-btn-group" role="group" aria-label="Disziplin für ${dayConf.full}">
          ${discButtons}
        </div>
      </div>

      <div class="day-editor-row">
        <label class="editor-field-label">
          2. Arten je Disziplin festlegen (mehrere kombinierbar):
        </label>
        <div class="discipline-subtypes-container">
          ${discSubtypesSectionsHtml}
        </div>
      </div>

      <div class="day-editor-row">
        <label class="editor-field-label">
          3. Parameter je ausgewählter Art einstellen:
        </label>
        <div class="subtype-parts-editor-list">
          ${settingsCards.join("")}
        </div>
      </div>

      <div class="day-editor-row">
        <label for="input-notes-${dayKey}" class="editor-field-label">
          4. Sonstige Infos &amp; Notizen zur Einheit:
        </label>
        <textarea id="input-notes-${dayKey}" class="plan-textarea plan-input-notes"
          data-day="${dayKey}" rows="2"
          placeholder="z. B. Koppeltraining mit direktem Übergang, Verpflegungsstrategie testen...">${escapeHtml(state.notes)}</textarea>
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
    editorState[dayKey] = initEditorDayFromPlanDay(tpl);
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
      const st = editorState[dayKey] || { disciplines: ["rest"], subtypesByDisc: { rest: ["ruhe"] }, parts: {}, notes: "" };
      const disciplines = (st.disciplines && st.disciplines.length > 0) ? st.disciplines : ["rest"];
      const isRest = disciplines.length === 1 && disciplines[0] === "rest";

      const partsArray = [];
      const allSubtypeIds = [];
      let totalDuration = 0;
      let totalDistance = 0;
      let hasDistance = false;
      const speeds = [];
      let maxIntensity = "easy";
      const intensityRank = { easy: 1, moderate: 2, hard: 3 };

      for (const discId of disciplines) {
        const disc = PLAN_DISCIPLINES[discId] || PLAN_DISCIPLINES.rest;
        const subIds = (st.subtypesByDisc && st.subtypesByDisc[discId]) || [];

        if (subIds.length === 0) {
          const pKey = `${discId}_default`;
          const p = (st.parts && st.parts[pKey]) ? st.parts[pKey] : {};
          const pDur = parseInt(p.duration, 10) || (disc.isRest ? 0 : 30);
          totalDuration += pDur;

          let pDist = null;
          if (p.distance !== "" && p.distance != null && !isNaN(parseFloat(p.distance))) {
            pDist = Math.round(parseFloat(p.distance) * 10) / 10;
            totalDistance += pDist;
            hasDistance = true;
          }

          const pSpd = (p.speed || "").trim();
          if (pSpd) speeds.push(`${disc.label}: ${pSpd}`);

          const pInt = p.intensity || (disc.isRest ? "easy" : "moderate");
          if ((intensityRank[pInt] || 1) > (intensityRank[maxIntensity] || 1)) {
            maxIntensity = pInt;
          }

          partsArray.push({
            discId,
            id: "default",
            label: disc.fullLabel,
            shortLabel: disc.label,
            icon: disc.icon,
            discIcon: disc.icon,
            duration: pDur,
            distance: pDist,
            speed: pSpd,
            intensity: pInt
          });
        } else {
          for (const stId of subIds) {
            allSubtypeIds.push(stId);
            const pKey = `${discId}_${stId}`;
            const p = (st.parts && st.parts[pKey]) ? st.parts[pKey] : {};
            const pDur = parseInt(p.duration, 10) || 0;
            totalDuration += pDur;

            let pDist = null;
            if (p.distance !== "" && p.distance != null && !isNaN(parseFloat(p.distance))) {
              pDist = Math.round(parseFloat(p.distance) * 10) / 10;
              totalDistance += pDist;
              hasDistance = true;
            }

            const pSpd = (p.speed || "").trim();
            if (pSpd) speeds.push(`${disc.label}: ${pSpd}`);

            const pInt = p.intensity || (disc.isRest ? "easy" : "moderate");
            if ((intensityRank[pInt] || 1) > (intensityRank[maxIntensity] || 1)) {
              maxIntensity = pInt;
            }

            partsArray.push({
              discId,
              id: stId,
              label: `${disc.label}: ${getSubtypeLabel(discId, stId)}`,
              shortLabel: getSubtypeLabel(discId, stId),
              icon: getSubtypeIcon(discId, stId) || disc.icon,
              discIcon: disc.icon,
              duration: pDur,
              distance: pDist,
              speed: pSpd,
              intensity: pInt
            });
          }
        }
      }

      // Typ für maximale Kompatibilität
      const finalType = isRest ? "rest" : (disciplines.length > 1 ? "brick" : disciplines[0]);

      let description = st.notes?.trim() || "";
      if (!description) {
        if (isRest) {
          description = "Ruhetag & Regeneration";
        } else {
          const discSummaries = disciplines.map(d => {
            const disc = PLAN_DISCIPLINES[d] || PLAN_DISCIPLINES.rest;
            const subLabels = ((st.subtypesByDisc && st.subtypesByDisc[d]) || []).map(s => getSubtypeLabel(d, s));
            return subLabels.length > 0 ? `${disc.label} (${subLabels.join(", ")})` : disc.label;
          });
          description = discSummaries.join(" + ");
        }
      }

      finalWeekPlan[dayKey] = {
        type: finalType,
        disciplines,
        subtypes: allSubtypeIds,
        subtypesByDisc: st.subtypesByDisc || {},
        parts: partsArray,
        duration: totalDuration,
        distance: hasDistance ? Math.round(totalDistance * 10) / 10 : null,
        speed: speeds.join(" • "),
        intensity: maxIntensity,
        description,
        notes: st.notes?.trim() || "",
        locked: Boolean(st.locked)
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
      const discId = target.dataset.disc;
      const subtype = target.dataset.subtype;
      if (!dayKey || !editorState[dayKey]) return;

      const state = editorState[dayKey];
      if (discId && subtype) {
        const pKey = `${discId}_${subtype}`;
        if (!state.parts) state.parts = {};
        if (!state.parts[pKey]) state.parts[pKey] = {};

        if (target.classList.contains("part-input-duration")) {
          state.parts[pKey].duration = parseInt(target.value, 10) || 0;
        } else if (target.classList.contains("part-input-distance")) {
          state.parts[pKey].distance = target.value;
        } else if (target.classList.contains("part-input-speed")) {
          state.parts[pKey].speed = target.value;
        }
      } else if (target.classList.contains("plan-input-notes")) {
        state.notes = target.value;
      }
    });

    // Change Delegation
    editorList.addEventListener("change", (e) => {
      const target = e.target;
      const dayKey = target.dataset.day;
      const discId = target.dataset.disc;
      const subtype = target.dataset.subtype;
      if (!dayKey || !editorState[dayKey]) return;

      if (discId && subtype && target.classList.contains("part-input-intensity")) {
        const pKey = `${discId}_${subtype}`;
        if (!editorState[dayKey].parts) editorState[dayKey].parts = {};
        if (!editorState[dayKey].parts[pKey]) editorState[dayKey].parts[pKey] = {};
        editorState[dayKey].parts[pKey].intensity = target.value;
      }
    });

    // Click Delegation (Disziplin-Buttons, Subtype-Chips & Lock-Button)
    editorList.addEventListener("click", (e) => {
      const lockBtn = e.target.closest(".day-lock-btn");
      if (lockBtn) {
        const dayKey = lockBtn.dataset.day;
        if (!dayKey || !editorState[dayKey]) return;
        editorState[dayKey].locked = !editorState[dayKey].locked;
        updateDayEditorCard(dayKey);
        showToast(
          editorState[dayKey].locked
            ? `🔒 ${PLAN_WEEKDAY_CONFIG[dayKey].full} fixiert – Disziplin bleibt bei KI-Generierung erhalten!`
            : `🔓 ${PLAN_WEEKDAY_CONFIG[dayKey].full} freigegeben für KI-Generierung.`,
          "info"
        );
        return;
      }

      const discBtn = e.target.closest(".discipline-select-btn");
      if (discBtn) {
        const dayKey = discBtn.dataset.day;
        const clickedDisc = discBtn.dataset.type;
        if (!dayKey || !clickedDisc || !editorState[dayKey]) return;

        const state = editorState[dayKey];
        if (!Array.isArray(state.disciplines)) state.disciplines = ["rest"];

        if (clickedDisc === "rest") {
          // Ruhetag deaktiviert alle anderen Disziplinen
          state.disciplines = ["rest"];
          if (!state.subtypesByDisc) state.subtypesByDisc = {};
          state.subtypesByDisc.rest = ["ruhe"];
          const pKey = "rest_ruhe";
          if (!state.parts) state.parts = {};
          if (!state.parts[pKey]) {
            state.parts[pKey] = { duration: 0, distance: "", speed: "", intensity: "easy" };
          }
        } else {
          // Klick auf Sport-Disziplin: Ruhetag immer entfernen
          state.disciplines = state.disciplines.filter(d => d !== "rest");

          const idx = state.disciplines.indexOf(clickedDisc);
          if (idx > -1) {
            // Bereits gewählt: abwählen
            state.disciplines.splice(idx, 1);
            if (state.disciplines.length === 0) {
              // Falls keine mehr ausgewählt: auf Ruhetag zurückfallen
              state.disciplines = ["rest"];
              if (!state.subtypesByDisc) state.subtypesByDisc = {};
              state.subtypesByDisc.rest = ["ruhe"];
            }
          } else {
            // Neu hinzunehmen
            state.disciplines.push(clickedDisc);
            if (!state.subtypesByDisc) state.subtypesByDisc = {};
            if (!Array.isArray(state.subtypesByDisc[clickedDisc]) || state.subtypesByDisc[clickedDisc].length === 0) {
              const discConf = PLAN_DISCIPLINES[clickedDisc];
              const defSt = discConf && discConf.subtypes.length > 0 ? discConf.subtypes[0].id : "default";
              state.subtypesByDisc[clickedDisc] = [defSt];
              const pKey = `${clickedDisc}_${defSt}`;
              if (!state.parts) state.parts = {};
              if (!state.parts[pKey]) {
                state.parts[pKey] = {
                  duration: 30,
                  distance: "",
                  speed: "",
                  intensity: "moderate"
                };
              }
            }
          }
        }
        updateDayEditorCard(dayKey);
        return;
      }

      const subtypeBtn = e.target.closest(".subtype-toggle-btn");
      if (subtypeBtn) {
        const dayKey = subtypeBtn.dataset.day;
        const discId = subtypeBtn.dataset.disc;
        const subtypeId = subtypeBtn.dataset.subtype;
        if (!dayKey || !discId || !subtypeId || !editorState[dayKey]) return;

        const state = editorState[dayKey];
        if (!state.subtypesByDisc) state.subtypesByDisc = {};
        if (!Array.isArray(state.subtypesByDisc[discId])) state.subtypesByDisc[discId] = [];

        const arr = state.subtypesByDisc[discId];
        const idx = arr.indexOf(subtypeId);
        const pKey = `${discId}_${subtypeId}`;

        if (idx > -1) {
          arr.splice(idx, 1);
        } else {
          arr.push(subtypeId);
          if (!state.parts) state.parts = {};
          if (!state.parts[pKey]) {
            let defInt = "moderate";
            if (subtypeId.includes("intervalle") || subtypeId.includes("schwelle") || subtypeId.includes("race")) defInt = "hard";
            if (subtypeId.includes("ruhe") || subtypeId.includes("mobility") || subtypeId.includes("zone2")) defInt = "easy";
            state.parts[pKey] = {
              duration: discId === "rest" ? 0 : 30,
              distance: "",
              speed: "",
              intensity: defInt
            };
          }
        }
        updateDayEditorCard(dayKey);
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
  if (disc) {
    const found = disc.subtypes.find(s => s.id === subtypeIdOrLabel || s.label.toLowerCase() === (subtypeIdOrLabel || "").toLowerCase());
    if (found) return found.label;
  }
  for (const d of Object.values(PLAN_DISCIPLINES)) {
    const found = d.subtypes.find(s => s.id === subtypeIdOrLabel || s.label.toLowerCase() === (subtypeIdOrLabel || "").toLowerCase());
    if (found) return found.label;
  }
  return subtypeIdOrLabel;
}

function getSubtypeIcon(disciplineId, subtypeIdOrLabel) {
  const disc = PLAN_DISCIPLINES[disciplineId];
  if (disc) {
    const found = disc.subtypes.find(s => s.id === subtypeIdOrLabel || s.label.toLowerCase() === (subtypeIdOrLabel || "").toLowerCase());
    if (found) return found.icon;
  }
  for (const d of Object.values(PLAN_DISCIPLINES)) {
    const found = d.subtypes.find(s => s.id === subtypeIdOrLabel || s.label.toLowerCase() === (subtypeIdOrLabel || "").toLowerCase());
    if (found) return found.icon;
  }
  return "•";
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


