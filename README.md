# SiYuan Canvas

Ein visueller Canvas für SiYuan-Dokumente, Blöcke und freie Textkarten. Referenzkarten verwenden den nativen SiYuan-Editor direkt im Canvas; Änderungen landen damit unmittelbar in der Originalquelle.

## Bedienung

- Der Toolbar-Button öffnet eine Canvas-Verwaltung zum Erstellen, Öffnen, Umbenennen und dauerhaften Löschen alter Canvas-Dateien.
- Jeder Canvas erhält beim Anlegen einen Namen; der Name kann oben in der Werkzeugleiste geändert werden.
- `+ Referenz`: Öffnet eine integrierte Suche für Dokumente und Blöcke (Tastatur: Pfeile und Enter).
- Dokumentkarten sind blau mit Seitensymbol, Blockkarten violett mit Absatzsymbol gekennzeichnet.
- Dokumente aus dem Dateibaum und einzelne Blöcke lassen sich direkt auf die Fläche ziehen; auch mehrere IDs in einem Drop werden übernommen.
- `+ Text`: freie, nur im Canvas gespeicherte Textkarte erstellen.
- `Canvas`: einen anderen Canvas als interaktive Karte einbetten. Karten, Gruppen, Pfeile und Pfeiltexte des Ziel-Canvas bleiben sichtbar; in der Vorschau lässt sich zoomen, verschieben und eine Karte auswählen. Ein Doppelklick öffnet je nach Kartentyp die SiYuan-Quelle, den Link oder den zugehörigen Canvas. Direkte Selbstreferenzen werden verhindert.
- `Web/Media`: Webseiten, Bilder, Audio, Video oder PDFs über eine HTTP-/HTTPS-Adresse einbetten. URLs und normaler Text können außerdem direkt eingefügt oder auf den Canvas gezogen werden.
- `Form`: Rechteck, Ellipse oder Raute mit frei editierbarer Beschriftung erstellen.
- Karten am Kopf verschieben und an der rechten unteren Ecke skalieren.
- Auf freier Fläche ziehen erstellt eine Lasso-Auswahl; `Shift` ergänzt Karten, `Strg+A` wählt alle Karten.
- Mehrere ausgewählte Karten lassen sich gemeinsam bewegen, mit Preset- oder eigener Farbe versehen, duplizieren, löschen, horizontal und vertikal ausrichten oder verteilen sowie gruppieren. Die schwebende Leiste erscheint direkt über der Auswahl.
- Verschieben rastet am Punktraster ein. `Alt` umgeht das Raster, `Shift` beschränkt die Bewegung auf eine Achse.
- `Strg+Z` und `Strg+Umschalt+Z` machen Canvas-Änderungen rückgängig beziehungsweise wiederholen sie.
- `Strg+D` dupliziert die Auswahl. Eingefügter Text erzeugt eine Textkarte, eine eingefügte URL eine Web-/Medienkarte.
- Dokumente und Blöcke direkt in der Karte wie in SiYuan bearbeiten.
- Über einer Karte scrollt das Mausrad deren Inhalt; `Strg`/`Cmd` + Mausrad zoomt weiterhin den Canvas.
- Zum Verbinden einen Anschluss-Punkt am Kartenrand auf die Zielkarte ziehen. `Verbinden` blendet die Punkte dauerhaft ein.
- Ausgewählte Karten und Pfeile erhalten ihre Farbe über eine sichtbare Palette.
- Gruppen bilden beschriftete Bereiche; beim Verschieben einer Gruppe bewegen sich enthaltene Karten mit.
- Ausgewählte Karten lassen sich duplizieren; ein Doppelklick auf freie Fläche erstellt eine Textkarte.
- `⛶` passt alle Karten ein, `▣` zoomt auf die aktuelle Karte beziehungsweise Verbindung (`Shift+1`/`Shift+2`).
- Pfeil anklicken und `Pfeil` wählen (oder doppelt anklicken), um Quelle, Ziel, Beschriftung und Linienform – gebogen, gerade oder rechtwinklig – zu ändern. Mit `Entf` wird der ausgewählte Pfeil gelöscht.
- Mausrad zoomt zum Mauszeiger; `Leertaste` + Ziehen oder die mittlere Maustaste verschiebt den Canvas.

Der Canvas speichert nur Layout, Textkarten, externe Adressen, Canvas-Referenzen und Verbindungen. SiYuan bleibt für Dokument- und Blockinhalte die Quelle der Wahrheit. Verschachtelte Canvas werden nicht kopiert oder rekursiv geladen.

## Datenspeicher

Die Graph-Dateien liegen über die SiYuan-Datei-API unter `/data/storage/petal/siyuan-canvas/`. Jeder Canvas besitzt dort eine `<canvasId>.json`; `index.json` enthält die Liste der vorhandenen Canvas-Dateien. Im Docker-Container entspricht das dem Pfad `/siyuan/workspace/data/storage/petal/siyuan-canvas/` und liegt damit im bestehenden SiYuan-Volume.

Gespeichert werden Canvas-Name, Position, Größe und Farbe der Karten, freie Textkarten, Formen, Web-Adressen, Canvas-Referenzen sowie Verbindungen, Pfeiltexte und Linienformen. Inhalte referenzierter Dokumente und Blöcke werden nicht kopiert, sondern weiterhin direkt aus SiYuan geladen und dort bearbeitet.

## Bewusste Grenzen

Version 1.0 deckt den vollständigen Desktop-Kern für visuelles Arbeiten ab. Nicht enthalten sind Echtzeit-Kollaboration, eigene Sync-/Offline-Logik, KI-Layout, vollwertige Zeichenwerkzeuge, Bildbearbeitung und mobile Bearbeitung. Diese Bereiche würden das schlanke Plugin zu einer separaten Whiteboard-Anwendung machen.

## EasyPanel: separater Canvas-Installer

Der vorhandene SiYuan-Compose bleibt unverändert. Lege in EasyPanel einen zweiten Compose-Service für den Canvas an und verwende dafür [docker-compose.easypanel.yml](docker-compose.easypanel.yml).

Der Installer bindet das bestehende Volume `prod_siyuan_siyuan_data` als externes Volume ein und prüft dauerhaft `releases/latest`. Eine neue Version wird automatisch in das Volume kopiert. Sobald das Installer-Log die neue Version meldet, genügt ein Neustart des bestehenden SiYuan-Service; ein manueller `docker run` ist nicht mehr nötig.

Falls dein EasyPanel-Projekt einen anderen Docker-Volumenamen verwendet, passe ausschließlich `volumes.siyuan_data.name` an.

## Entwicklung

```bash
npm install
npm run build
npm run package
```

`package.zip` enthält die direkt installierbaren Plugin-Dateien.

Details des JSON-Vertrags: [GRAPH_API.md](GRAPH_API.md).
