# Conclave – Technik

Alles Technische zu Conclave: Einrichtung, Aufbau, Funktionen im Detail, Konfiguration und Entwicklung.
Die kurze Vorstellung steht im [README](../README.md).


Ein Werkzeug, um Commander-Decks selbst zu bauen und zu pflegen: Decks per Link, Liste oder als
Starterdeck importieren oder selbst zusammenstellen, gegen Bracket-Regeln, Budget, Blacklist und
Tischregeln prüfen, testen, Partien festhalten und Proxies drucken. Die Ideen kommen von dir – die App
liefert Kartendaten, Prüfungen und Vorschläge aus Scryfall, EDHREC und Commander Spellbook.

```
GUI (Browser / Desktop-App) ──► FastAPI ──► Scryfall API + Bulk-Daten (lokale SQLite-DB)
                                       ├─► EDHREC (Empfehlungen, nach Bracket/Budget/Thema)
                                       ├─► Commander Spellbook (Combos, Bracket-Schätzung)
                                       ├─► Archidekt, Moxfield, MTGGoldfish, TappedOut, Deckstats (Deck-Import)
                                       └─► MTGJSON (Starterdecks / Precons)
```

## Voraussetzungen

- [uv](https://docs.astral.sh/uv/) (Python-Paketmanager; installiert Python 3.10+ bei Bedarf selbst)

## Einrichtung

```bash
git clone https://github.com/liehrdot/Conclave.git
cd Conclave
uv sync --extra gui          # Abhängigkeiten inkl. GUI installieren
uv run mtg-gui               # GUI starten → http://127.0.0.1:8765
```

**Optional, empfohlen:** lokale Kartendatenbank laden (siehe unten) – in der GUI unter
„Einstellungen → Kartendatenbank“.

Fertige Decks landen in `decks/<name>.json` und `decks/<name>.txt`. Die `.txt` kannst du direkt in
Moxfield, Archidekt oder ManaBox importieren.

## Brackets

| Bracket | Name | Game Changer | Mass Land Denial | Extra Turns | 2-Karten-Combos |
|---|---|---|---|---|---|
| 1 | Exhibition | 0 | nein | nein | nein |
| 2 | Core | 0 | nein | wenige, nicht chainen | nein |
| 3 | Upgraded | max. 3 | nein | wenige, nicht chainen | nicht früh im Spiel |
| 4 | Optimized | beliebig | ja | ja | ja |
| 5 | cEDH | beliebig | ja | ja | ja |

Stand: WotC-Update vom 21.10.2025 (keine Tutor-Limits mehr) und Game-Changer-Update vom 09.02.2026.
Die Game-Changer-Liste wird **live von Scryfall** (`is:gamechanger`) gelesen, nicht hart kodiert.
Die Deck-Prüfung fragt zusätzlich Commander Spellbook nach einer Bracket-Schätzung und nach Combos.

## Power-Feinabstimmung: Ziel-Stärke

Ein Bracket ist breit – deshalb gibt es pro Deck ein **Power-Profil**:

- **Feinstufe:** unteres / mittleres / oberes Bracket („Lower 4“, „Upper 3“).
- **Hausregeln** (nur strenger als das Bracket): max. Game Changer (z. B. Bracket 4 ohne Game
  Changer, Bracket 3 mit max. 2), max. Tutoren, keine 2-Karten-Combos / Extra Turns / Mass Land Denial.
- **Stil/Vibe:** z. B. „witzig“, „chaotisch“, „politisch“, „thematisch“ („Bracket 2, aber witzig“).
- **Power-Score:** Die Deck-Prüfung schätzt die Stärke auf der Bracket-Skala (z. B. 3.8 = oberes
  Bracket 3) aus Game Changern, Tutoren, Fast Mana, Free Spells, Combos, Kurve und Interaktion –
  transparent mit Einzelposten. Weicht das Deck deutlich von der Ziel-Stufe ab, gibt es eine Warnung.

In der GUI: im Deck-Check unter „Karten“ die **Ziel-Stärke** mit Skala (aktuell vs. Ziel), ▲/▼ „Stärker/Schwächer“,
Ziel-Bracket, und unter „Feiner einstellen“ Feinstufe, Hausregeln und Stil. „Ziel speichern“ legt das Ziel im Deck ab; die Deck-Prüfung misst
deine Karten daran – tauschen tust du sie selbst unter „Karten“ → „Bearbeiten“.

## Versionen: Verlauf, Diff, Wiederherstellen, Kopieren

Jede Speicherung eines Decks ist eine **Version** mit vollständigem Snapshot
(`decks/.versions/<deck>/`). Der Verlauf zeigt pro Version Notiz, Karten rein/raus,
Stufe (z. B. „oberes Bracket 3 → unteres Bracket 4“), Preis und Power-Score.

- **Vergleichen:** zwei beliebige Versionen (Karten, Stufe, Power, Preis)
- **Wiederherstellen:** alte Version wird wieder aktuell – als neue Version, nichts geht verloren
- **Als neues Deck kopieren:** z. B. eine Bracket-2- und eine Bracket-4-Variante desselben Commanders
- **Liste kopieren:** Decklist jeder Version für Moxfield/Archidekt

## Proxies drucken: Druckstudio mit MPC Autofill

Das [MPC Autofill](https://github.com/chilli-axe/mpc-autofill)-Programm (`autofill-windows.exe`)
lädt Bestellungen auf MakePlayingCards hoch. Der Deckbuilder erledigt alles davor selbst:

1. **Bildauswahl** – pro Karte automatisch der beste Scan: eigene Wahl › MPC-Autofill-Community-Scan
   (wenn ein Server eingestellt ist) › Scryfall. Im Deck-Tab **Drucken** der GUI siehst du alle Karten als
   Vorschau und kannst per Klick jede Karte gegen einen anderen Scan oder einen anderen Druck tauschen.
   Doppelseitige Karten bekommen ihre Rückseite.
2. **Druckdateien vorbereiten** – paralleler Download mit Cache (über alle Decks), Scryfall-Scans
   bekommen automatisch Beschnitt-Rand (Bleed) und gefüllte Ecken, dazu ein Kartenrücken (eigener,
   vom MPC-Autofill-Server oder ein schlichter). Ergebnis: `proxies/<deck>/<deck>.xml` mit nur
   lokalen Dateien – das Autofill-Programm muss nichts mehr herunterladen oder umrechnen.
   Die fertigen Druckbilder liegen lesbar benannt in `proxies/<deck>/images/` (z. B. `Sol Ring.jpg`,
   `_Kartenrücken.jpg`; Hardlinks auf den Cache, kein doppelter Speicher). Button **„Ordner öffnen“**
   öffnet ihn im Explorer/Finder. Die Lupe 🔍 auf jeder vorbereiteten Karte zeigt **Vorher/Nachher**:
   Original-Scan und Druckdatei nebeneinander, mit Zoom (Einpassen – 8×) und gekoppeltem Scrollen –
   ideal, um KI-hochskalierte Bilder zu kontrollieren. Der Bild-Cache selbst liegt unter
   `~/.cache/mtgdeck/images/` (Windows: `C:\Users\<Name>\.cache\mtgdeck\images\`).
   **Optional: KI-Hochskalierung (Opt-in, standardmäßig aus).** Mit Häkchen „KI-Hochskalierung“ im
   Druckstudio werden Scryfall-Scans mit [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)
   (ncnn-vulkan, kostenlos) vierfach hochgerechnet und mit 600 statt 300 DPI aufbereitet – Text und
   Linien werden deutlich schärfer. Einrichtung: `realesrgan-ncnn-vulkan-20220424-windows.zip` (bzw. `-ubuntu`/`-macos`) aus dem
   [Release v0.2.5.0](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0) herunterladen und nach
   `tools/realesrgan/` entpacken (der Ordner `models/` muss daneben liegen) oder den Pfad in den
   Einstellungen eintragen. Benötigt eine Vulkan-fähige Grafikkarte (integrierte Grafik reicht), dauert je
   nach GPU ein bis wenige Sekunden pro Karte; Ergebnisse werden gecacht. MPC-Autofill-Scans werden nie
   hochskaliert (die haben schon 800 DPI). KI kann feine Details verfälschen – stichprobenartig prüfen.
   **Druckraster entfernen:** Scryfall-Bilder sind Scans *gedruckter* Karten; Real-ESRGAN schärft das
   Druckraster sonst zu sichtbarer Schraffur (Himmel, Textfeld). Vor dem Hochskalieren wird der Scan
   deshalb minimal weichgezeichnet (Gauß 0,6 px) – in Tests mit echtem Real-ESRGAN verschwand die
   Schraffur, Text und Details blieben scharf. Einstellbar unter „KI-Hochskalierung“:
   aus / leicht / **normal** (Standard) / stark. Tipp: für Kartenscans `realesrgan-x4plus` nutzen,
   nicht das Anime-Modell.
3. **PDF zum Selbstdrucken** – direkt im Deckbuilder (ohne exe): A4/Letter, 3 × 3 Karten à 63 × 88 mm,
   Schnittmarken, optional mit DFC-Rückseiten.
4. **An MakePlayingCards senden** – startet das Autofill-Programm mit passenden Optionen in einem
   **Terminal direkt in der GUI** (echtes Pseudo-Terminal: ConPTY unter Windows 10/11, pty unter
   macOS/Linux). Seine Menüs – z. B. „How would you like to upload this order?“ – bedienst du dort mit
   Pfeiltasten und Enter (oder den Buttons ↑ ↓ Enter darunter). Login und Upload laufen im sich
   öffnenden Browser. Alternativ Häkchen „eigenes Fenster“ für ein separates Konsolenfenster.

Einrichtung: `autofill-windows.exe` in den Ordner `tools/` legen (oder Pfad unter „Einstellungen“),
optional die MPC-Autofill-Server-URL eintragen (die du auf mpcfill.com verwendest) und einen eigenen
Kartenrücken. Die `order.xml` lässt sich auch auf mpcfill.com importieren.

## Doppelseitige Karten (DFC)

Transform-, Modal-DFC- und ähnliche Karten (z. B. *Delver of Secrets // Insectile Aberration*)
werden überall mit beiden Seiten behandelt:

- **Deckansicht:** Symbol ⇄ hinter dem Namen; beim Überfahren erscheinen beide Seiten nebeneinander,
  ein Klick öffnet eine große Ansicht (auch am Tablet).
- **Druckstudio:** Schild „DFC“, ↻ dreht die Kachel um; für die Rückseite lässt sich ein eigenes Bild
  wählen und per 🔍 kontrollieren.
- **MPC:** Die Rückseite wird auf die Rückseite *derselben* Karte gedruckt (statt des Kartenrückens) –
  wie das Original, keine Platzhalterkarte nötig.
- **PDF zum Selbstdrucken:** Mit „DFC-Rückseiten“ kommen die Rückseiten als zusätzliche Karten ans
  Ende (zum Beilegen in die Hülle oder als Checkliste).
- Kartendatenbanken, die vor dieser Funktion geladen wurden, kennen die Rückseiten noch nicht: Sie werden
  dann automatisch live bei Scryfall nachgeladen, und die GUI empfiehlt ein Update der Datenbank.

## Proxy-Decks, Blacklist, Gegner, Tischregeln

- **Proxy-Deck:** Ein geproxtes Deck hat kein Budget (Bracket-Regeln gelten weiterhin). Es wird als
  Proxy-Deck markiert, der echte Kartenwert nur informativ angezeigt.
- **Budget:** Die Deck-Prüfung warnt, wenn das Deck das Budget überschreitet.
- **Blacklist:** Karten – und ganze Gruppen –, die nie in ein Deck dürfen. Gepflegt in der GUI oder direkt in
  `blacklist.txt` (eine Zeile pro Eintrag, `#` = Kommentar; Datei ist gitignored). Deutsche Namen
  werden in Oracle-Namen übersetzt. Neben Karten gehen **Begriffe** (deutsch oder englisch):
  True Duals, Fetchlands, Shocklands, Günstige Tutoren (≤ 2 Mana), Alle Tutoren, Fast Mana,
  Game Changer, Extra-Züge, Massen-Landzerstörung, Gratis-Zauber, Counterspells, Board Wipes,
  Stax (kuratierte Liste), 2-Karten-Combos (über Commander Spellbook) und „teurer als 20 €“. In der
  Datei stehen sie als `@true-duals`, `@cheap-tutors`, `@price>20` …; alles andere mit `@` davor
  (`@keine Gedankenkontrolle`) wird als freier Begriff gespeichert – eine Notiz für dich, die nicht
  automatisch geprüft wird. Suchergebnisse blenden Blacklist-Karten und Regel-Treffer aus,
  die Validierung meldet sie als Fehler („Blacklist-Regel „Günstige Tutoren“: Demonic Tutor“).
- **Gegnerdecks:** Decks, gegen die du gespielt hast – nur Commander und was dir aufgefallen ist, keine
  Kartenliste (Seite „Gegnerdecks“). Steckbrief mit eigenem Namen, Spieler, geschätztem Bracket, Runde
  (Tischregel) und Merkmalen wie Combo, viele Board Wipes, Flieger, Stax; Beobachtungen mit Datum, auch
  direkt aus „Partie festhalten“. Die Seite zeigt die Bilanz aller deiner Decks gegen das Gegnerdeck, verlinkt
  die typischen Karten des Commanders auf EDHREC. Gespeichert in `decks/.opponents.json`.
- **Tischregeln:** benannte Regelsätze für eine Runde („Freitagsrunde“, „Laden-Abend“). Anders als die
  Blacklist gelten sie nur für Decks, die sie gewählt haben – im Deck-Check unter „Karten“; das Deck merkt sich
  seine Tischregel. Ein Regelsatz kann enthalten: höchstes Bracket, max. Game Changer, max. Tutoren, Deckbudget
  (zählt auch für Proxy-Decks), „keine Proxies“, verbotene Begriffe wie bei der Blacklist (True Duals,
  Stax, 2-Karten-Combos, teurer als 10 € …), einzelne verbotene Karten und freie Absprachen (als
  Notiz, nicht geprüft). Verstöße sind Fehler der Prüfung, die Deck-Ampel und der Rule-0-Text zeigen sie; gilt
  zusätzlich ein Power-Profil mit Hausregeln, gewinnt die strengere Regel. Ändert sich ein Regelsatz,
  werden seine Decks neu geprüft. „Welche meiner Decks passen?“ prüft alle Decks gegen eine Runde.
  Gespeichert in `tablerules.json` (gitignored).

## Datensicherung & Papierkorb

- **Sicherung:** Unter *Einstellungen → Daten & Sicherung* sicherst du mit einem Klick alles, was du angelegt hast –
  Decks mit Versionen, Partien, Sammlung, Gegnerdecks, Tischregeln, Blacklist, Sammelbestellungen,
  Bildauswahl fürs Drucken und Einstellungen – als eine ZIP-Datei zum Herunterladen. Beim Start der
  GUI entsteht einmal am Tag automatisch eine Sicherung (die letzten 10 bleiben), gespeichert in `backups/`
  (`MTG_BACKUP_DIR`, gitignored). „Sicherung einspielen“ lädt eine ZIP hoch und stellt sie wieder her; vorher wird
  der aktuelle Stand automatisch gesichert, du kannst also zurück. Laufende Aufträge müssen dafür beendet sein.
  Ist der PC mit einem Sync-Server verbunden, wird der Stand der Sicherung mit dem der anderen Geräte zusammengeführt;
  dort wird dabei nichts gelöscht.
- **Papierkorb:** Gelöschte Decks landen samt Versionen und Partien im Papierkorb (`decks/.trash/`).
  Direkt nach dem Löschen gibt es „Rückgängig“, später im Papierkorb unter der Deckliste (zurückholen oder endgültig löschen).
- **Sicheres Speichern:** Alle Dateien werden atomar geschrieben (erst eine temporäre Datei, dann ausgetauscht) und
  beim Ändern gesperrt – auch wenn zwei Vorgänge (z. B. GUI und Sync) gleichzeitig speichern. Ist eine Datei
  doch einmal beschädigt, wird sie nie als „leer“ behandelt und überschrieben: Die App legt eine Kopie
  `<name>.beschaedigt-…` daneben und meldet den Fehler; ein beschädigtes Deck erscheint als „(beschädigt)“ in der Liste.
- **Gleicher Name:** Ein neues Deck überschreibt nie ein anderes Deck mit gleichem Namen (es bekommt z. B.
  `meren-2`). Änderungen behalten die Precon-Herkunft.
- **Schutz der lokalen Oberfläche:** Die GUI nimmt nur Anfragen an, die an diesen Rechner gerichtet sind, und lehnt
  ändernde Anfragen von fremden Webseiten ab. Mit `MTG_GUI_HOST=0.0.0.0` (im Netzwerk freigegeben) entfällt die Host-Prüfung.

## Sync zwischen Geräten (eigener Server)

PC, Laptop und die Handy-App gleichen sich über einen **eigenen kleinen Sync-Server** ab, z. B. bei Hetzner
für rund 6–7 € im Monat. Wie du ihn einrichtest, steht in der [Anleitung](sync-server-hetzner.md); es ist
ein Befehl auf dem Server.

- **Lokal zuerst:** Jedes Gerät hat alle Daten und funktioniert ohne Netz. Der Server ist nur die Drehscheibe.
- **Was abgeglichen wird:** Decks samt Versionen, Partien, Gegnerdecks, Sammlung, Tischregeln,
  Blacklist, Sammelbestellungen, Druckauswahl, Token-Anzahlen und eigene Bilder (alte Gespräche aus früheren
  Versionen bleiben erhalten, werden aber nicht mehr angezeigt).
  Einstellungen, Caches und Druckdateien bleiben pro Gerät.
- **Verbinden:** *Einstellungen → Sync zwischen Geräten* → Kopplungslink einfügen. Den Link zeigt der Server nach
  der Einrichtung, später jedes verbundene Gerät über „Weiteres Gerät koppeln“ (mit QR-Code; 15 Minuten gültig,
  einmal verwendbar).
- **Wann abgeglichen wird:** beim Start, kurz nach jeder Änderung, alle 5 Minuten (einstellbar), beim Zurückkehren
  ins Fenster und per Knopf. Neues von anderen Geräten meldet ein Hinweis.
- **Zusammenführen:** Einträge beider Geräte bleiben erhalten, also Partien, Gegnerdecks, Sammlung und Notizen. Ein
  Deck, das auf zwei Geräten umgebaut wurde, wird kartenweise zusammengeführt und behält alle Versionen; danach wird
  es neu geprüft. Haben beide Geräte dasselbe Feld unterschiedlich geändert, gilt die Fassung vom Server, und die
  andere steht unter „Konflikte“.
- **Sicherheit:** nur HTTPS; Geräte-Schlüssel liegen auf dem Server nur als Hash; Geräte lassen sich einzeln abmelden.
- **Handy-App „Conclave“** (Tisch-Ansicht „Am Tisch“) ([Plan](plan-handy-app.md)): Partien und Gegnerdecks am Tisch in Sekunden
  eintragen, Rule 0 zeigen, Karten auf Deutsch nachschlagen – auch offline. Sie liegt auf deinem Sync-Server unter
  `https://<dein-sync-server>/app/` und braucht keinen App-Store.
  - **Koppeln:** Am PC *Einstellungen → Sync zwischen Geräten → Weiteres Gerät koppeln* klicken und den QR-Code mit
    der Handy-Kamera scannen.
  - **Android:** Nach „Verbinden“ bist du drin. „Installieren“ legt die App auf den Startbildschirm.
  - **iPhone:** Leg die App zuerst über *Teilen → Zum Home-Bildschirm* ab. Öffne sie dann und tippe auf
    „QR-Code scannen“ oder „Code eingeben“. Eine installierte Web-App hat auf dem iPhone eigenen Speicher, deshalb wird
    der Code erst dort eingelöst.
  - **Unterwegs ohne Netz:** Einträge warten auf dem Handy und gehen raus, sobald wieder Netz da ist. Der PC holt sie
    beim nächsten Abgleich.
  - **Neue Versionen:** Sie kommen mit dem Server-Update. Die App bietet dann „Neu laden“ an.
  - **Abmelden:** in der App unter *Einstellungen* oder am PC in der Geräteliste.
  - **Runden-Helfer:** „Runde starten“ auf dem Tisch-Tab zählt während der Partie deine Leben, den
    Commander-Schaden je Gegner, Gift und deine Züge und hält jede Änderung pro Zug fest. Tippen zählt 1, Halten
    springt in Fünferschritten; Commander-Schaden und Gift trägst du nach Antippen der Kachel in einem eigenen Blatt
    ein. Bist du raus oder beendest du die Runde, öffnet sich das Partie-Formular vorbelegt; die Partie wird mit dem
    ganzen Verlauf gespeichert. „Beenden“ → „Ohne Ergebnis abbrechen“ verwirft eine Runde, ohne etwas zu speichern.
    Am PC steht die Runde nach dem Abgleich im Deck unter *Partien* („Runde ansehen“).
  - **Vorschau:** „Erst mal mit Beispieldaten ansehen“ zeigt die App ohne Kopplung.

## Desktop-App (Windows)

Dieselbe Oberfläche als eigenes Programm – ohne Python oder uv installieren zu müssen. Fertige Versionen
liegen unter [Releases](https://github.com/liehrdot/Conclave/releases) (`Conclave_<Version>_x64-setup.exe`,
pro Benutzer, ohne Adminrechte); jeder Push baut außerdem einen Test-Installer als Artefakt `mtgdeck-desktop-windows-setup`
des Workflows „Desktop“.

- **Aufbau:** Eine kleine Tauri-2-Hülle (Rust, WebView2) startet das mitgelieferte Backend (`mtgdeck-backend.exe`,
  ein PyInstaller-Ordner mit den statischen Dateien) auf einem freien
  Port mit zufälligem Token und zeigt es im Fenster. Stirbt das Backend, startet die Hülle es neu; klappt das
  fünfmal nicht, zeigt die Startseite das Protokoll und bietet einen neuen Versuch an.
- **Daten:** `%APPDATA%\MTG Deckbuilder` (Decks, Sammlung, Blacklist, Tischregeln, Sicherungen, Sync-Zustand),
  Cache in `%LOCALAPPDATA%\app.mtgdeck.desktop\cache` (das Programm selbst liegt in `%LOCALAPPDATA%\Conclave`; der Datenordner behält den alten Namen,
  und der erste Conclave-Installer entfernt das alte Programm „MTG Deckbuilder“ samt Startmenü-Eintrag),
  Protokoll `%APPDATA%\MTG Deckbuilder\logs\backend.log`.
  Bestehende Daten aus einem Projektordner kommen per Sync (siehe oben) oder über Einstellungen → Sicherung
  hochladen in die App.
- **Tray:** Schließen versteckt das Fenster, die App läuft weiter (Sync). Rechtsklick auf das
  Symbol neben der Uhr: Öffnen, Datenordner öffnen, Beim Anmelden starten, Beenden. Beim Zeigen auf das Symbol
  steht der Zustand (laufende Aufträge, letzter Sync). Ist das Fenster versteckt, meldet die App „Neu von deinen anderen Geräten“
  als Benachrichtigung.
  Einstellungen → **Desktop-App**: Autostart, Benachrichtigungen an/aus, Datenordner und Protokoll öffnen.
- **Updates:** Die App prüft kurz nach dem Start und einmal täglich die Releases. Eine neue Version meldet sie mit
  einem Hinweis; Einstellungen → Desktop-App zeigt sie und installiert sie auf Knopfdruck (die App beendet erst ihr
  Backend, dann läuft der Installer im Hintergrund durch und startet sie neu). Updates sind signiert – der öffentliche Schlüssel steckt in
  `desktop/src-tauri/tauri.conf.json`, nur damit signierte Pakete werden angenommen.
- **Entwicklung:** `uv run pyinstaller desktop/sidecar/backend.spec` baut das Backend nach `dist/mtgdeck-backend/`;
  `cd desktop && npx @tauri-apps/cli@^2 dev` startet die Hülle damit (oder mit `MTGDECK_BACKEND=<Pfad zur Exe>`).
  `cargo check --target x86_64-pc-windows-msvc` prüft den Rust-Teil auch unter Linux. Die fertige Exe kennt
  `--selftest` (startet das Backend, liest `/api/health`, Exit-Code 0 = in Ordnung) und `--hidden` (nur in den Tray).
- **Veröffentlichen:** `uv run python scripts/bump_version.py 0.2.0`, committen, `git tag v0.2.0 && git push --tags`.
  Der Workflow „Release“ prüft, dass die Version überall gleich ist, baut Backend und Hülle, signiert die
  Update-Pakete (Secrets `TAURI_SIGNING_PRIVATE_KEY` und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` im Repository) und legt
  das GitHub-Release mit Installer, Signatur und `latest.json` an.

## Web-GUI

```bash
uv run mtg-gui              # → http://127.0.0.1:8765
```

Aufbau (bewusst schlicht: eine Hauptaktion pro Seite, Selteneres eingeklappt):

- **Seitenleiste:** „+ Neues Deck“, deine Decks (ab 8 Decks mit Filter; ein roter Punkt markiert nicht
  legale), darunter der Papierkorb, sobald etwas drin liegt, unten Meine Sammlung und Sammelbestellungen sowie zwei Gruppen: **Meine Runde** (Gegnerdecks, Tischregeln, Blacklist)
  und **Hilfe** (Glossar, Einstellungen). Läuft ein Auftrag (z. B. Kartendatenbank laden),
  zeigt ein Hinweis mit Spinner oben in der Leiste, woran die App gerade arbeitet – ein Klick führt zurück. Auf dem Handy klappt die Leiste
  hinter ☰ weg.
- **Neues Deck** – vier Einstiege:
  - **Selbst zusammenstellen** (Standard): ein leeres Deck mit Commander (optional Partner/Background), Name und
    Bracket anlegen und die Karten im Bearbeiten-Modus hinzufügen – auch per **Drag & Drop von scryfall.com**:
    Kartenbild oder -link aus dem Browserfenster daneben in die App ziehen. Im offenen Deck kommt die Karte in die
    Liste, sonst wird sie Commander eines neuen leeren Decks.
  - per **Link** (Archidekt, Moxfield, MTGGoldfish, TappedOut, Deckstats, EDHREC-Durchschnittsdeck),
  - als **eingefügte Liste** (Moxfield-/Arena-/Text-Export, auch deutsche Namen),
  - als **Starterdeck** (Precons von MTGJSON, Suche nach Name, Set-Kürzel, Jahr).

  Vor dem Import zeigt eine Vorschau Name, Quelle, Kartenzahl und nicht erkannte Karten; markiert die Seite den
  Commander nicht, wählst du ihn aus den legendären Karten der Liste. Das Bracket wird geschätzt oder gewählt, die
  Kategorien der Quelle werden übernommen, wo sie passen. Moxfield blockt fremde Zugriffe oft – dann
  „Export“ → „Copy Plain Text“ und die Liste einfügen.
- **Laufende Aufträge** (Kartendatenbank, Druckdateien …): Status in Klartext, Laufzeit, Abbrechen; das technische
  Protokoll steckt unter „Details“. Ein Auftrag endet immer sichtbar – auch wenn sein letzter Schritt scheitert oder
  die App inzwischen neu gestartet wurde („Die Verbindung zum Auftrag ist weg …“); kein Lade-Kreisel dreht ewig. Ist
  Scryfall, EDHREC & Co. nicht erreichbar, steht da, welcher Dienst und was zu tun ist (statt „Internal Server Error“).
- **Deck-Ansicht** mit Kopfzeile (Commander, Stufe, legal/nicht legal, Preis, Version) und fünf Tabs –
  die Adresse merkt sich den Tab, der Zurück-Button des Browsers funktioniert:
  - **Karten:** gruppiert nach Kategorie, Typ, Manawert, Farbe oder Besitz, sortiert nach Name, Manawert
    oder Preis, als Liste (Bild beim Hovern) oder Bildraster; daneben der **Deck-Check** (Prüfung,
    Ziel-Stärke, Tischregel und Ampel-Bereiche in einem Kasten), Statistik,
    Sammlungs-Abgleich und „Tokens & Marker“. Klick auf eine Karte zeigt sie groß – bei doppelseitigen Karten
    beide Seiten – mit dem **Kartentext auf Deutsch** (gedruckter Text der neuesten deutschen Ausgabe,
    umschaltbar auf den englischen Oracle-Text), Manasymbolen und markierten Schlüsselwörtern samt Erklärung.
    **Ziel und Tischregel** sitzen im Deck-Check: Skala, Ziel-Bracket, „Ziel speichern“, die Tischregel.
    Feinstufe und Hausregeln stecken unter „Feiner einstellen“. Die Prüfung misst die Karten am Ziel,
    tauschen tust du sie unter „Bearbeiten“. **Rule 0** ist dort ein Knopf: der Text für die Runde
    (Stufe, Spielweise, Tempo, Game Changer, Combos, Tutoren, Extra-Züge, Massen-Landzerstörung, Proxys,
    Hausregeln – automatisch aus der Prüfung) groß zum Zeigen, mit Kopieren und Drucken auf eine Seite.
    **Deck-Check (Ampel):** Länder (Richtwert abhängig von Kurve und Ramp), Ramp, Kartenzug, Removal, Board
    Wipes, Manakurve und Siegbedingungen – je grün/gelb/rot mit „Warum wichtig?“. „Karten vorschlagen“ zeigt
    beliebte Karten dieser Rolle in deinen Farben (aus EDHREC- und Scryfall-Daten) und merkt sie im
    Bearbeiten-Modus vor.
    **Bearbeiten:** Karten hinzufügen, Anzahl ±, entfernen, Kategorie ändern und über ⇄
    „Ähnliche Karten“ (gleiche Rolle, passende Farben) tauschen – gespeichert wird alles zusammen als neue,
    geprüfte Version.
  - **Testen:** Starthand ziehen, London-Mulligan (der erste ist in Commander frei), Zug für Zug nachziehen,
    auf dem Play oder Draw; dazu exakte Wahrscheinlichkeiten: Länder in der Starthand, Landdrops bis Zug 5,
    Ramp bis Zug 2, Kartenzug bis Zug 3, Interaktion bis Zug 4.
  - **Partien:** die Bilanz und die gespielten Partien stehen zuerst. „Partie festhalten“ ist zugeklappt, sobald schon Partien da sind – Ergebnis, Gegner-Commander, letzter Zug, was schiefging
    (Schnellwahl wie „zu wenige Länder“, „kein Weg zu gewinnen“), beste Karte, Notiz. Die Bilanz zeigt
    Siegquote, Ø Zug, häufigste Probleme, Ergebnis pro Version, beste Karten und Gegner.
    Partien aus dem Runden-Helfer des Handys haben „Runde ansehen“: Lebenskurve, Commander-Schaden und was in
    jedem Zug passiert ist. Die Bilanz zeigt dazu, wer dir über alle Runden den meisten Schaden gemacht hat und in
    welchem eigenen Zug du im Schnitt am meisten Leben verlierst.
    Gespeichert in `decks/.games/<slug>.json`.
    Zu jedem Gegner gibt es ein Feld „Aufgefallen“; bekannte Gegnerdecks wählst du per Klick aus,
    neue Commander werden automatisch als Gegnerdeck gemerkt (abschaltbar).
  - **Verlauf:** Versionen vergleichen, wiederherstellen, als neues Deck kopieren. Darunter (und im ⋯-Menü)
    **„Mit anderem Deck vergleichen“**: zeigt, welche Karten dieses Deck zusätzlich braucht, welche frei werden und
    welche gemeinsam sind – vorausgewählt ist das Deck, von dem es kopiert wurde, sonst das mit den meisten
    gemeinsamen Karten. Mit Sammlung lässt sich „Nur was mir fehlt“ wählen; einzelne Karten abwählen, die
    Auswahl als Liste kopieren oder direkt **in eine Sammelbestellung** packen – ideal nach einem Umbau als neues Deck.
  - **Drucken:** zuerst die Kurzfassung, „Nur fehlende Karten“, „Tokens mitdrucken“, dann die Schritte
    Druckdateien vorbereiten und PDF. Unter „Weitere Optionen“: Bildquelle, Kartenstärke, Foil,
    Hochskalierung, MakePlayingCards und „in die Sammlung übernehmen“. „Bilder prüfen und tauschen“ ist darunter eingeklappt (öffnet sich von selbst, wenn Bilder fehlen).
    Mit „Tokens mitdrucken“ erscheint eine Liste aller Tokens, Embleme und Marker des Decks – jeweils mit
    Artwork (Klick wählt ein anderes) und eigener Anzahl (−/+ oder eintippen, 0 = nicht drucken), z. B.
    10 Humans, 5 Treasures, 1 Monarch. „Standard je N“ gilt für Tokens ohne eigene Anzahl; Embleme und Marker
    bekommen standardmäßig 1. Die Anzahlen merkt sich das Deck (`proxies/<deck>/tokens.json`, Teil der
    Sicherung); „↺ Standard“ setzt eine zurück. In Sammelbestellungen stehen die Anzahlen in den Positionen.
    Im Bildwähler einer Karte (Klick auf die Karte) gibt es neben MPC-Autofill- und Scryfall-Bildern
    **„Eigenes Bild hochladen …“** (oder ein Bild in den Dialog ziehen): JPG, PNG, WebP, TIFF oder BMP. Die App macht
    es druckfertig – Beschnittrand automatisch erkennen (MPC-Vorlage 2,74 × 3,74 Zoll) oder ergänzen, Bilder ohne
    Kartenformat mittig auf 63 × 88 mm zuschneiden, 600 DPI ab etwa 1400 px Breite, sonst 300 DPI – und wählt es
    gleich aus; bei zu niedriger Auflösung gibt es eine Warnung. Eigene Bilder stehen danach oben im Bildwähler
    (mit ✕ zum Löschen), liegen in `proxies/<deck>/uploads/` und sind Teil der Sicherung.
  - „Liste kopieren“ steht oben rechts; im ⋯-Menü: „Als neues Deck kopieren“, „Neu prüfen“, Export für
    Decklist als Textdatei, „Löschen“.
- **Meine Sammlung** (eigene Seite, siehe unten), **Glossar** (Schlüsselwörter, Aktionen und
  Commander-Begriffe in einem Satz, mit Suche), **Blacklist** und **Einstellungen** (Kartendatenbank,
  Proxy-Druck, KI-Hochskalierung) als eigene Seiten.
- Durchgehend Deutsch: Kategorien heißen in der Oberfläche Kartenzug, Schutz, Siegbedingung, Länder … (gespeichert
  bleiben die englischen Werte), Zahlen und Preise im deutschen Format (32,50 €, Ø Manawert 3,1).
- **Schnellsuche Strg+K** (⌘K): Decks, Seiten, Deck-Tabs, Glossar-Begriffe und Aktionen wie „Sammlung
  importieren“, „Deck per Link importieren“ oder „Partie festhalten“.
- Hell/Dunkel folgt dem Betriebssystem; bedienbar mit Tastatur (Pfeiltasten in den Tabs, Esc schließt
  Dialoge und Menüs).

## Sammelbestellungen

Mehrere Dinge auf einmal drucken – wie ein Deck, nur als Sammlung: z. B. 18 neue Karten für Aesi, 20 aus einem
anderen Deck und 50 Treasure-Tokens, zusammen in **einer** MakePlayingCards-Bestellung oder einem PDF.

- **Hinzufügen** auf der Seite „Sammelbestellungen“:
  - **Karte** (Suche mit Autovervollständigung, auch deutsche Namen) mit Anzahl;
  - **Aus einem Deck:** nur fehlende (was die Sammlung nicht abdeckt), alle oder ausgewählte Karten;
  - **Tokens:** Scryfall-Suche („Treasure“, „Zombie“ …) oder die Tokens eines Decks, „je N“ Stück;
  - **Liste / Link:** eingefügte Liste („1 Craterhoof Behemoth“) oder ein Deck-Link (Moxfield, Archidekt,
    MTGGoldfish, TappedOut, Deckstats, EDHREC).
- **Aus der Kartenansicht:** Klick auf eine Karte (oder einen Token unter „Tokens & Marker“) → „Zur
  Sammelbestellung“ neben dem Scryfall-Link, mit Anzahl.
- **Umbau bestellen:** im Deck „Mit anderem Deck vergleichen“ → den Unterschied zum alten Deck hinzufügen.
- **Von überall:** auch über das ⋯-Menü eines Decks.
- **Nach jedem Umbau** eines Decks (Karten im Bearbeiten-Modus geändert) fragt die App, ob die **neu hinzugekommenen Karten** in eine Sammelbestellung
  sollen – auf Wunsch nur die, die in der Sammlung fehlen.
- **Inhalt** gruppiert nach Herkunft (Deck, Liste, Tokens …), Anzahl änderbar, einzelne Positionen oder
  ganze Gruppen entfernen; oben stehen Karten, Tokens, Druckplätze und die MPC-Staffel (18, 36, 55, 72 …).
- **Als Moxfield-Liste:** „Als Moxfield-Liste kopieren“ oder „.txt herunterladen“ – alle Karten zusammengezählt
  („3 Sol Ring“), passend für den Import bei Moxfield, Archidekt oder ManaBox. Tokens sind nicht dabei
  (Moxfield importiert keine); die App sagt, wie viele ausgelassen wurden.
- **Drucken** wie bei einem Deck – derselbe Bereich mit Bildauswahl (MPC Autofill/Scryfall, eigene Wahl pro
  Karte), KI-Hochskalierung, Druckdateien, PDF, MakePlayingCards und „In die Sammlung übernehmen“. Tokens ohne
  gewähltes Bild bekommen das neueste passende Scryfall-Token.

## Meine Sammlung

Die Seite „Meine Sammlung“ merkt sich, welche Karten du hast (`collection.json`, lokal):

- pro Eintrag **Anzahl**, **echt oder Proxy**, Foil, Sprache und das **Artwork** (der konkrete Druck –
  über „Artwork wählen“ aus allen Scryfall-Drucken, mit Bild, Set, Nummer und Preis)
- **Import** aus ManaBox, Moxfield (inkl. Proxy-Spalte) und Archidekt als CSV oder als Liste
  („2 Sol Ring (C21) 263 *F*“, „1 Demonic Tutor [proxy]“); **Export** als CSV
- Suche, Filter echt/Proxy, Sortierung, Liste oder Bilder, Anzahl ±, Proxy/Foil umschalten, in welchen
  Decks eine Karte steckt
- **Im Deck:** ✓ = hast du, P = als Proxy, „2/3“ = teilweise; Panel „Sammlung“ mit „X von 100 vorhanden“,
  Preis der fehlenden Karten, **Einkaufsliste** (für Cardmarket-Wants) und Warnung, wenn mehrere Decks
  dieselbe Karte brauchen, du aber zu wenige hast. Basic Lands zählen als vorhanden.
- **Beim Drucken:** „Nur fehlende Karten“ druckt nur, was dir fehlt; danach trägt „Zur Sammlung
  hinzufügen“ die gedruckten Proxies samt Artwork ein.

## Datenquellen & Zugänge

Für keine der Quellen ist ein API-Key oder Account nötig.

| Quelle | Zugang | Wofür |
|---|---|---|
| **Scryfall API** | offizielle REST-API, kein Key (User-Agent + Rate-Limits werden eingehalten) | Kartensuche, Preise, Legalität, Game Changer, Autocomplete |
| **Scryfall Bulk Data** | tägliche `jsonl.gz`-Exporte über `/bulk-data` | lokale DB: **All Cards** (alle Drucke, alle Sprachen) + **Oracle Tags** (Tagger) |
| **EDHREC** | öffentliche JSON-Dateien (`json.edhrec.com`), inoffiziell | Empfehlungen, Synergie, Themen, Average Deck – auch gefiltert nach Bracket und Budget |
| **Commander Spellbook** | offizielle Backend-API, kein Key | Combos im Deck / fast im Deck, Bracket-Schätzung |
| **Archidekt** | öffentliche Deck-API, kein Key | Decks importieren (inkl. Kategorien) |
| **Moxfield** | *keine* öffentliche API (Cloudflare, User-Agent-Whitelist) | Import nur „best effort“ – sonst Text-Export einfügen |
| **MTGGoldfish / TappedOut / Deckstats** | öffentliche Text-Exporte der Deckseiten | Decks importieren |
| **MTGJSON** | öffentliche JSON-Dateien (`DeckList.json`, `decks/<Datei>.json`), kein Key | Starterdecks (Precons) |

Alle Anfragen werden 24 h auf der Platte gecacht (`~/.cache/mtgdeck`).

### Lokale Kartendatenbank (Scryfall Bulk Data)

Der Button unter „Einstellungen → Kartendatenbank“ lädt die Scryfall-Bulk-Files und baut daraus
`~/.cache/mtgdeck/cards.sqlite`:

- **All Cards** (≈ 375 MB komprimiert, Standard): wird zu einer Zeile pro Oracle-ID zusammengefasst.
  Dadurch werden **Kartennamen in allen Sprachen** erkannt und als Preis gilt der
  **günstigste Papier-Druck** – gut für Budget-Decks. Preise sind bis zu ~24 h alt (Schätzwert).
- **Oracle Tags** (Scryfall Tagger): Kartenrollen wie `ramp`, `draw`, `removal`, `sweeper`, `tutor`
  inkl. Tag-Hierarchie – deutlich bessere Rollenerkennung als Textmuster.
- Aktualisierung höchstens wöchentlich (Spieldaten ändern sich selten), außer du erzwingst sie.
- Ohne lokale DB funktioniert alles weiterhin über die Live-API (langsamer, nur englische Namen).

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `MTG_BULK_TYPE` | `all_cards` | `oracle_cards` (≈ 25 MB, schneller, nur Englisch) oder `default_cards` |
| `MTG_BULK_MAX_AGE_DAYS` | `7` | ab wann die lokale DB als veraltet gilt |
| `MTG_DATA_DIR` / `MTG_CACHE_DIR` | `~/.cache/mtgdeck` | Speicherort DB / HTTP-Cache |
| `MTG_CACHE_TTL` | `86400` | HTTP-Cache-Dauer in Sekunden |
| `MTG_HOME` | Projektordner (Desktop-App: `%APPDATA%\MTG Deckbuilder`) | alle Nutzerdaten: Decks, Sammlung, Blacklist, Tischregeln, Sicherungen, Proxies, Einstellungen, Sync-Stand |
| `MTG_CACHE_HOME` | `~/.cache/mtgdeck` (Desktop-App: `%LOCALAPPDATA%\app.mtgdeck.desktop\cache`) | Kartendatenbank und HTTP-Cache |
| `MTG_GUI_TOKEN` | – | Zugriffstoken der Oberfläche (setzt die Desktop-App; ohne Token ist die Oberfläche für diesen Rechner offen) |
| `MTG_DECKS_DIR` | `./decks` | Speicherort der Decks |
| `MTG_BLACKLIST_FILE` | `./blacklist.txt` | Blacklist-Datei |
| `MTG_TABLERULES_FILE` | `./tablerules.json` | Tischregeln |
| `MTG_BACKUP_DIR` | `./backups` | Sicherungen (ZIP) |
| `MTG_COLLECTION_FILE` | `./collection.json` | deine Sammlung |
| `MTG_PROXIES_DIR` | `./proxies` | Druckdateien (XML, Bilder-Verweise, PDF) |
| `MTG_SYNC_DIR` | `./.sync` | Sync-Zustand dieses Geräts (Verbindung, Stand, Basisdateien, Konfliktprotokoll) |
| `MTG_SYNC_AUTO` | `1` | `0` = kein automatischer Abgleich im Hintergrund (nur per Knopf) |
| `MTG_SYNC_DATA` / `MTG_SYNC_PUBLIC_URL` / `MTG_SYNC_HOST` / `MTG_SYNC_PORT` | `./sync-data` / – / `0.0.0.0` / `8080` | nur der Sync-Server (`mtg-sync-server`) |
| `MTG_AI_KEY` / `MTG_AI_MODEL` / `MTG_AI_URL` | – / `claude-haiku-5-5` / `https://api.anthropic.com/v1` | Sync-Server: Claude-API-Schlüssel und Modell für die Kartensuche mit KI im Handy (sonst in der Handy-App einstellbar); die Adresse nur für Tests |
| `MTG_AUTOFILL_PATH` / `MTG_MPCFILL_SERVER` / `MTG_CARDBACK` / `MTG_UPSCALER_PATH` | – | überschreiben die Proxy-Einstellungen (`mtgdeck.settings.json`) |
| `MTG_GUI_HOST` / `MTG_GUI_PORT` | `127.0.0.1` / `8765` | GUI-Adresse |

## Grenzen

- EDHREC hat keine offizielle API; ändert sich das JSON-Format, liefern die EDHREC-Funktionen Fehler, der Rest funktioniert weiter.
- Die Bracket-Prüfung deckt die harten Regeln ab (Game Changer, MLD, Extra Turns, 2-Karten-Combos).
  „Wie schnell/konsistent ist das Deck?“ bleibt eine Einschätzung (Power-Score).
- Die Rollen-Zählung (Ramp, Draw, Removal …) ist heuristisch (Tagger-Tags bzw. Textmuster) – das gilt auch
  für den Deck-Check.
- Moxfield, MTGGoldfish, TappedOut, Deckstats und MTGJSON bieten keine offiziell dokumentierte Deck-API;
  ändern sie ihre Exporte, schlägt der Link-Import fehl – eine eingefügte Liste geht immer.
- Deutsche Kartentexte gibt es nur für Karten mit deutscher Ausgabe (sonst der englische Oracle-Text); bei
  alten Drucken kann der gedruckte Text vom aktuellen Oracle-Text abweichen.

## Entwicklung

```bash
uv sync --all-extras
uv run pytest          # läuft komplett offline (HTTP wird gemockt)
```

Struktur: `src/mtgdeck/` (Python-Paket), `desktop/` (Desktop-App), `deploy/sync/` (Sync-Server), `tests/`.
