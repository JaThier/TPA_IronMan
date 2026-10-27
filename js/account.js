// ============================================================
// js/account.js
// Benutzer-Konto, Profilverwaltung & Onboarding-Namensabfrage
// ============================================================

import { auth, db } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";
import { loadAndRenderHub } from "./hub.js";

let currentUser = null;

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
  await updateProfile(user, {
    displayName: newName,
  });

  // 2. Firestore Profil speichern
  const profileRef = doc(db, "users", user.uid, "profile", "main");
  await setDoc(profileRef, {
    displayName: newName,
    name:        newName,
    updatedAt:   new Date().toISOString(),
  }, { merge: true });

  // 3. Im Hub aktualisieren
  const hubRef = doc(db, "hub", user.uid);
  await setDoc(hubRef, {
    uid:       user.uid,
    name:      newName,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // 4. Navbar aktualisieren
  updateNavbarUserBadge(newName, user.email);

  // 5. Hub-Statistiken synchronisieren und neu rendern
  import("./hub.js").then(async (m) => {
    await m.syncOwnStatsFromCache();
    await m.loadAndRenderHub();
  });
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

    if (nameInput)   nameInput.value = currentName;
    if (emailInput)  emailInput.value = currentUser.email;
    if (heroName)    heroName.textContent = currentName;
    if (heroEmail)   heroEmail.textContent = currentUser.email;
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
  const nameEl   = document.getElementById("user-email");
  const avatarEl = document.getElementById("user-avatar");

  const nameToShow = displayName || email?.split("@")[0] || "Athlet";
  if (nameEl)   nameEl.textContent = nameToShow;
  if (avatarEl) avatarEl.textContent = nameToShow.charAt(0).toUpperCase();
}
