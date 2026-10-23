// ============================================================
// js/auth.js
// Firebase Authentication – Login, Logout, Auth-State
// ============================================================

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import { auth, isConfigured } from "./firebase-config.js";
import { showToast }          from "./ui-helpers.js";

// ── DOM-Referenzen ─────────────────────────────────────────
const loginScreen    = document.getElementById("login-screen");
const dashboard      = document.getElementById("dashboard");
const loginForm      = document.getElementById("login-form");
const loginError     = document.getElementById("login-error");
const loginBtn       = document.getElementById("login-btn");
const logoutBtn      = document.getElementById("logout-btn");
const userEmailEl    = document.getElementById("user-email");
const userAvatarEl   = document.getElementById("user-avatar");

// ── Auth-State-Listener ────────────────────────────────────
// Wird beim App-Start ausgeführt. Zeigt je nach Zustand
// entweder den Login-Screen oder das Dashboard an.
onAuthStateChanged(auth, (user) => {
  if (user) {
    // ✅ Eingeloggt
    showDashboard(user);
    // Dashboard-Module initialisieren (werden nach Login geladen)
    import("./strava.js").then((m) => m.initStrava(user));
    import("./gemini.js").then((m) => m.initTrainingPlan(user));
  } else {
    // 🔒 Nicht eingeloggt – Login-Screen anzeigen
    showLoginScreen();
  }
});

// ── Login-Formular absenden ────────────────────────────────
loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  // Konfigurationscheck
  if (!isConfigured()) {
    showLoginError("Firebase ist noch nicht konfiguriert. Bitte js/firebase-config.js ausfüllen.");
    return;
  }

  setLoginLoading(true);
  hideLoginError();

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged übernimmt danach automatisch
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

  // Benutzer-Info in der Navbar befüllen
  if (userEmailEl)  userEmailEl.textContent  = user.email;
  if (userAvatarEl) userAvatarEl.textContent  = user.email.charAt(0).toUpperCase();
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
 * @param {string} code - z.B. "auth/wrong-password"
 * @returns {string}
 */
function getReadableAuthError(code) {
  const errors = {
    "auth/invalid-email":         "Ungültige E-Mail-Adresse.",
    "auth/user-disabled":         "Dieses Konto wurde deaktiviert.",
    "auth/user-not-found":        "Kein Konto mit dieser E-Mail gefunden.",
    "auth/wrong-password":        "Falsches Passwort.",
    "auth/invalid-credential":    "E-Mail oder Passwort falsch.",
    "auth/too-many-requests":     "Zu viele Versuche. Bitte später nochmal.",
    "auth/network-request-failed":"Netzwerkfehler. Prüfe deine Verbindung.",
  };
  return errors[code] ?? `Login-Fehler (${code}). Bitte versuche es erneut.`;
}
