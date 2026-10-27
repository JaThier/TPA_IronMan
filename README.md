# 🏊‍♂️🚴‍♂️🏃‍♂️ TPA IronMan – Training Dashboard & Community Hub

Das **TPA IronMan Dashboard** ist eine webbasierte All-in-One Trainingsplattform für das TPA IronMan-Team. Entwickelt für Triathleten, vereint die Plattform automatisierte Trainingsauswertungen via Strava, personalisierte KI-Trainingssteuerung mit Google Gemini und einen interaktiven Team-Hub zum gegenseitigen Leistungsvergleich.

---

## 🎯 Projekt-Vision & Zweck

Die Vorbereitung auf eine Langdistanz erfordert monatelange Konsistenz, präzise Belastungssteuerung und gegenseitige Motivation im Team. Das Dashboard verfolgt drei Kernziele:

1. **Transparenz:** Vollständige Übersicht aller Einheiten über die drei Disziplinen (Schwimmen, Radfahren, Laufen) inklusive detaillierter Leistungsmetriken (Pace, Watt, Herzfrequenz, Trittfrequenz).
2. **Intelligenz:** Ein adaptiver Trainingsplan-Generator, der vergangene Trainingswochen analysiert und datenbasiert periodisierte Wochenpläne vorschlägt.
3. **Team-Spirit:** Ein Community-Hub mit dynamischen Leaderboards, Podien und Vergleichsdiagrammen, der den Trainingsfleiß aller Athleten visualisiert und motiviert.

---

## 🚀 Hauptfunktionen

### 🏃 Strava-Integration & Aktivitäten-Analyse
- **Direkte OAuth 2.0 Anbindung:** Nahtlose Verbindung zum persönlichen Strava-Account mit automatischer Token-Erneuerung.
- **Konfigurierbare Synchronisation:** Flexibler Abrufzeitraum der Aktivitäten (letzte 7, 14, 30, 60, 90, 180, 365 Tage oder benutzerdefinierte Zeitspannen).
- **Intelligente Filterung & Suche:** Sofortiges Filtern nach Disziplinen (Schwimmen, Radfahren, Laufen) sowie Volltextsuche nach Titeln.
- **Master-Detail-Ansicht:** Detaillierte Einzelanalyse jeder Trainingseinheit mit Distanz, Bewegungszeit, Höhenmetern, Pace / Geschwindigkeit, Herzfrequenzzonen, Watt-Werten und Kalorienverbrauch.
- **Vergleichsdiagramme (Chart.js):** Visuelle Gegenüberstellung der Metriken einer Einheit mit dem persönlichen Durchschnitt dieser Disziplin.

### 📋 KI-Trainingsplan (Google Gemini AI)
- **Automatisierte Trainingssteuerung:** Generierung strukturierter Wochenpläne (Montag bis Sonntag) mit spezifischen Disziplin-Einheiten und Ruhetagen.
- **Konfigurierbare Datenbasis:** Die KI berücksichtigt wahlweise die Einheiten der letzten 7 bis 90 Tage, um das aktuelle Fitnesslevel, Volumen und Ermüdung optimal einzuschätzen.
- **Gezielte Trainingsreize:** Vorgaben für Grundlagenausdauer (GA1/GA2), Schwellentraining, Koppeltrainings sowie Regenerationsphasen.
- **Persistierung in Firestore:** Jeder generierte Plan wird versioniert in Cloud Firestore gespeichert und bleibt geräteübergreifend erhalten.

### 🏆 Community Hub & Team-Rangliste
- **Automatischer Leistungsabgleich:** Sobald ein Teammitglied Aktivitäten synchronisiert, werden die aggregierten Gesamtkilometer und Trainingsstunden verschlüsselt im Hub veröffentlicht.
- **Saison- & Monatsstatistiken:** Automatische Erfassung von Gesamtumfängen und 30-Tage-Volumen je Disziplin.
- **Auszeichnungs-Podien:**
  - 🏊‍♂️ **Wasser-König:** Führender Athlet nach Schwimmkilometern
  - 🚴‍♂️ **Straßen-König:** Führender Athlet nach Radkilometern
  - 🏃‍♂️ **Lauf-Champion:** Führender Athlet nach Laufkilometern
  - ⏱️ **Ausdauer-Leader:** Führender Athlet nach gesamter Bewegungszeit
- **Disziplin- & Volumen-Charts:** Interaktive Balkendiagramme zum visuellen Team-Vergleich.
- **Team-Rangliste:** Vollständige Übersichtstabelle aller registrierten Athleten mit Rang, Disziplinkilometern, Gesamtvolumen und persönlicher Hervorhebung (`Du`-Badge).
- **Demo-Crew-Modus:** Optionaler Demonstrationsmodus zur Visualisierung mit simulierten Teamkollegen.

