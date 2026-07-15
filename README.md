# SiYuan Canvas

Ein visueller Canvas für SiYuan-Dokumente, Blöcke und freie Textkarten. Referenzkarten verwenden den nativen SiYuan-Editor direkt im Canvas; Änderungen landen damit unmittelbar in der Originalquelle.

## Bedienung

- `+ Referenz`: Dokument oder Block per ID/Suche hinzufügen; SiYuan-IDs können auch auf die Fläche gezogen werden.
- `+ Text`: freie, nur im Canvas gespeicherte Textkarte erstellen.
- Karten am Kopf verschieben und an der rechten unteren Ecke skalieren.
- Dokumente und Blöcke direkt in der Karte wie in SiYuan bearbeiten.
- `Verbinden` wählen und anschließend Quell- und Zielkarte anklicken. Alternativ einen sichtbaren Anschluss-Punkt anklicken.
- Kante doppelt anklicken, um ihre Beschriftung zu ändern; Kante auswählen und mit `Entf` löschen.
- Mausrad zoomt zum Mauszeiger; Ziehen auf freier Fläche verschiebt den Canvas.

Der Canvas speichert nur Layout, Textkarten und Verbindungen. SiYuan bleibt für Dokument- und Blockinhalte die Quelle der Wahrheit.

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
