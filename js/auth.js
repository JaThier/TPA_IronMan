// ============================================================
// js/auth.js
// Firebase Authentication – Login, Logout, Auth-State & Tab-Navigation
// ============================================================

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import { auth } from "./firebase-config.js";
import { loadSecrets, clearSecrets } from "./config.js";
import { showToast } from "./ui-helpers.js";

// ── DOM-Referenzen ─────────────────────────────────────────
const loginScreen = document.getElementById("login-screen");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const userEmailEl = document.getElementById("user-email");
const userAvatarEl = document.getElementById("user-avatar");

let currentTab = "activities";

// ── Auth-State-Listener ────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // ✅ Eingeloggt – zuerst Secrets laden, dann Dashboard zeigen
    await initApp(user);
  } else {
    // 🔒 Nicht eingeloggt
    clearSecrets();
    showLoginScreen();
  }
});

/**
 * Wird nach erfolgreichem Login aufgerufen.
 * @param {import("firebase/auth").User} user
 */
async function initApp(user) {
  setLoginLoading(true);

  try {
    await loadSecrets();
  } catch (err) {
    console.error("[auth] Fehler beim Laden der Secrets:", err);
    showToast(
      "⚠️ Secrets konnten nicht geladen werden. Prüfe config/secrets in Firestore.",
      "error",
      8000
    );
  }

  showDashboard(user);
  initTabNavigation();

  // Feature-Module dynamisch laden (Cache-Busting für Entwicklungsstand)
  const cb = Date.now();
  import(`./strava.js?cb=${cb}`).then((m) => m.initStrava(user));
  import(`./gemini.js?cb=${cb}`).then((m) => m.initTrainingPlan(user));
  import(`./hub.js?cb=${cb}`).then((m) => m.initHub(user));
  import(`./account.js?cb=${cb}`).then((m) => m.initAccount(user));
}

// ── Tab-Navigation ─────────────────────────────────────────
const VALID_TABS = ["activities", "plan", "ai", "hub", "account"];

export function initTabNavigation() {
  const tabs = document.querySelectorAll(".nav-tab");

  // URL Hash auswerten (z.B. #plan, #ai, #hub, #account)
  const initialHash = window.location.hash.replace("#", "");
  if (VALID_TABS.includes(initialHash)) {
    switchTab(initialHash);
  } else {
    switchTab("activities");
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      if (target) {
        switchTab(target);
        window.location.hash = target;
      }
    });
  });

  window.addEventListener("hashchange", () => {
    const hash = window.location.hash.replace("#", "");
    if (VALID_TABS.includes(hash) && hash !== currentTab) {
      switchTab(hash);
    }
  });
}

export function switchTab(tabName) {
  currentTab = tabName;
  const tabs = document.querySelectorAll(".nav-tab");
  const views = document.querySelectorAll(".tab-view");

  tabs.forEach((tab) => {
    const isTarget = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isTarget);
    tab.setAttribute("aria-selected", isTarget ? "true" : "false");
  });

  views.forEach((view) => {
    const isTarget = view.id === `view-${tabName}`;
    view.classList.toggle("active", isTarget);
    view.classList.toggle("hidden", !isTarget);
  });

  // Falls zum Hub, Plan, KI-Assistenz oder Konto gewechselt wird, Daten aktualisieren
  const cb = Date.now();
  if (tabName === "hub") {
    import(`./hub.js?cb=${cb}`).then(m => m.loadAndRenderHub());
  } else if (tabName === "plan") {
    import(`./account.js?cb=${cb}`).then(m => m.loadAndRenderAccountPlan?.());
  } else if (tabName === "ai") {
    import(`./gemini.js?cb=${cb}`).then(m => m.updateActivityCountPreview?.());
  }
}

// ── Login-Formular absenden ────────────────────────────────
loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  setLoginLoading(true);
  hideLoginError();

  try {
    await signInWithEmailAndPassword(auth, email, password);
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
function showDashboard(user) {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  setLoginLoading(false);

  if (userEmailEl) userEmailEl.textContent = user.email;
  if (userAvatarEl) userAvatarEl.textContent = user.email.charAt(0).toUpperCase();
}

function showLoginScreen() {
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  setLoginLoading(false);
}

function setLoginLoading(loading) {
  if (!loginBtn) return;
  loginBtn.disabled = loading;
  loginBtn.textContent = loading ? "Einloggen…" : "Einloggen";
}

function showLoginError(message) {
  if (!loginError) return;
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

function hideLoginError() {
  loginError?.classList.add("hidden");
}

function getReadableAuthError(code) {
  const errors = {
    "auth/invalid-email": "Ungültige E-Mail-Adresse.",
    "auth/user-disabled": "Dieses Konto wurde deaktiviert.",
    "auth/user-not-found": "Kein Konto mit dieser E-Mail gefunden.",
    "auth/wrong-password": "Falsches Passwort.",
    "auth/invalid-credential": "E-Mail oder Passwort falsch.",
    "auth/too-many-requests": "Zu viele Versuche. Bitte später nochmal.",
    "auth/network-request-failed": "Netzwerkfehler. Prüfe deine Verbindung.",
  };
  return errors[code] ?? `Login-Fehler (${code}). Bitte versuche es erneut.`;
}