### 👤 Athleten-Konto & Profilverwaltung
- **Personalisierter Rufname:** Jeder Athlet kann seinen Anzeigenamen festlegen, der im Community Hub und auf den Leaderboard-Podien erscheint.
- **Onboarding-Dialog:** Automatischer Namensabfrage-Dialog beim ersten Login zur schnellen Personalisierung.
- **Strava-Verbindungsstatus:** Sofortige Statusprüfung der Schnittstelle direkt im Profilbereich.
- **Sichere Firebase-Authentifizierung:** Login und Session-Management über Firebase Authentication.

---

## 🛠️ Technologie-Stack

| Bereich | Technologie | Beschreibung |
|---|---|---|
| **Frontend** | Vanilla HTML5, CSS3, JavaScript (ES6+ Module) | Schlanke, blitzschnelle Single Page Application (SPA) ohne Framework-Overhead |
| **Styling** | Modernes Dark-Mode CSS | Hochwertige Sport-Ästhetik mit Glassmorphism, CSS-Variablen und Micro-Animations |
| **Datenbank** | Google Cloud Firestore (v13 Modular SDK) | NoSQL-Echtzeitdatenbank für Profile, Aktivitäten-Cache, Pläne und Hub-Statistiken |
| **Authentifizierung** | Firebase Auth | E-Mail/Passwort Authentifizierung |
| **Fitness-Schnittstelle**| Strava API v3 | OAuth 2.0 Autorisierungs-Flow und Aktivitätsabfragen |
| **Künstliche Intelligenz**| Google Gemini API (`gemini-1.5-flash`) | Schnelle Inferenz zur automatisierten Trainingsplanerstellung |
| **Daten-Visualisierung**| Chart.js (v4) | Responsive Diagramme für Aktivitätsdetails und Hub-Vergleiche |
| **Hosting** | GitHub Pages | Statische Bereitstellung mit clientseitigem Routing |

---

## 🔒 Architektur & Sicherheitskonzept

Das Dashboard arbeitet mit einem strengen serverlosen Sicherheitsmodell:

- **Trennung privater & geteilter Daten:**
  - Persönliche Strava-Tokens, Aktivitätsdaten und individuelle Einstellungen liegen isoliert unter `/users/{userId}/*` und sind ausschließlich für den jeweiligen Athleten les- und schreibbar.
  - Öffentliche Ranglisten-Metriken werden aggregiert unter `/hub/{userId}` abgelegt. Alle authentifizierten Teammitglieder können die Rangliste einsehen, jeder Athlet darf jedoch ausschließlich sein eigenes Dokument aktualisieren (`request.auth.uid == userId`).
- **Keine Secrets im Quellcode:**
  - Sensible API-Schlüssel (Strava Client Secret, Gemini API Key) liegen gesichert in der Firestore-Sammlung `/config/secrets`.
  - Frontend-Schreibzugriffe auf diese Konfiguration sind dauerhaft gesperrt (`allow write: if false`).
- **Clientseitige Fehlertoleranz:**
  - Robuste Fallbacks und automatische Synchronisation zwischen lokalem Aktivitäten-Cache und dem Community-Hub stellen sicher, dass Metriken verlässlich und ohne Datenverlust dargestellt werden.

---

## 📁 Projektstruktur

```
TPA_IronMan/
├── index.html              # Zentrale Single Page Application (Login, Dashboard & alle 4 Tabs)
├── css/
│   └── style.css           # Vollständiges UI-Designsystem (Dark Mode, Grid-Layouts, Komponenten)
├── js/
│   ├── firebase-config.js  # Firebase App-Initialisierung (Auth + Firestore SDK)
│   ├── config.js           # Sicheres Laden der API-Secrets aus Firestore
│   ├── auth.js             # Auth-State Management, Login/Logout & Tab-Navigation
│   ├── strava.js           # Strava OAuth 2.0 Flow, Caching & Master-Detail-Aktivitätsansicht
│   ├── gemini.js           # Gemini API Prompting & Trainingsplan-Generierung
│   ├── hub.js              # Community Hub, Leaderboard, Podien, Chart.js & Aggregation
│   ├── account.js          # Athleten-Profilverwaltung & Namenssynchronisation
│   └── ui-helpers.js       # Universelle Hilfsfunktionen (Toasts, Formatierungen)
└── README.md               # Projektdokumentation
```

---

## 👥 TPA IronMan Team

Entwickelt für die Athleten der **TPA IronMan Crew** zur gemeinsamen Vorbereitung auf den Wettkampftag.
