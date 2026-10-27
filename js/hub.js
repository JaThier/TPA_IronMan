// ============================================================
// js/hub.js
// Community Hub – Vergleich der Trainingsleistungen aller User
// ============================================================

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";

let currentUser = null;
let cachedHubUsers = [];
let demoMode = false;
let disciplinesChartInstance = null;
let hoursChartInstance = null;

/**
 * Initialisiert den Hub nach dem Login.
 * @param {import("firebase/auth").User} user
 */
export async function initHub(user) {
  currentUser = user;
  
  // Event-Listener für Hub-Buttons
  document.getElementById("hub-refresh-btn")?.addEventListener("click", () => loadAndRenderHub(true));
  document.getElementById("demo-toggle-btn")?.addEventListener("click", toggleDemoMode);

  await loadAndRenderHub();
}

/**
 * Veröffentlicht die aggregierten Statistiken des aktuellen Nutzers in Firestore (Sammlung /hub).
 * Wird automatisch nach jedem Strava-Sync aufgerufen.
 * @param {Array} activities
 * @param {Object} athlete
 */
export async function publishUserStatsToHub(activities = [], athlete = null) {
  if (!currentUser) return;

  try {
    const totalKm    = activities.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const totalHours = activities.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;

    const swimKm = activities.filter(a => a.type === "Swim").reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const bikeKm = activities.filter(a => a.type === "Ride").reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const runKm  = activities.filter(a => a.type === "Run").reduce((s, a) => s + (a.distance || 0), 0) / 1000;

    const thirtyDaysAgo = Date.now() - (30 * 24 * 3600 * 1000);
    const last30DaysActs = activities.filter(a => new Date(a.start_date).getTime() >= thirtyDaysAgo);
    const last30DaysKm = last30DaysActs.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const last30DaysHours = last30DaysActs.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;

    let displayName = athlete?.firstname ? `${athlete.firstname} ${athlete.lastname || ""}`.trim() : null;
    if (!displayName) {
      displayName = currentUser.displayName || currentUser.email.split("@")[0];
    }

    const payload = {
      uid:       currentUser.uid,
      name:      displayName,
      email:     currentUser.email,
      avatar:    athlete?.profile || null,
      updatedAt: new Date().toISOString(),
      stats: {
        totalKm:         Math.round(totalKm * 10) / 10,
        totalHours:      Math.round(totalHours * 10) / 10,
        activityCount:   activities.length,
        swimKm:          Math.round(swimKm * 10) / 10,
        bikeKm:          Math.round(bikeKm * 10) / 10,
        runKm:           Math.round(runKm * 10) / 10,
        last30DaysKm:    Math.round(last30DaysKm * 10) / 10,
        last30DaysHours: Math.round(last30DaysHours * 10) / 10,
      }
    };

    const ref = doc(db, "hub", currentUser.uid);
    await setDoc(ref, payload, { merge: true });
    console.log("[hub] Eigene Statistiken erfolgreich im Hub veröffentlicht.");
  } catch (err) {
    if (err.code === "permission-denied") {
      console.warn("[hub] Firestore blockiert Schreiben auf /hub. Bitte Sicherheitsregeln prüfen.");
    } else {
      console.error("[hub] Fehler beim Veröffentlichen der Hub-Daten:", err);
    }
  }
}

/**
 * Lädt alle Nutzerstatistiken aus Firestore und rendert die Ansicht.
 * @param {boolean} forceToast
 */
export async function loadAndRenderHub(forceToast = false) {
  renderHubSkeleton();

  try {
    const hubRef = collection(db, "hub");
    const snap = await getDocs(hubRef);

    const users = [];
    snap.forEach((d) => {
      users.push({ id: d.id, ...d.data() });
    });

    cachedHubUsers = users;

    // Falls der aktuelle User noch nicht im Hub ist (z.B. vor erstem Strava-Sync)
    if (!cachedHubUsers.some(u => u.uid === currentUser?.uid)) {
      cachedHubUsers.push({
        uid: currentUser.uid,
        name: currentUser.displayName || currentUser.email.split("@")[0],
        email: currentUser.email,
        updatedAt: new Date().toISOString(),
        stats: {
          totalKm: 0, totalHours: 0, activityCount: 0,
          swimKm: 0, bikeKm: 0, runKm: 0,
          last30DaysKm: 0, last30DaysHours: 0,
        }
      });
    }

    renderHubContent(cachedHubUsers);
    if (forceToast) showToast("Hub-Statistiken aktualisiert!", "success");

  } catch (err) {
    console.error("[hub] Fehler beim Laden der Hub-Daten:", err);
    if (err.code === "permission-denied") {
      showHubPermissionNotice();
    } else {
      showToast("Hub-Daten konnten nicht geladen werden.", "error");
    }
  }
}

