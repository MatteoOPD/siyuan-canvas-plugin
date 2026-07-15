# SiYuan Canvas

Ein schlankes SiYuan-Canvas: Referenzkarten zeigen immer aktuellen SiYuan-Inhalt; gespeichert werden nur Graph, freie Textkarten und Pfeile.

```bash
npm install
npm run build
```

Kopiere `dist/`, `plugin.json` und diese README nach `data/plugins/siyuan-canvas/`, oder verlinke den Projektordner für die Entwicklung.

- Toolbar-Symbol: neuen oder gespeicherten Canvas öffnen.
- `+ Referenz`: ID eingeben oder SiYuan durchsuchen; Drop akzeptiert SiYuan-ID/URL.
- `Verbinden`: Quelle und Ziel anklicken; Beschriftung ist optional.
- Rechter Bereich: Textkarten bearbeiten oder die Originalquelle einer Referenzkarte speichern.
- `Canvas speichern` schreibt explizit; zusätzlich erfolgt ein Debounce-Autosave.

Details des JSON-Vertrags: [GRAPH_API.md](GRAPH_API.md).
