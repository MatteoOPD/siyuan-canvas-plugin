# SiYuan Canvas

Ein visueller Canvas für SiYuan-Dokumente, Blöcke und freie Textkarten. Referenzkarten verwenden den nativen SiYuan-Editor direkt im Canvas; Änderungen landen damit unmittelbar in der Originalquelle.

## Bedienung

- `+ Referenz`: Öffnet eine integrierte Suche für Dokumente und Blöcke (Tastatur: Pfeile und Enter).
- Dokumente aus dem Dateibaum und einzelne Blöcke lassen sich direkt auf die Fläche ziehen; auch mehrere IDs in einem Drop werden übernommen.
- `+ Text`: freie, nur im Canvas gespeicherte Textkarte erstellen.
- Karten am Kopf verschieben und an der rechten unteren Ecke skalieren.
- Dokumente und Blöcke direkt in der Karte wie in SiYuan bearbeiten.
- Über einer Karte scrollt das Mausrad deren Inhalt; `Strg`/`Cmd` + Mausrad zoomt weiterhin den Canvas.
- Zum Verbinden einen Anschluss-Punkt am Kartenrand auf die Zielkarte ziehen. `Verbinden` blendet die Punkte dauerhaft ein.
- Ausgewählte Karten lassen sich duplizieren und durch mehrere Whiteboard-Farben schalten.
- `⛶` passt alle Karten in die sichtbare Arbeitsfläche ein.
- Kante doppelt anklicken, um ihre Beschriftung zu ändern; Kante auswählen und mit `Entf` löschen.
- Mausrad zoomt zum Mauszeiger; Ziehen auf freier Fläche verschiebt den Canvas.

Der Canvas speichert nur Layout, Textkarten und Verbindungen. SiYuan bleibt für Dokument- und Blockinhalte die Quelle der Wahrheit.

## Datenspeicher

Die Graph-Dateien liegen über die SiYuan-Datei-API unter `/data/storage/petal/siyuan-canvas/`. Jeder Canvas besitzt dort eine `<canvasId>.json`; `index.json` enthält die Liste der vorhandenen Canvas-Dateien. Im Docker-Container entspricht das dem Pfad `/siyuan/workspace/data/storage/petal/siyuan-canvas/` und liegt damit im bestehenden SiYuan-Volume.

Gespeichert werden Position, Größe und Farbe der Karten, freie Textkarten sowie Verbindungen und Pfeiltexte. Inhalte referenzierter Dokumente und Blöcke werden nicht kopiert, sondern weiterhin direkt aus SiYuan geladen und dort bearbeitet.

## EasyPanel: separater Canvas-Installer

Der vorhandene SiYuan-Compose bleibt unverändert. Lege in EasyPanel einen zweiten Compose-Service für den Canvas an und verwende dafür [docker-compose.easypanel.yml](docker-compose.easypanel.yml).

Der Installer bindet das bestehende Volume `prod_siyuan_siyuan_data` als externes Volume ein, lädt die Release-ZIP hinein und beendet sich anschließend erfolgreich. Nach einem Canvas-Deploy muss nur der bestehende SiYuan-Service einmal über EasyPanel neu gestartet werden. Ein manueller `docker run` ist nicht mehr nötig.

Falls dein EasyPanel-Projekt einen anderen Docker-Volumenamen verwendet, passe ausschließlich `volumes.siyuan_data.name` an.

## Entwicklung

```bash
npm install
npm run build
npm run package
```

`package.zip` enthält die direkt installierbaren Plugin-Dateien.

Details des JSON-Vertrags: [GRAPH_API.md](GRAPH_API.md).
