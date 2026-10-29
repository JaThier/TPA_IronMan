// ============================================================
// js/hub.js
// Community Hub – Fairer Vergleich der Trainingsleistungen aller User
// ============================================================

import { auth, db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { showToast } from "./ui-helpers.js";

/** Konfiguration der verfügbaren Zeiträume für den fairen Leistungsvergleich */
export const HUB_TIMEFRAMES = {
  "7d":   { id: "7d",   label: "1 Woche",   shortLabel: "1 Woche",   days: 7 },
  "14d":  { id: "14d",  label: "2 Wochen",  shortLabel: "2 Wochen",  days: 14 },
  "30d":  { id: "30d",  label: "1 Monat",   shortLabel: "1 Monat",   days: 30 },
  "60d":  { id: "60d",  label: "2 Monate",  shortLabel: "2 Monate",  days: 60 },
  "180d": { id: "180d", label: "6 Monate",  shortLabel: "6 Monate",  days: 180 },
  "365d": { id: "365d", label: "Jahr",      shortLabel: "1 Jahr",    days: 365 },
};

let currentUser = null;
let cachedHubUsers = [];
let currentHubTimeframe = (() => {
  try {
    const saved = localStorage.getItem("tpa_hub_timeframe");
    return HUB_TIMEFRAMES[saved] ? saved : "7d";
  } catch (_) {
    return "7d";
  }
})();
let currentHubDiscipline = "bike"; // "bike" | "run" | "swim" | "all"
let currentHubHoursDiscipline = "all"; // "bike" | "run" | "swim" | "all"
let currentHubUsers = [];
let disciplinesChartInstance = null;
let hoursChartInstance = null;

/**
 * Initialisiert den Hub nach dem Login.
 * @param {import("firebase/auth").User} user
 */
export async function initHub(user) {
  currentUser = user;
  bindHubControls();
  await loadAndRenderHub();
}

/**
 * Bindet Event-Listener an die Steuerungselemente (Aktualisieren-Button und Zeitraum-Dropdown).
 */
function bindHubControls() {
  const refreshBtn = document.getElementById("hub-refresh-btn");
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "true";
    refreshBtn.addEventListener("click", () => loadAndRenderHub(true));
  }

  const timeframeSelect = document.getElementById("hub-timeframe-select");
  if (timeframeSelect) {
    timeframeSelect.value = currentHubTimeframe;
    if (!timeframeSelect.dataset.bound) {
      timeframeSelect.dataset.bound = "true";
      timeframeSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        if (HUB_TIMEFRAMES[val]) {
          currentHubTimeframe = val;
          try {
            localStorage.setItem("tpa_hub_timeframe", currentHubTimeframe);
          } catch (_) {}
          renderHubContent(cachedHubUsers);
        }
      });
    }
  }
}

/**
 * Berechnet aggregierte Statistiken für einen bestimmten Zeitraum in Tagen.
 * Berücksichtigt strikt nur Aktivitäten innerhalb des gewünschten Zeitfensters.
 * @param {Array} activities
 * @param {number} days
 */
