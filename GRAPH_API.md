# Canvas Graph API

Dateien liegen über die SiYuan-Datei-API unter `/data/storage/petal/siyuan-canvas/<canvasId>.json` (`index.json` enthält die Liste). `schemaVersion` ist `1`.

```json
{"canvasId":"canvas-1720000000000","schemaVersion":1,"nodes":[{"id":"n1","type":"document","docId":"20240101000000-abcdefg","x":80,"y":100,"width":300,"height":180},{"id":"n2","type":"text","markdown":"Gedanke","color":"yellow","x":450,"y":100,"width":260,"height":140}],"edges":[{"id":"e1","source":"n1","target":"n2","label":"führt zu","directed":true}]}
```

Vorgesehene MCP-Operationen: `get_canvas`, `upsert_node`, `remove_node`, `upsert_edge`, `remove_edge`. Sie lesen bzw. ändern ausschließlich dieses JSON; Referenzkarten enthalten keine Inhaltskopie.

`color` ist optional und kann `default`, `yellow`, `green`, `blue`, `pink` oder `purple` sein. Ohne Feld wird `default` verwendet.
