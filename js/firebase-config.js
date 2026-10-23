// ============================================================
// js/firebase-config.js
// Firebase-Projekt-Konfiguration – tpaironman
// ============================================================

import { initializeApp }   from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth }         from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore }    from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { getAnalytics }    from "https://www.gstatic.com/firebasejs/13.1.0/firebase-analytics.js";

// ── Projekt-Konfiguration ──────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyBvGIG0rqbrSLomi9YYbgO9IePK5YOoqvA",
  authDomain:        "tpaironman.firebaseapp.com",
  projectId:         "tpaironman",
  storageBucket:     "tpaironman.firebasestorage.app",
  messagingSenderId: "474787007011",
  appId:             "1:474787007011:web:5f48096ace3559845f7f96",
  measurementId:     "G-V8GGVVXGTQ",
};

// ── Firebase initialisieren ────────────────────────────────
const app = initializeApp(firebaseConfig);

// ── Analytics (optional – nur in Produktion aktiv) ─────────
// Verhindert Fehler bei lokalen file://-Aufrufen
try {
  getAnalytics(app);
} catch (e) {
  // Analytics nicht verfügbar (z.B. lokale Entwicklung / Ad-Blocker)
}

// ── Services exportieren ───────────────────────────────────
export const auth = getAuth(app);
export const db   = getFirestore(app);

// Konfiguration ist eingetragen – isConfigured() immer true
export function isConfigured() {
  return true;
}