function computeStatsForTimeframe(activities, days) {
  const isSwim = (a) => ["Swim", "OpenWaterSwim"].includes(a.type || a.sport_type);
  const isBike = (a) => ["Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide", "Handcycle"].includes(a.type || a.sport_type);
  const isRun  = (a) => ["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(a.type || a.sport_type);

  const now = Date.now();
  const cutoff = now - (days * 24 * 3600 * 1000);

  const periodActs = (activities || []).filter(a => {
    const raw = a.start_date || a.start_date_local || a.date;
    if (!raw) return false;
    let t = 0;
    if (typeof raw === "number") {
      t = raw < 1e11 ? raw * 1000 : raw;
    } else {
      t = new Date(raw).getTime();
    }
    return !isNaN(t) && t >= cutoff && t <= (now + 86400000);
  });

  const swimKm     = Math.round((periodActs.filter(isSwim).reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000) * 10) / 10;
  const bikeKm     = Math.round((periodActs.filter(isBike).reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000) * 10) / 10;
  const runKm      = Math.round((periodActs.filter(isRun).reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000) * 10) / 10;
  const triKm      = Math.round((swimKm + bikeKm + runKm) * 10) / 10;
  const rawTotalKm = Math.round((periodActs.reduce((s, a) => s + (parseFloat(a.distance) || 0), 0) / 1000) * 10) / 10;
  const totalKm    = triKm > 0 ? triKm : rawTotalKm;

  const swimHours  = Math.round((periodActs.filter(isSwim).reduce((s, a) => s + (parseFloat(a.moving_time) || 0), 0) / 3600) * 10) / 10;
  const bikeHours  = Math.round((periodActs.filter(isBike).reduce((s, a) => s + (parseFloat(a.moving_time) || 0), 0) / 3600) * 10) / 10;
  const runHours   = Math.round((periodActs.filter(isRun).reduce((s, a) => s + (parseFloat(a.moving_time) || 0), 0) / 3600) * 10) / 10;
  const totalHours = Math.round((periodActs.reduce((s, a) => s + (parseFloat(a.moving_time) || 0), 0) / 3600) * 10) / 10;

  return {
    totalKm,
    totalHours,
    activityCount: periodActs.length,
    swimKm,
    bikeKm,
    runKm,
    swimHours,
    bikeHours,
    runHours,
  };
}

/**
 * Gibt die passenden Statistiken für einen Nutzer im gewünschten Zeitraum zurück.
 * Nutzt primär die tatsächlichen Aktivitäten des Athleten, falls vorhanden.
 * @param {Object} userDoc
 * @param {string} tfId
 */
function getUserStatsForTimeframe(userDoc, tfId = currentHubTimeframe) {
  const tf = HUB_TIMEFRAMES[tfId] || HUB_TIMEFRAMES["7d"];

  // 1. Haben wir Aktivitäten für diesen Athleten?
  // (entweder aus dem Firestore-Dokument oder für den aktuellen User direkt aus dem Speicher)
  const myUid = currentUser?.uid || auth.currentUser?.uid;
  const isMe = Boolean(myUid && (userDoc.uid === myUid || userDoc.id === myUid));

  let acts = userDoc?.activities;
  if ((!acts || acts.length === 0) && isMe) {
    acts = window.stravaActivities || [];
  }

  if (acts && Array.isArray(acts) && acts.length > 0) {
    return computeStatsForTimeframe(acts, tf.days);
  }

  // 2. Gespeicherte periods aus Firestore (falls vorhanden)
  if (userDoc?.periods && userDoc.periods[tf.id]) {
    const p = { ...userDoc.periods[tf.id] };
    if (p.bikeHours == null || p.runHours == null || p.swimHours == null) {
      const estSwimH = (parseFloat(p.swimKm) || 0) / 3.0;
      const estBikeH = (parseFloat(p.bikeKm) || 0) / 28.0;
      const estRunH  = (parseFloat(p.runKm)  || 0) / 10.5;
      const estSumH  = estSwimH + estBikeH + estRunH;
      const totH     = parseFloat(p.totalHours) || estSumH || 0;
      p.swimHours = estSumH > 0 ? Math.round((totH * (estSwimH / estSumH)) * 10) / 10 : 0;
      p.bikeHours = estSumH > 0 ? Math.round((totH * (estBikeH / estSumH)) * 10) / 10 : 0;
      p.runHours  = estSumH > 0 ? Math.round((totH * (estRunH / estSumH)) * 10) / 10 : 0;
    }
    return p;
  }

  // 3. Mathematisch sauberer Proportional-Fallback für ältere Hub-Dokumente
  // (Athleten, deren Daten vor der Zeitraum-Filterung gespeichert wurden):
  const fallback = userDoc?.stats || {};
  const allTimeBike = parseFloat(fallback.bikeKm) || 0;
  const allTimeRun  = parseFloat(fallback.runKm) || 0;
  const allTimeSwim = parseFloat(fallback.swimKm) || 0;
  const allTimeDiscSum = allTimeBike + allTimeRun + allTimeSwim;
  const allTimeTotalKm = parseFloat(fallback.totalKm) || allTimeDiscSum || 0;
  const allTimeHours = parseFloat(fallback.totalHours) || 0;
  const allTimeActs = parseInt(fallback.activityCount, 10) || 0;

  const last30Km = parseFloat(fallback.last30DaysKm) || 0;
  const last30Hours = parseFloat(fallback.last30DaysHours) || 0;

  // Disziplinen-Verhältnis des Athleten ermitteln
  const bikeRatio = allTimeDiscSum > 0 ? (allTimeBike / allTimeDiscSum) : 0;
  const runRatio  = allTimeDiscSum > 0 ? (allTimeRun  / allTimeDiscSum) : 0;
  const swimRatio = allTimeDiscSum > 0 ? (allTimeSwim / allTimeDiscSum) : 0;

  // 30-Tage Basis-Kilometer ermitteln
  const effective30Km = last30Km > 0 ? last30Km : (allTimeTotalKm > 0 ? allTimeTotalKm * (30 / 365) : 0);
  const effective30Hours = last30Hours > 0 ? last30Hours : (allTimeHours > 0 ? allTimeHours * (30 / 365) : 0);
  const base30Acts = (allTimeTotalKm > 0 && allTimeActs > 0)
    ? Math.max(1, Math.round(allTimeActs * (effective30Km / allTimeTotalKm)))
    : Math.max(0, Math.round(allTimeActs / 12));

  let targetKm = 0;
  let targetHours = 0;
  let targetActs = 0;

  if (tf.days <= 30) {
    const ratio30 = tf.days / 30;
    targetKm = effective30Km * ratio30;
    targetHours = effective30Hours * ratio30;
    targetActs = Math.max(targetKm > 0 ? 1 : 0, Math.round(base30Acts * ratio30));
  } else if (tf.days >= 365) {
    targetKm = allTimeTotalKm > 0 ? allTimeTotalKm : effective30Km * 12;
    targetHours = allTimeHours > 0 ? allTimeHours : effective30Hours * 12;
    targetActs = allTimeActs > 0 ? allTimeActs : base30Acts * 12;
  } else {
    // Zwischen 30 und 365 Tagen linear interpolieren
    const extraDays = tf.days - 30;
    const remainingDays = 365 - 30; // 335
    const fullKm = allTimeTotalKm > effective30Km ? allTimeTotalKm : effective30Km * (365 / 30);
    const fullHours = allTimeHours > effective30Hours ? allTimeHours : effective30Hours * (365 / 30);
    const fullActs = allTimeActs > base30Acts ? allTimeActs : base30Acts * 12;

    const remainingKm = Math.max(0, fullKm - effective30Km);
    const remainingHours = Math.max(0, fullHours - effective30Hours);
    const remainingActs = Math.max(0, fullActs - base30Acts);
    const progressRatio = Math.min(1, extraDays / remainingDays);

    targetKm = effective30Km + (remainingKm * progressRatio);
    targetHours = effective30Hours + (remainingHours * progressRatio);
    targetActs = base30Acts + Math.round(remainingActs * progressRatio);
  }

  // Aufteilung strikt nach Disziplin-Ratio, damit Summe exakt Gesamt (km) entspricht
  const periodBike = Math.round(targetKm * bikeRatio * 10) / 10;
  const periodRun  = Math.round(targetKm * runRatio * 10) / 10;
  const periodSwim = Math.round(targetKm * swimRatio * 10) / 10;
  const periodTotal = Math.round((periodBike + periodRun + periodSwim) * 10) / 10;

  const estSwimH = periodSwim / 3.0;
  const estBikeH = periodBike / 28.0;
  const estRunH  = periodRun / 10.5;
  const estSumH  = estSwimH + estBikeH + estRunH;
  const roundedTargetHours = Math.round(targetHours * 10) / 10;

  return {
    totalKm:       periodTotal > 0 ? periodTotal : Math.round(targetKm * 10) / 10,
    totalHours:    roundedTargetHours,
    activityCount: targetActs,
    swimKm:        periodSwim,
    bikeKm:        periodBike,
    runKm:         periodRun,
    swimHours:     estSumH > 0 ? Math.round((roundedTargetHours * (estSwimH / estSumH)) * 10) / 10 : 0,
    bikeHours:     estSumH > 0 ? Math.round((roundedTargetHours * (estBikeH / estSumH)) * 10) / 10 : 0,
    runHours:      estSumH > 0 ? Math.round((roundedTargetHours * (estRunH / estSumH)) * 10) / 10 : 0,
  };
}

/**
 * Veröffentlicht die aggregierten Statistiken sowie die Aktivitätenliste des aktuellen Nutzers
 * für ALLE Vergleichszeiträume in Firestore (Sammlung /hub).
 * @param {Array} activities
 * @param {Object} athlete
 */
export async function publishUserStatsToHub(activities = [], athlete = null) {
  const user = currentUser || auth.currentUser;
  if (!user) return;

  try {
    const now = Date.now();
    const periods = {};

    // Berechne aggregierte Metriken für jede Zeitraum-Option
    for (const [tfId, tf] of Object.entries(HUB_TIMEFRAMES)) {
      periods[tfId] = computeStatsForTimeframe(activities, tf.days);
    }

    // Ermittle Datenabdeckung (ältester Aktivitäten-Zeitstempel)
    const timestamps = (activities || [])
      .map(a => {
        const raw = a.start_date || a.start_date_local || a.date;
        if (!raw) return 0;
        return typeof raw === "number" ? (raw < 1e11 ? raw * 1000 : raw) : new Date(raw).getTime();
      })
      .filter(t => !isNaN(t) && t > 0);
    const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const syncedDays = oldestTimestamp ? Math.max(1, Math.round((now - oldestTimestamp) / (24 * 3600 * 1000))) : 0;

    // Schlanke Aktivitäten-Liste für teamweiten dynamischen Zeitabgleich mitspeichern
    const simplifiedActivities = (activities || []).map(a => ({
      id:          a.id || null,
      name:        a.name || "",
      type:        a.type || a.sport_type || "Other",
      distance:    parseFloat(a.distance) || 0,
      moving_time: parseFloat(a.moving_time) || 0,
      start_date:  a.start_date || a.start_date_local || "",
    }));

    // Priorisiere benutzerdefinierten Anzeigenamen
    let displayName = user.displayName;
    if (!displayName || displayName.includes("@")) {
      displayName = athlete?.athleteName || (athlete?.firstname ? `${athlete.firstname} ${athlete.lastname || ""}`.trim() : null);
    }
    if (!displayName || displayName.includes("@")) {
      displayName = user.email ? user.email.split("@")[0] : "Athlet";
    }

    const payload = {
      uid:                user.uid,
      name:               displayName,
      email:              user.email,
      avatar:             athlete?.athleteProfile || athlete?.profile || null,
      updatedAt:          new Date().toISOString(),
      activities:         simplifiedActivities,
      periods:            periods,
      syncedDays:         syncedDays,
      oldestActivityDate: oldestTimestamp ? new Date(oldestTimestamp).toISOString() : null,
      stats:              periods["30d"] || {
        totalKm: 0, totalHours: 0, activityCount: 0, swimKm: 0, bikeKm: 0, runKm: 0
      }
    };

    const ref = doc(db, "hub", user.uid);
    await setDoc(ref, payload, { merge: true });
    console.log("[hub] Eigene Statistiken für alle Zeiträume im Hub veröffentlicht:", payload.periods);

    // Lokalen Cache sofort synchron halten
    const existingIdx = cachedHubUsers.findIndex(u => (u.uid === user.uid || u.id === user.uid));
    if (existingIdx >= 0) {
      cachedHubUsers[existingIdx] = { ...cachedHubUsers[existingIdx], ...payload, id: user.uid };
    } else {
      cachedHubUsers.push({ id: user.uid, ...payload });
    }

    // Wenn der Hub sichtbar gerendert ist, sofort aktualisieren
    const hubContent = document.getElementById("hub-content");
    if (hubContent && !hubContent.querySelector(".spinner")) {
      renderHubContent(cachedHubUsers);
    }
  } catch (err) {
    if (err.code === "permission-denied") {
      console.warn("[hub] Firestore blockiert Schreiben auf /hub. Bitte Sicherheitsregeln prüfen.");
    } else {
      console.error("[hub] Fehler beim Veröffentlichen der Hub-Daten:", err);
    }
  }
}

/**
 * Stellt sicher, dass die eigenen Aktivitäten aus dem Arbeitsspeicher oder dem
 * Firestore-Aktivitäten-Cache (/users/{uid}/cache/activities) in den Hub gelangen.
 */
async function syncOwnStatsIfMissing(user) {
  if (!user) return;
  let acts = window.stravaActivities || [];
  let tokens = window.stravaTokens || null;

  if (!acts || acts.length === 0) {
    try {
      const cacheRef = doc(db, "users", user.uid, "cache", "activities");
      const cacheSnap = await getDoc(cacheRef);
      if (cacheSnap.exists() && Array.isArray(cacheSnap.data().data)) {
        acts = cacheSnap.data().data;
        window.stravaActivities = acts;
      }
    } catch (err) {
      console.warn("[hub] Konnte Aktivitäten-Cache nicht laden:", err);
    }
  }

  if (!tokens) {
    try {
      const stravaRef = doc(db, "users", user.uid, "profile", "strava");
      const stravaSnap = await getDoc(stravaRef);
      if (stravaSnap.exists()) {
        tokens = stravaSnap.data();
        window.stravaTokens = tokens;
      }
    } catch (err) {
      console.warn("[hub] Konnte Strava-Profil nicht laden:", err);
    }
  }

  if (acts && acts.length > 0) {
    await publishUserStatsToHub(acts, tokens);
  }
}

/**
 * Lädt alle Nutzerstatistiken aus Firestore und rendert die Ansicht.
 * @param {boolean} forceToast
 */
export async function loadAndRenderHub(forceToast = false) {
  renderHubSkeleton();
  bindHubControls();
  const user = currentUser || auth.currentUser;

  try {
    // Eigene Stats immer sicherstellen
    if (user) {
      await syncOwnStatsIfMissing(user);
    }

    const hubRef = collection(db, "hub");
    const snap = await getDocs(hubRef);

    const validUsers = [];
    snap.forEach((d) => {
      const data = d.data();
      const docId = d.id;

      if (!docId || docId === "undefined" || docId === "null" || docId === "NaN") {
        return;
      }

      const uid = data.uid || docId;
      validUsers.push({ id: docId, uid, ...data });
    });

    // Eindeutige Deduplizierung nach UID und E-Mail
    const userMap = new Map();
    for (const u of validUsers) {
      const key = u.uid || (u.email ? u.email.toLowerCase() : u.id);
      if (!userMap.has(key)) {
        userMap.set(key, u);
      } else {
        const existing = userMap.get(key);
        // Bevorzuge Dokument mit activities oder periods oder mit neuerem updatedAt
        const uHasData = Boolean(u.activities?.length || u.periods);
        const existHasData = Boolean(existing.activities?.length || existing.periods);
        if (uHasData && !existHasData) {
          userMap.set(key, u);
        } else if (u.id === user?.uid || u.uid === user?.uid) {
          userMap.set(key, u);
        } else if (new Date(u.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
          userMap.set(key, u);
        }
      }
    }

    // Eigene Aktivitäten des aktuellen Users immer im Hub-Eintrag sicherstellen
    if (user) {
      const myKey = user.uid;
      let meEntry = userMap.get(myKey);
      if (!meEntry) {
        for (const [, v] of userMap.entries()) {
          if (v.email && user.email && v.email.toLowerCase() === user.email.toLowerCase()) {
            meEntry = v;
            break;
          }
        }
      }

      const myActs = window.stravaActivities || [];
      if (meEntry) {
        if (myActs.length > 0) {
          meEntry.activities = myActs.map(a => ({
            id:          a.id || null,
            name:        a.name || "",
            type:        a.type || a.sport_type || "Other",
            distance:    parseFloat(a.distance) || 0,
            moving_time: parseFloat(a.moving_time) || 0,
            start_date:  a.start_date || a.start_date_local || "",
          }));
          meEntry.periods = Object.keys(HUB_TIMEFRAMES).reduce((acc, k) => {
            acc[k] = computeStatsForTimeframe(myActs, HUB_TIMEFRAMES[k].days);
            return acc;
          }, {});
        }
      } else {
        userMap.set(myKey, {
          id: user.uid,
          uid: user.uid,
          name: user.displayName || (user.email ? user.email.split("@")[0] : "Athlet"),
          email: user.email,
          updatedAt: new Date().toISOString(),
          activities: myActs.map(a => ({
            id:          a.id || null,
            name:        a.name || "",
            type:        a.type || a.sport_type || "Other",
            distance:    parseFloat(a.distance) || 0,
            moving_time: parseFloat(a.moving_time) || 0,
            start_date:  a.start_date || a.start_date_local || "",
          })),
          periods: Object.keys(HUB_TIMEFRAMES).reduce((acc, k) => {
            acc[k] = computeStatsForTimeframe(myActs, HUB_TIMEFRAMES[k].days);
            return acc;
          }, {}),
          stats: computeStatsForTimeframe(myActs, 30),
        });
      }
    }

    // Für alle Athleten Aktivitäten aus users/{uid}/cache/activities nachladen, falls noch nicht im Hub-Doc
    const allCrewUsers = Array.from(userMap.values());
    await Promise.allSettled(
      allCrewUsers.map(async (u) => {
        if (u.activities && Array.isArray(u.activities) && u.activities.length > 0) return;
        if (user && (u.uid === user.uid || u.id === user.uid) && window.stravaActivities?.length > 0) {
          u.activities = window.stravaActivities;
          return;
        }
        try {
          const cacheRef = doc(db, "users", u.uid, "cache", "activities");
          const cacheSnap = await getDoc(cacheRef);
          if (cacheSnap.exists() && Array.isArray(cacheSnap.data()?.data)) {
            u.activities = cacheSnap.data().data;
            console.log(`[hub] Aktivitäten für ${u.name || u.uid} aus users-Cache geladen: ${u.activities.length}`);
          }
        } catch (_) {
          // Zugriff auf andere User-Caches kann durch Firestore-Regeln beschränkt sein
        }
      })
    );

    cachedHubUsers = Array.from(userMap.values());

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

/**
 * Rendert den gesamten Hub-Inhalt basierend auf dem gewählten Zeitraum.
 * @param {Array} rawUsers
 */
function renderHubContent(rawUsers) {
  const container = document.getElementById("hub-content");
  if (!container) return;

  const tfInfo = HUB_TIMEFRAMES[currentHubTimeframe] || HUB_TIMEFRAMES["30d"];

  // Bereite Nutzerdaten mit den Statistiken für den ausgewählten Zeitraum auf
  const myUid = currentUser?.uid || auth.currentUser?.uid;
  const usersToDisplay = (rawUsers || []).map(u => ({
    ...u,
    currentStats: getUserStatsForTimeframe(u, tfInfo.id),
  }));

  const isSingleUser = usersToDisplay.length <= 1;

  // Sortierte Leaderboards berechnen (je nach Metrik im gewählten Zeitraum)
  const topSwim = [...usersToDisplay].sort((a, b) => (b.currentStats?.swimKm || 0) - (a.currentStats?.swimKm || 0))[0];
  const topBike = [...usersToDisplay].sort((a, b) => (b.currentStats?.bikeKm || 0) - (a.currentStats?.bikeKm || 0))[0];
  const topRun = [...usersToDisplay].sort((a, b) => (b.currentStats?.runKm || 0) - (a.currentStats?.runKm || 0))[0];
  const topHours = [...usersToDisplay].sort((a, b) => (b.currentStats?.totalHours || 0) - (a.currentStats?.totalHours || 0))[0];

  container.innerHTML = `
    ${isSingleUser ? `
      <div class="hub-single-user-banner">
        <div class="banner-icon">💡</div>
        <div class="banner-body">
          <strong>Bisher ist 1 Athlet im Hub registriert.</strong>
          <p>Sobald deine Kumpels sich einloggen und Strava verbinden, erscheinen sie hier automatisch im fairen Leistungsvergleich!</p>
        </div>
      </div>
    ` : ""}

    <!-- ── 1. Podiums / Hero Badges ──────────────────────── -->
    <div class="hub-podiums-grid">
      <div class="podium-card podium-swim">
        <div class="podium-badge">🏊‍♂️ WASSER-KÖNIG</div>
        <div class="podium-name">${(topSwim?.currentStats?.swimKm || 0) > 0 ? (topSwim?.name || "–") : "–"}</div>
        <div class="podium-metric">${(topSwim?.currentStats?.swimKm || 0).toFixed(1)} <span class="unit">km</span></div>
        <div class="podium-sub">Meiste Schwimm-Kilometer (${tfInfo.label})</div>
      </div>

      <div class="podium-card podium-bike">
        <div class="podium-badge">🚴‍♂️ STRASSEN-KÖNIG</div>
        <div class="podium-name">${(topBike?.currentStats?.bikeKm || 0) > 0 ? (topBike?.name || "–") : "–"}</div>
        <div class="podium-metric">${(topBike?.currentStats?.bikeKm || 0).toFixed(1)} <span class="unit">km</span></div>
        <div class="podium-sub">Meiste Rad-Kilometer (${tfInfo.label})</div>
      </div>

      <div class="podium-card podium-run">
        <div class="podium-badge">🏃‍♂️ LAUF-CHAMPION</div>
        <div class="podium-name">${(topRun?.currentStats?.runKm || 0) > 0 ? (topRun?.name || "–") : "–"}</div>
        <div class="podium-metric">${(topRun?.currentStats?.runKm || 0).toFixed(1)} <span class="unit">km</span></div>
        <div class="podium-sub">Meiste Lauf-Kilometer (${tfInfo.label})</div>
      </div>

      <div class="podium-card podium-hours">
        <div class="podium-badge">⏱️ AUSDAUER-LEADER</div>
        <div class="podium-name">${(topHours?.currentStats?.totalHours || 0) > 0 ? (topHours?.name || "–") : "–"}</div>
        <div class="podium-metric">${(topHours?.currentStats?.totalHours || 0).toFixed(1)} <span class="unit">Std.</span></div>
        <div class="podium-sub">Gesamte Trainingszeit (${tfInfo.label})</div>
      </div>
    </div>

    <!-- ── 2. Vergleichs-Diagramme ──────────────────────── -->
    <div class="hub-charts-grid">
      <div class="card hub-chart-card">
        <div class="card-header chart-header-with-filter">
          <div class="card-title">
            <span class="icon">📊</span>
            <h3 id="hub-discipline-chart-title">${getDisciplineChartTitle(currentHubDiscipline, tfInfo.label)}</h3>
          </div>
          <div class="discipline-toggle-group">
            <button class="chip discipline-chip ${currentHubDiscipline === 'bike' ? 'active' : ''}" data-discipline="bike" title="Nur Rad-Kilometer vergleichen">🚴 Rad</button>
            <button class="chip discipline-chip ${currentHubDiscipline === 'run' ? 'active' : ''}" data-discipline="run" title="Nur Lauf-Kilometer vergleichen">🏃 Laufen</button>
            <button class="chip discipline-chip ${currentHubDiscipline === 'swim' ? 'active' : ''}" data-discipline="swim" title="Nur Schwimm-Kilometer vergleichen">🏊 Schwimmen</button>
            <button class="chip discipline-chip ${currentHubDiscipline === 'all' ? 'active' : ''}" data-discipline="all" title="Gesamte Kilometer aller Disziplinen vergleichen">📊 Alle</button>
          </div>
        </div>
        <div class="chart-wrapper">
          <canvas id="hub-disciplines-chart"></canvas>
        </div>
      </div>

      <div class="card hub-chart-card">
        <div class="card-header chart-header-with-filter">
          <div class="card-title">
            <span class="icon">⏱️</span>
            <h3 id="hub-hours-chart-title">${getHoursChartTitle(currentHubHoursDiscipline, tfInfo.label)}</h3>
          </div>
          <div class="discipline-toggle-group">
            <button class="chip hours-discipline-chip ${currentHubHoursDiscipline === 'bike' ? 'active' : ''}" data-discipline="bike" title="Nur Rad-Stunden vergleichen">🚴 Rad</button>
            <button class="chip hours-discipline-chip ${currentHubHoursDiscipline === 'run' ? 'active' : ''}" data-discipline="run" title="Nur Lauf-Stunden vergleichen">🏃 Laufen</button>
            <button class="chip hours-discipline-chip ${currentHubHoursDiscipline === 'swim' ? 'active' : ''}" data-discipline="swim" title="Nur Schwimm-Stunden vergleichen">🏊 Schwimmen</button>
            <button class="chip hours-discipline-chip ${currentHubHoursDiscipline === 'all' ? 'active' : ''}" data-discipline="all" title="Gesamte Trainingsstunden aller Disziplinen vergleichen">📊 Alle</button>
          </div>
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
        <span class="plan-meta text-muted">${usersToDisplay.length} Athlet${usersToDisplay.length === 1 ? "" : "en"} • Zeitraum: <strong>${tfInfo.label}</strong></span>
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
              .sort((a, b) => (b.currentStats?.totalKm || 0) - (a.currentStats?.totalKm || 0))
              .map((u, idx) => {
                const s = u.currentStats || {};
                const isMe = Boolean(myUid && (u.uid === myUid || u.id === myUid));
                const athleteName = u.name || (isMe ? (auth.currentUser?.displayName || "Du") : "Athlet");
                const hasLimitedData = Boolean(u.syncedDays && u.syncedDays < (tfInfo.days - 2));
                return `
                  <tr class="${isMe ? 'row-me' : ''}">
                    <td class="rank-cell">
                      ${idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                    </td>
                    <td class="athlete-cell">
                      <div class="athlete-avatar">${(athleteName || "?").charAt(0).toUpperCase()}</div>
                      <div>
                        <strong>${athleteName}</strong>
                        ${isMe ? '<span class="badge-me">Du</span>' : ''}
                        ${hasLimitedData ? `<span class="badge-synced-days" title="Aktivitätsdaten dieses Athleten umfassen ${u.syncedDays} Tage">${u.syncedDays}d Daten</span>` : ''}
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

  // Discipline-Switcher Listener (Kilometer-Diagramm)
  document.querySelectorAll(".discipline-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".discipline-chip").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentHubDiscipline = btn.dataset.discipline;
      const titleEl = document.getElementById("hub-discipline-chart-title");
      if (titleEl) titleEl.textContent = getDisciplineChartTitle(currentHubDiscipline, tfInfo.label);
      renderDisciplinesChart(currentHubUsers, currentHubDiscipline);
    });
  });

  // Discipline-Switcher Listener (Stunden-Diagramm)
  document.querySelectorAll(".hours-discipline-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".hours-discipline-chip").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentHubHoursDiscipline = btn.dataset.discipline;
      const titleEl = document.getElementById("hub-hours-chart-title");
      if (titleEl) titleEl.textContent = getHoursChartTitle(currentHubHoursDiscipline, tfInfo.label);
      renderHoursChart(currentHubUsers, currentHubHoursDiscipline);
    });
  });

  // Chart.js Diagramme initialisieren
  renderHubCharts(usersToDisplay);
}

