// ============================================================
// js/ui-helpers.js
// Wiederverwendbare UI-Hilfsfunktionen
// ============================================================

/**
 * Zeigt eine Toast-Benachrichtigung an.
 * @param {string} message  - Anzeigetext
 * @param {"success"|"error"|"info"} type
 * @param {number} duration - Anzeigedauer in ms (Standard: 4000)
 */
export function showToast(message, type = "info", duration = 4000) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // Automatisch entfernen
  setTimeout(() => {
    toast.style.animation = "none";
    toast.style.opacity   = "0";
    toast.style.transform = "translateX(20px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Formatiert Sekunden in hh:mm:ss oder mm:ss.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Formatiert Meter in km mit einer Dezimalstelle.
 * @param {number} meters
 * @returns {string}
 */
export function formatDistance(meters) {
  return `${(meters / 1000).toFixed(1)} km`;
}
