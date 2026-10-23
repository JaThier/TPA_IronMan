// ============================================================
// js/config.js
// Zentrales Secret-Loading aus Firestore
// ============================================================
// Secrets werden NICHT im Code gespeichert. Sie liegen in
// Firestore unter config/secrets und werden erst nach
// erfolgreichem Firebase-Login geladen.
//
// Firestore-Struktur:
//   config/secrets  {
//     stravaClientId:     "...",
//     stravaClientSecret: "...",
//     geminiApiKey:       "..."
//   }
//
// Befüllen: Firebase Console → Firestore → config → secrets
// ============================================================

import { db } from "./firebase-config.js";
import {
  doc, getDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// ── In-Memory-Cache (wird nach Login befüllt) ──────────────
let _secrets = null;

/**
 * Lädt die Secrets aus Firestore und cached sie für die Session.
 * Muss einmalig nach dem Login aufgerufen werden.
 *
 * @returns {Promise<{stravaClientId, stravaClientSecret, geminiApiKey}>}
 * @throws  {Error} wenn das Dokument nicht existiert oder kein Zugriff
 */
export async function loadSecrets() {
  // Cache: zweiter Aufruf gibt sofort zurück
  if (_secrets) return _secrets;

  const ref  = doc(db, "config", "secrets");
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    throw new Error(
      "Firestore-Dokument config/secrets nicht gefunden. " +
      "Bitte in der Firebase Console anlegen (siehe README)."
    );
  }

  const data = snap.data();

  // Pflichtfelder prüfen
  const required = ["stravaClientId", "stravaClientSecret", "geminiApiKey"];
  const missing  = required.filter((k) => !data[k]);
  if (missing.length > 0) {
    throw new Error(`Fehlende Felder in config/secrets: ${missing.join(", ")}`);
  }

  _secrets = data;
  console.log("[config] Secrets erfolgreich aus Firestore geladen.");
  return _secrets;
}

/**
 * Gibt die gecachten Secrets zurück.
 * Wirft einen Fehler, wenn loadSecrets() noch nicht aufgerufen wurde.
 * @returns {{stravaClientId, stravaClientSecret, geminiApiKey}}
 */
export function getSecrets() {
  if (!_secrets) {
    throw new Error("Secrets noch nicht geladen. loadSecrets() zuerst aufrufen.");
  }
  return _secrets;
}

/**
 * Löscht den Secret-Cache (z.B. beim Logout).
 */
export function clearSecrets() {
  _secrets = null;
  console.log("[config] Secret-Cache geleert.");
}