/**
 * Gibt den passenden Titel für das Disziplinen-Diagramm inklusive gewähltem Zeitraum zurück.
 * @param {string} discipline
 * @param {string} timeframeLabel
 */
function getDisciplineChartTitle(discipline, timeframeLabel = "") {
  const suffix = timeframeLabel ? ` • ${timeframeLabel}` : "";
  switch (discipline) {
    case "bike": return `Disziplinen-Vergleich: 🚴 Rad${suffix}`;
    case "run":  return `Disziplinen-Vergleich: 🏃 Laufen${suffix}`;
    case "swim": return `Disziplinen-Vergleich: 🏊 Schwimmen${suffix}`;
    default:     return `Disziplinen-Vergleich: 📊 Alle (Gesamt)${suffix}`;
  }
}

/**
 * Gibt den passenden Titel für das Trainingsvolumen-Diagramm (Stunden) inklusive gewähltem Zeitraum zurück.
 * @param {string} discipline
 * @param {string} timeframeLabel
 */
function getHoursChartTitle(discipline, timeframeLabel = "") {
  const suffix = timeframeLabel ? ` • ${timeframeLabel}` : "";
  switch (discipline) {
    case "bike": return `Trainingsvolumen: 🚴 Rad${suffix}`;
    case "run":  return `Trainingsvolumen: 🏃 Laufen${suffix}`;
    case "swim": return `Trainingsvolumen: 🏊 Schwimmen${suffix}`;
    default:     return `Trainingsvolumen: 📊 Alle (Gesamt)${suffix}`;
  }
}

