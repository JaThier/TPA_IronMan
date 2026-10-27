# 🏊‍♂️🚴‍♂️🏃‍♂️ TPA IronMan – Training Dashboard

Ein persönliches Ironman-Trainings-Dashboard für die Crew. Gebaut als statische Single Page Application (SPA), gehostet auf **GitHub Pages**, mit **Firebase** (Auth + Firestore), **Strava API** und **Google Gemini AI**.

---

## 🚀 Tech-Stack

| Komponente       | Technologie                          |
|------------------|--------------------------------------|
| Hosting          | GitHub Pages (statisch)              |
| Authentication   | Firebase Auth (Email/Password)       |
| Datenbank        | Cloud Firestore (Spark-Tarif)        |
| Fitness-Daten    | Strava API (OAuth 2.0)               |
| KI-Trainingsplan | Google Gemini API (Free Tier)        |
| Frontend         | Vanilla HTML, CSS, JavaScript        |

---

## 📁 Projektstruktur

```
TPA_IronMan/
├── index.html              # Haupt-SPA (Login + Dashboard)
├── css/
│   └── style.css           # Dark-Mode Sport-Design
├── js/
│   ├── firebase-config.js  # Firebase-Projekt-Konfiguration ✅
│   ├── auth.js             # Login / Logout / Auth-State
│   ├── strava.js           # Strava OAuth + Aktivitäten
│   ├── gemini.js           # KI-Trainingsplan via Gemini API
│   └── ui-helpers.js       # Toast / Format-Hilfsfunktionen
└── README.md
```

---

## ⚙️ Setup-Anleitung

### 1. Firebase Projekt ✅ (erledigt)

Projekt `tpaironman` ist bereits angelegt.

- **Authentication** aktivieren → Sign-in-Methode: **E-Mail/Passwort** aktivieren
- **Firestore Database** aktivieren → Produktionsmodus starten

### 2. Firebase-Konfiguration ✅ (erledigt)

`js/firebase-config.js` ist bereits mit dem Projekt `tpaironman` befüllt.
Firebase SDK Version: **13.1.0**

### 3. Firestore-Sicherheitsregeln setzen

In der Firebase Console → Firestore → Regeln:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Benutzer-spezifische Daten (Profil, Aktivitäten-Cache, eigene Trainingspläne):
    // Nur der jeweilige eingeloggte User darf die eigenen Daten lesen und schreiben
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // App-Secrets (Strava Secret, Gemini Key):
    // Nur authentifizierte Nutzer dürfen lesen.
    // Schreiben vom Web-Frontend aus ist gesperrt (Schutz vor Überschreiben).
    match /config/{document} {
      allow read:  if request.auth != null;
      allow write: if false;
    }

  }
}
```

### 4. Secrets in Firestore ablegen (einmalig via Firebase Console)

Firebase Console → Firestore → Sammlung `config` → Dokument `secrets`:

| Feld                | Wert                      |
|---------------------|---------------------------|
| `stravaClientId`    | `(deine Strava Client-ID)`|
| `stravaClientSecret`| `(dein Strava Secret)`    |
| `geminiApiKey`      | `(dein Gemini API Key)`   |

> **Sicherheit:** Dieses Dokument ist durch die Firestore-Rules nur für
> eingeloggte Benutzer lesbar und kann vom Client nie überschrieben werden
> (`allow write: if false`).

### 4. Strava App anlegen

1. Gehe zu [strava.com/settings/api](https://www.strava.com/settings/api)
2. Neue Applikation erstellen
3. **Client ID** und **Client Secret** notieren
4. **Authorization Callback Domain**: `DEIN_USERNAME.github.io`
5. Daten in `js/strava.js` eintragen

### 5. Google Gemini API Key

1. Gehe zu [aistudio.google.com](https://aistudio.google.com)
2. API-Key generieren (Free Tier)
3. Key in `js/gemini.js` eintragen

> **⚠️ Sicherheitshinweis:** Da die App vollständig hinter Firebase Auth liegt, ist der Gemini API-Key nur für authentifizierte Benutzer sichtbar.

### 6. Benutzer anlegen

Firebase Console → Authentication → Benutzer → Benutzer hinzufügen (E-Mail + Passwort)

### 7. Auf GitHub Pages deployen

```bash
git add .
git commit -m "Initial commit"
git push origin main
```

GitHub Repository → Settings → Pages → Source: `main` Branch → `/` (root)

Die App ist dann erreichbar unter: `https://DEIN_USERNAME.github.io/TPA_IronMan/`

---

## 📊 Firestore Datenstruktur

```
firestore/
├── users/{userId}/
│   ├── profile     { name, stravaAccessToken, stravaRefreshToken, stravaAthleteId }
│   └── activities  [{ id, type, distance, movingTime, startDate }]
└── trainingPlans/{planId}/
    ├── ownerId     string (userId)
    ├── createdAt   timestamp
    ├── aiGenerated boolean
    └── weekPlan    { monday: { type, duration, description }, ... }
```

---

## 🔄 Workflows

### Strava Sync
1. User klickt "Mit Strava verbinden" → OAuth-Redirect zu Strava
2. Callback mit `code` → Token-Austausch (via Strava-Token-Endpoint)
3. Token in Firestore unter `users/{uid}/profile` speichern
4. Letzte Aktivitäten abrufen + anzeigen

### KI-Trainingsplan
1. User klickt "Plan von KI anpassen lassen"
2. Aktueller Plan + Strava-Stats → Prompt an Gemini API
3. Gemini antwortet mit JSON-Trainingsplan
4. Plan in Firestore unter `trainingPlans/{planId}` speichern + UI aktualisieren

---

## 👥 Team

Projekt für das IronMan-Trainings-Team (TPA)
