// ============================================================
// js/auth.js
// Firebase Authentication – Login, Logout, Auth-State
// ============================================================

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import { auth }                    from "./firebase-config.js";
import { loadSecrets, clearSecrets } from "./config.js";
import { showToast }               from "./ui-helpers.js";

// ── DOM-Referenzen ─────────────────────────────────────────
const loginScreen  = document.getElementById("login-screen");
const dashboard    = document.getElementById("dashboard");
const loginForm    = document.getElementById("login-form");
const loginError   = document.getElementById("login-error");
const loginBtn     = document.getElementById("login-btn");
const logoutBtn    = document.getElementById("logout-btn");
const userEmailEl  = document.getElementById("user-email");
const userAvatarEl = document.getElementById("user-avatar");

// ── Auth-State-Listener ────────────────────────────────────
// Wird beim App-Start einmalig registriert.
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // ✅ Eingeloggt – zuerst Secrets laden, dann Dashboard zeigen
    await initApp(user);
  } else {
    // 🔒 Nicht eingeloggt
    clearSecrets();   // Cache leeren (z.B. nach Logout)
    showLoginScreen();
  }
});

/**
 * Wird nach erfolgreichem Login aufgerufen.
 * Lädt Secrets aus Firestore, zeigt dann das Dashboard,
 * und initialisiert Strava + Gemini.
 * @param {import("firebase/auth").User} user
 */
async function initApp(user) {
  // Ladeindikator im Login-Screen anzeigen (falls noch sichtbar)
  setLoginLoading(true);

  try {
    // 🔑 Secrets aus Firestore laden (erfordert auth)
    await loadSecrets();
  } catch (err) {
    // Secrets fehlen – Dashboard trotzdem zeigen, aber mit Warnung
    console.error("[auth] Fehler beim Laden der Secrets:", err);
    showToast(
      "⚠️ Secrets konnten nicht geladen werden. Prüfe config/secrets in Firestore.",
      "error",
      8000
    );
  }

  // Dashboard anzeigen (unabhängig vom Secret-Lade-Ergebnis)
  showDashboard(user);

  // Feature-Module dynamisch laden (nur nach Login!)
  import("./strava.js").then((m) => m.initStrava(user));
  import("./gemini.js").then((m) => m.initTrainingPlan(user));
}

// ── Login-Formular absenden ────────────────────────────────
loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  setLoginLoading(true);
  hideLoginError();

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged → initApp() übernimmt ab hier
  } catch (err) {
    setLoginLoading(false);
    showLoginError(getReadableAuthError(err.code));
  }
});

// ── Logout ─────────────────────────────────────────────────
logoutBtn?.addEventListener("click", async () => {
  try {
    await signOut(auth);
    showToast("Erfolgreich ausgeloggt.", "info");
    // clearSecrets() wird durch onAuthStateChanged → else-Zweig aufgerufen
  } catch (err) {
    console.error("Logout-Fehler:", err);
    showToast("Logout fehlgeschlagen.", "error");
  }
});

// ── Hilfsfunktionen ────────────────────────────────────────

/** Dashboard anzeigen, Login-Screen ausblenden */
function showDashboard(user) {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  setLoginLoading(false);

  if (userEmailEl)  userEmailEl.textContent = user.email;
  if (userAvatarEl) userAvatarEl.textContent = user.email.charAt(0).toUpperCase();
}

/** Login-Screen anzeigen, Dashboard ausblenden */
function showLoginScreen() {
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  setLoginLoading(false);
}

/** Login-Button in Lade-Zustand versetzen */
function setLoginLoading(loading) {
  if (!loginBtn) return;
  loginBtn.disabled    = loading;
  loginBtn.textContent = loading ? "Einloggen…" : "Einloggen";
}

/** Fehlermeldung anzeigen */
function showLoginError(message) {
  if (!loginError) return;
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

/** Fehlermeldung verstecken */
function hideLoginError() {
  loginError?.classList.add("hidden");
}

/**
 * Firebase Auth-Fehlercodes in lesbare Texte übersetzen.
 * @param {string} code
 * @returns {string}
 */
function getReadableAuthError(code) {
  const errors = {
    "auth/invalid-email":          "Ungültige E-Mail-Adresse.",
    "auth/user-disabled":          "Dieses Konto wurde deaktiviert.",
    "auth/user-not-found":         "Kein Konto mit dieser E-Mail gefunden.",
    "auth/wrong-password":         "Falsches Passwort.",
    "auth/invalid-credential":     "E-Mail oder Passwort falsch.",
    "auth/too-many-requests":      "Zu viele Versuche. Bitte später nochmal.",
    "auth/network-request-failed": "Netzwerkfehler. Prüfe deine Verbindung.",
  };
  return errors[code] ?? `Login-Fehler (${code}). Bitte versuche es erneut.`;
}
