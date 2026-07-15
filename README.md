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

## Entwicklung

```bash
npm install
npm run build
npm run package
```

`package.zip` enthält die direkt installierbaren Plugin-Dateien. Das EasyPanel-Beispiel unter [docker-compose.easypanel.yml](docker-compose.easypanel.yml) lädt die Release-ZIP automatisch in das persistente SiYuan-Volume.

Details des JSON-Vertrags: [GRAPH_API.md](GRAPH_API.md).