/** Umschalten des Demo-Modus mit simulierten Teamkollegen */
function toggleDemoMode() {
  demoMode = !demoMode;
  const btn = document.getElementById("demo-toggle-btn");
  if (btn) {
    btn.textContent = demoMode ? "👁️ Nur echte Daten anzeigen" : "👥 Demo-Crew einblenden";
    btn.classList.toggle("btn-active", demoMode);
  }
  renderHubContent(cachedHubUsers);
}

/** Gibt eine Liste von Mock-Athleten für die Vorschau zurück */
function getDemoUsers(currentUserData) {
  const current = currentUserData || {
    name: "Du",
    stats: { totalKm: 120, totalHours: 12, activityCount: 10, swimKm: 8, bikeKm: 80, runKm: 32 }
  };

  return [
    current,
    {
      uid: "mock-1",
      name: "Flo (IronMan 2026)",
      email: "flo@tpa-team.de",
      updatedAt: new Date(Date.now() - 3600000 * 4).toISOString(),
      stats: { totalKm: 284.5, totalHours: 18.2, activityCount: 16, swimKm: 12.5, bikeKm: 210.0, runKm: 62.0, last30DaysKm: 240, last30DaysHours: 15.5 }
    },
    {
      uid: "mock-2",
      name: "Maxi B.",
      email: "maxi@tpa-team.de",
      updatedAt: new Date(Date.now() - 3600000 * 12).toISOString(),
      stats: { totalKm: 215.0, totalHours: 15.8, activityCount: 13, swimKm: 16.0, bikeKm: 145.0, runKm: 54.0, last30DaysKm: 180, last30DaysHours: 13.0 }
    },
    {
      uid: "mock-3",
      name: "Lukas P.",
      email: "lukas@tpa-team.de",
      updatedAt: new Date(Date.now() - 3600000 * 28).toISOString(),
      stats: { totalKm: 310.2, totalHours: 21.0, activityCount: 19, swimKm: 9.2, bikeKm: 245.0, runKm: 56.0, last30DaysKm: 260, last30DaysHours: 18.0 }
    }
  ];
}

