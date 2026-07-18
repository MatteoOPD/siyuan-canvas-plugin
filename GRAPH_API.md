# Canvas Graph API

Dateien liegen über die SiYuan-Datei-API unter `/data/storage/petal/siyuan-canvas/<canvasId>.json` (`index.json` enthält die Liste). `schemaVersion` ist `1`.

```json
{"canvasId":"canvas-1720000000000","name":"Recherche","schemaVersion":1,"nodes":[{"id":"g1","type":"group","label":"Themen","color":"blue","x":40,"y":40,"width":760,"height":360},{"id":"n1","type":"document","docId":"20240101000000-abcdefg","x":80,"y":100,"width":300,"height":180},{"id":"n2","type":"text","markdown":"Gedanke","color":"#dfb34f","x":450,"y":100,"width":260,"height":140},{"id":"n3","type":"shape","shape":"diamond","label":"Entscheidung","color":"blue","x":760,"y":100,"width":280,"height":180},{"id":"n4","type":"canvas","canvasRefId":"canvas-1720000000100","label":"Details","x":1080,"y":100,"width":390,"height":270},{"id":"n5","type":"link","url":"https://example.org/report.pdf","label":"Report","x":1080,"y":410,"width":420,"height":300}],"edges":[{"id":"e1","source":"n1","target":"n2","label":"führt zu","color":"purple","style":"orthogonal","directed":true}]}
```

Das Format bleibt bewusst maschinenlesbar. Eine spätere API- oder MCP-Anbindung kann ausschließlich dieses JSON ändern; sie ist nicht Teil des Plugins.

`color` ist bei Knoten und Kanten optional und kann `default`, `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `pink`, `purple` oder ein Hex-Wert wie `#dfb34f` sein. Ohne Feld wird `default` verwendet. Gruppen verwenden Typ `group` und speichern ihren sichtbaren Namen in `label`. Formen verwenden Typ `shape`, `shape` ist `rectangle`, `ellipse` oder `diamond`. Canvas-Referenzen verwenden Typ `canvas` und `canvasRefId`; das Zielgraph-JSON wird nicht eingebettet. Web-/Medienkarten verwenden Typ `link` und speichern `url` sowie optional `label`. Kanten speichern in `style` optional `bezier`, `straight` oder `orthogonal`.