/** Rendert die Chart.js Diagramme */
function renderHubCharts(users) {
  currentHubUsers = users;
  if (typeof Chart === "undefined") {
    console.warn("[hub] Chart.js ist noch nicht geladen.");
    return;
  }

  renderDisciplinesChart(users, currentHubDiscipline);
  renderHoursChart(users, currentHubHoursDiscipline);
}

/** Rendert das Disziplinen-Balkendiagramm je nach gewählter Sportart */
function renderDisciplinesChart(users, discipline = currentHubDiscipline) {
  if (disciplinesChartInstance) {
    disciplinesChartInstance.destroy();
    disciplinesChartInstance = null;
  }

  const ctxDisc = document.getElementById("hub-disciplines-chart")?.getContext("2d");
  if (!ctxDisc || typeof Chart === "undefined") return;

  const labels    = users.map(u => u.name || "Athlet");
  const swimData  = users.map(u => (u.currentStats?.swimKm != null ? u.currentStats.swimKm : 0));
  const bikeData  = users.map(u => (u.currentStats?.bikeKm != null ? u.currentStats.bikeKm : 0));
  const runData   = users.map(u => (u.currentStats?.runKm != null ? u.currentStats.runKm : 0));
  const totalData = users.map(u => (u.currentStats?.totalKm != null ? u.currentStats.totalKm : 0));

  let datasets = [];
  let yAxisTitle = "Kilometer (km)";

  if (discipline === "bike") {
    datasets = [
      {
        label: "🚴 Rad (km)",
        data: bikeData,
        backgroundColor: "rgba(249, 115, 22, 0.85)",
        borderColor: "#f97316",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Rad-Kilometer (km)";
  } else if (discipline === "run") {
    datasets = [
      {
        label: "🏃 Laufen (km)",
        data: runData,
        backgroundColor: "rgba(34, 197, 94, 0.85)",
        borderColor: "#22c55e",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Lauf-Kilometer (km)";
  } else if (discipline === "swim") {
    datasets = [
      {
        label: "🏊 Schwimmen (km)",
        data: swimData,
        backgroundColor: "rgba(59, 130, 246, 0.85)",
        borderColor: "#3b82f6",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Schwimm-Kilometer (km)";
  } else {
    // "all" -> Ein einzelner Gesamtbalken pro Athlet
    datasets = [
      {
        label: "📊 Gesamt (km)",
        data: totalData,
        backgroundColor: "rgba(232, 57, 30, 0.85)",
        borderColor: "#e8391e",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Gesamt-Kilometer (km)";
  }

  disciplinesChartInstance = new Chart(ctxDisc, {
    type: "bar",
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: {
          display: false,
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
            label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)} km`
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
          title: { display: true, text: yAxisTitle, color: "#64748b" }
        }
      }
    }
  });
}

/** Rendert das Trainingsvolumen (Stunden) Balkendiagramm je nach gewählter Sportart */
function renderHoursChart(users, discipline = currentHubHoursDiscipline) {
  if (hoursChartInstance) {
    hoursChartInstance.destroy();
    hoursChartInstance = null;
  }

  const ctxHours = document.getElementById("hub-hours-chart")?.getContext("2d");
  if (!ctxHours || typeof Chart === "undefined") return;

  const labels         = users.map(u => u.name || "Athlet");
  const swimHoursData  = users.map(u => (u.currentStats?.swimHours != null ? u.currentStats.swimHours : 0));
  const bikeHoursData  = users.map(u => (u.currentStats?.bikeHours != null ? u.currentStats.bikeHours : 0));
  const runHoursData   = users.map(u => (u.currentStats?.runHours != null ? u.currentStats.runHours : 0));
  const totalHoursData = users.map(u => (u.currentStats?.totalHours != null ? u.currentStats.totalHours : 0));

  let datasets = [];
  let yAxisTitle = "Stunden (h)";

  if (discipline === "bike") {
    datasets = [
      {
        label: "🚴 Rad (Stunden)",
        data: bikeHoursData,
        backgroundColor: "rgba(249, 115, 22, 0.85)",
        borderColor: "#f97316",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Rad-Zeit (Stunden)";
  } else if (discipline === "run") {
    datasets = [
      {
        label: "🏃 Laufen (Stunden)",
        data: runHoursData,
        backgroundColor: "rgba(34, 197, 94, 0.85)",
        borderColor: "#22c55e",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Lauf-Zeit (Stunden)";
  } else if (discipline === "swim") {
    datasets = [
      {
        label: "🏊 Schwimmen (Stunden)",
        data: swimHoursData,
        backgroundColor: "rgba(59, 130, 246, 0.85)",
        borderColor: "#3b82f6",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Schwimm-Zeit (Stunden)";
  } else {
    // "all" -> Ein einzelner Gesamtbalken pro Athlet
    datasets = [
      {
        label: "⏱️ Gesamt (Stunden)",
        data: totalHoursData,
        backgroundColor: "rgba(232, 57, 30, 0.85)",
        borderColor: "#e8391e",
        borderWidth: 1,
        borderRadius: 6,
      }
    ];
    yAxisTitle = "Gesamte Trainingszeit (Stunden)";
  }

  hoursChartInstance = new Chart(ctxHours, {
    type: "bar",
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: {
          display: false,
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
            label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)} Std.`
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
          title: { display: true, text: yAxisTitle, color: "#64748b" }
        }
      }
    }
  });
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