/** Rendert den gesamten Hub-Inhalt */
function renderHubContent(rawUsers) {
  const container = document.getElementById("hub-content");
  if (!container) return;

  const usersToDisplay = demoMode ? getDemoUsers(rawUsers[0]) : rawUsers;
  const isSingleUser = !demoMode && usersToDisplay.length <= 1;

  // Sortierte Leaderboards berechnen
  const topSwim  = [...usersToDisplay].sort((a,b) => (b.stats?.swimKm || 0) - (a.stats?.swimKm || 0))[0];
  const topBike  = [...usersToDisplay].sort((a,b) => (b.stats?.bikeKm || 0) - (a.stats?.bikeKm || 0))[0];
  const topRun   = [...usersToDisplay].sort((a,b) => (b.stats?.runKm || 0) - (a.stats?.runKm || 0))[0];
  const topHours = [...usersToDisplay].sort((a,b) => (b.stats?.totalHours || 0) - (a.stats?.totalHours || 0))[0];

  container.innerHTML = `
    ${isSingleUser ? `
      <div class="hub-single-user-banner">
        <div class="banner-icon">💡</div>
        <div class="banner-body">
          <strong>Bisher ist 1 Athlet im Hub registriert.</strong>
          <p>Sobald deine Kumpels sich einloggen und Strava verbinden, erscheinen sie hier automatisch im Leistungsvergleich!</p>
        </div>
        <button id="banner-demo-btn" class="btn btn-secondary" style="font-size:0.8rem; padding:0.4rem 0.8rem;">
          👥 Demo-Crew einblenden
        </button>
      </div>
    ` : ""}

    <!-- ── 1. Podiums / Hero Badges ──────────────────────── -->
    <div class="hub-podiums-grid">
      <div class="podium-card podium-swim">
        <div class="podium-badge">🏊‍♂️ WASSER-KÖNIG</div>
        <div class="podium-name">${topSwim?.name || "–"}</div>
        <div class="podium-metric">${(topSwim?.stats?.swimKm || 0).toFixed(1)} <span class="unit">km</span></div>
        <div class="podium-sub">Meiste Schwimm-Kilometer</div>
      </div>

      <div class="podium-card podium-bike">
        <div class="podium-badge">🚴‍♂️ STRASSEN-KÖNIG</div>
        <div class="podium-name">${topBike?.name || "–"}</div>
        <div class="podium-metric">${(topBike?.stats?.bikeKm || 0).toFixed(1)} <span class="unit">km</span></div>
        <div class="podium-sub">Meiste Rad-Kilometer</div>
      </div>

      <div class="podium-card podium-run">
        <div class="podium-badge">🏃‍♂️ LAUF-CHAMPION</div>
        <div class="podium-name">${topRun?.name || "–"}</div>
        <div class="podium-metric">${(topRun?.stats?.runKm || 0).toFixed(1)} <span class="unit">km</span></div>
        <div class="podium-sub">Meiste Lauf-Kilometer</div>
      </div>

      <div class="podium-card podium-hours">
        <div class="podium-badge">⏱️ AUSDAUER-LEADER</div>
        <div class="podium-name">${topHours?.name || "–"}</div>
        <div class="podium-metric">${(topHours?.stats?.totalHours || 0).toFixed(1)} <span class="unit">Std.</span></div>
        <div class="podium-sub">Gesamte Trainingszeit</div>
      </div>
    </div>

    <!-- ── 2. Vergleichs-Diagramme ──────────────────────── -->
    <div class="hub-charts-grid">
      <div class="card hub-chart-card">
        <div class="card-header">
          <div class="card-title">
            <span class="icon">📊</span>
            <h3>Disziplinen-Vergleich (Kilometer)</h3>
          </div>
          <span class="plan-meta text-muted">Schwimmen / Rad / Laufen</span>
        </div>
        <div class="chart-wrapper">
          <canvas id="hub-disciplines-chart"></canvas>
        </div>
      </div>

      <div class="card hub-chart-card">
        <div class="card-header">
          <div class="card-title">
            <span class="icon">⏱️</span>
            <h3>Trainingsvolumen (Stunden)</h3>
          </div>
          <span class="plan-meta text-muted">Gesamte Bewegungszeit</span>
        </div>
        <div class="chart-wrapper">
          <canvas id="hub-hours-chart"></canvas>
        </div>
      </div>
    </div>

    <!-- ── 3. Team-Tabelle ─────────────────────────────── -->
    <div class="card hub-table-card">
      <div class="card-header">
        <div class="card-title">
          <span class="icon">👥</span>
          <h3>Team-Rangliste</h3>
        </div>
        <span class="plan-meta text-muted">${usersToDisplay.length} Athlet${usersToDisplay.length === 1 ? "" : "en"}</span>
      </div>

      <div class="hub-table-responsive">
        <table class="hub-table">
          <thead>
            <tr>
              <th>Rang</th>
              <th>Athlet</th>
              <th>🏊 Schwimmen</th>
              <th>🚴 Rad</th>
              <th>🏃 Laufen</th>
              <th>Gesamt (km)</th>
              <th>Zeit (Std.)</th>
              <th>Einheiten</th>
            </tr>
          </thead>
          <tbody>
            ${[...usersToDisplay]
              .sort((a,b) => (b.stats?.totalKm || 0) - (a.stats?.totalKm || 0))
              .map((u, idx) => {
                const s = u.stats || {};
                const isMe = u.uid === currentUser?.uid;
                return `
                  <tr class="${isMe ? 'row-me' : ''}">
                    <td class="rank-cell">
                      ${idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                    </td>
                    <td class="athlete-cell">
                      <div class="athlete-avatar">${(u.name || "?").charAt(0).toUpperCase()}</div>
                      <div>
                        <strong>${u.name || "Unbekannt"}</strong>
                        ${isMe ? '<span class="badge-me">Du</span>' : ''}
                      </div>
                    </td>
                    <td>${(s.swimKm || 0).toFixed(1)} km</td>
                    <td>${(s.bikeKm || 0).toFixed(1)} km</td>
                    <td>${(s.runKm || 0).toFixed(1)} km</td>
                    <td><strong>${(s.totalKm || 0).toFixed(1)} km</strong></td>
                    <td>${(s.totalHours || 0).toFixed(1)} h</td>
                    <td>${s.activityCount || 0}</td>
                  </tr>
                `;
              }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("banner-demo-btn")?.addEventListener("click", toggleDemoMode);

  // Chart.js Diagramme initialisieren
  renderHubCharts(usersToDisplay);
}

/** Rendert die Chart.js Diagramme */
function renderHubCharts(users) {
  if (typeof Chart === "undefined") {
    console.warn("[hub] Chart.js ist noch nicht geladen.");
    return;
  }

  // Bestehende Chart-Instanzen zerstören
  if (disciplinesChartInstance) disciplinesChartInstance.destroy();
  if (hoursChartInstance) hoursChartInstance.destroy();

  const labels = users.map(u => u.name || "Athlet");
  const swimData = users.map(u => u.stats?.swimKm || 0);
  const bikeData = users.map(u => u.stats?.bikeKm || 0);
  const runData  = users.map(u => u.stats?.runKm || 0);
  const hoursData = users.map(u => u.stats?.totalHours || 0);

  // 1. Disziplinen Balkendiagramm
  const ctxDisc = document.getElementById("hub-disciplines-chart")?.getContext("2d");
  if (ctxDisc) {
    disciplinesChartInstance = new Chart(ctxDisc, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "🏊 Schwimmen (km)",
            data: swimData,
            backgroundColor: "rgba(59, 130, 246, 0.8)",
            borderColor: "#3b82f6",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "🚴 Rad (km)",
            data: bikeData,
            backgroundColor: "rgba(249, 115, 22, 0.8)",
            borderColor: "#f97316",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "🏃 Laufen (km)",
            data: runData,
            backgroundColor: "rgba(34, 197, 94, 0.8)",
            borderColor: "#22c55e",
            borderWidth: 1,
            borderRadius: 4,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: "#94a3b8", font: { family: "Inter", size: 12 } }
          },
          tooltip: {
            backgroundColor: "#111420",
            titleColor: "#e2e8f0",
            bodyColor: "#94a3b8",
            borderColor: "#252a40",
            borderWidth: 1,
            padding: 10,
          }
        },
        scales: {
          x: {
            ticks: { color: "#94a3b8", font: { family: "Inter" } },
            grid: { color: "rgba(37, 42, 64, 0.4)" }
          },
          y: {
            ticks: { color: "#94a3b8", font: { family: "Inter" } },
            grid: { color: "rgba(37, 42, 64, 0.4)" },
            title: { display: true, text: "Kilometer", color: "#64748b" }
          }
        }
      }
    });
  }

  // 2. Trainingsstunden Balkendiagramm
  const ctxHours = document.getElementById("hub-hours-chart")?.getContext("2d");
  if (ctxHours) {
    hoursChartInstance = new Chart(ctxHours, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "⏱️ Trainingszeit (Stunden)",
            data: hoursData,
            backgroundColor: "rgba(232, 57, 30, 0.85)",
            borderColor: "#e8391e",
            borderWidth: 1,
            borderRadius: 6,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: "#94a3b8", font: { family: "Inter", size: 12 } }
          },
          tooltip: {
            backgroundColor: "#111420",
            titleColor: "#e2e8f0",
            bodyColor: "#94a3b8",
            borderColor: "#252a40",
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: (ctx) => ` ${ctx.parsed.y} Stunden`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: "#94a3b8", font: { family: "Inter" } },
            grid: { color: "rgba(37, 42, 64, 0.4)" }
          },
          y: {
            ticks: { color: "#94a3b8", font: { family: "Inter" } },
            grid: { color: "rgba(37, 42, 64, 0.4)" },
            title: { display: true, text: "Stunden", color: "#64748b" }
          }
        }
      }
    });
  }
}

/** Skelett-Ladeanzeige */
function renderHubSkeleton() {
  const container = document.getElementById("hub-content");
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.75rem;padding:3rem;color:var(--clr-text-muted);justify-content:center;">
      <div class="spinner"></div>
      <span>Lade Team-Statistiken für den Hub…</span>
    </div>
  `;
}

/** Hinweis, falls die Firestore-Regel für /hub noch fehlt */
function showHubPermissionNotice() {
  const container = document.getElementById("hub-content");
  if (!container) return;

  container.innerHTML = `
    <div class="hub-permission-notice">
      <h3>🔒 Firestore-Regel für den Hub erforderlich</h3>
      <p>Damit die Team-Mitglieder ihre Trainingserfolge vergleichen können, ergänze bitte diese Regel in der Firebase Console unter <strong>Firestore Database &rarr; Regeln</strong>:</p>
      <pre><code>match /hub/{userId} {
  allow read:  if request.auth != null;
  allow write: if request.auth != null && request.auth.uid == userId;
}</code></pre>
      <button class="btn btn-primary" onclick="window.refreshHub()">Erneut prüfen</button>
    </div>
  `;
}

window.refreshHub = () => loadAndRenderHub(true);
