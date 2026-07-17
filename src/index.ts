import { App, Plugin, Protyle, openTab, showMessage } from "siyuan";
import {
  BrowserJsPlumbInstance,
  Connection,
  EVENT_CONNECTION,
  EVENT_CONNECTION_DETACHED,
  INTERCEPT_BEFORE_DROP,
  newInstance,
} from "@jsplumb/browser-ui";
import "./index.css";

type NodeKind = "document" | "block" | "text";
type CardColor = "default" | "yellow" | "green" | "blue" | "pink" | "purple";

interface CanvasNode {
  id: string;
  type: NodeKind;
  docId?: string;
  blockId?: string;
  markdown?: string;
  color?: CardColor;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  directed: true;
}

interface CanvasGraph {
  canvasId: string;
  schemaVersion: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasIndexEntry {
  id: string;
  updatedAt: string;
}

interface Point {
  x: number;
  y: number;
}

interface ReferenceResult {
  id: string;
  type: "document" | "block";
  content: string;
  hpath?: string;
}

type Interaction =
  | { type: "pan"; startX: number; startY: number }
  | { type: "move"; nodeId: string; startX: number; startY: number; originX: number; originY: number }
  | { type: "resize"; nodeId: string; startX: number; startY: number; width: number; height: number };

const STORAGE_ROOT = "/data/storage/petal/siyuan-canvas";
const SIYUAN_ID = /^[0-9]{14}-[a-z0-9]{7}$/;
const SIYUAN_ID_GLOBAL = /[0-9]{14}-[a-z0-9]{7}/g;
const CARD_COLORS: CardColor[] = ["default", "yellow", "green", "blue", "pink", "purple"];

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const emptyGraph = (canvasId: string): CanvasGraph => ({
  canvasId,
  schemaVersion: 1,
  nodes: [],
  edges: [],
});

async function kernel<T>(path: string, data: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(result.msg || `Kernel-Aufruf fehlgeschlagen: ${path}`);
  }
  return result.data as T;
}

async function readJson<T>(path: string): Promise<T | null> {
  const response = await fetch("/api/file/getFile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (response.status === 202) return null;
  if (!response.ok) throw new Error(`Datei konnte nicht geladen werden: ${path}`);
  return JSON.parse(await response.text()) as T;
}

async function putJson(path: string, value: unknown): Promise<void> {
  const form = new FormData();
  form.append("path", path);
  form.append(
    "file",
    new File([JSON.stringify(value, null, 2)], path.split("/").pop()!, {
      type: "application/json",
    }),
  );
  const response = await fetch("/api/file/putFile", { method: "POST", body: form });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(result.msg || "Canvas konnte nicht gespeichert werden");
  }
}

let storageReady = false;

async function ensureStorage(): Promise<void> {
  if (storageReady) return;
  const form = new FormData();
  form.append("path", STORAGE_ROOT);
  form.append("isDir", "true");
  const response = await fetch("/api/file/putFile", { method: "POST", body: form });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(result.msg || "Canvas-Speicher konnte nicht angelegt werden");
  }
  storageReady = true;
}

class GraphStore {
  load(id: string) {
    return readJson<CanvasGraph>(`${STORAGE_ROOT}/${id}.json`);
  }

  async list() {
    return (await readJson<CanvasIndexEntry[]>(`${STORAGE_ROOT}/index.json`)) || [];
  }

  async save(graph: CanvasGraph) {
    await ensureStorage();
    await putJson(`${STORAGE_ROOT}/${graph.canvasId}.json`, graph);
    const previous = await this.list();
    const entry = { id: graph.canvasId, updatedAt: new Date().toISOString() };
    await putJson(`${STORAGE_ROOT}/index.json`, [
      entry,
      ...previous.filter((item) => item.id !== graph.canvasId),
    ]);
  }
}

function referenceId(node: CanvasNode): string | undefined {
  return node.type === "document" ? node.docId : node.blockId;
}

async function getReferenceTitle(node: CanvasNode): Promise<string> {
  const id = referenceId(node);
  if (!id) return node.type === "document" ? "Dokument" : "Block";
  const rows = await kernel<Array<{ content?: string }>>("/api/query/sql", {
    stmt: `SELECT content FROM blocks WHERE id = '${id}' LIMIT 1`,
  });
  return rows[0]?.content || (node.type === "document" ? "Dokument" : "Block");
}

async function searchReferences(input: string): Promise<ReferenceResult[]> {
  const query = input.trim();
  const statement = !query
    ? `SELECT id, type, content, hpath FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT 20`
    : SIYUAN_ID.test(query)
    ? `SELECT id, type, content FROM blocks WHERE id = '${query}' LIMIT 1`
    : `SELECT id, type, content, hpath FROM blocks WHERE content LIKE '%${query.replace(/'/g, "''")}%' ORDER BY CASE WHEN type = 'd' THEN 0 ELSE 1 END, updated DESC LIMIT 24`;
  const rows = await kernel<Array<{ id: string; type: string; content?: string; hpath?: string }>>(
    "/api/query/sql",
    { stmt: statement },
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type === "d" ? "document" : "block",
    content: row.content || row.id,
    hpath: row.hpath,
  }));
}

function droppedSiYuanIds(transfer: DataTransfer | null): string[] {
  if (!transfer) return [];
  const values = new Set<string>();
  const candidates = [transfer.getData("application/siyuan-file")];
  for (const type of Array.from(transfer.types)) {
    candidates.push(type);
    try {
      candidates.push(transfer.getData(type));
    } catch {
      // Some browsers expose a type but disallow reading its data.
    }
  }
  candidates.push(transfer.getData("text/plain"), transfer.getData("text/html"));
  for (const candidate of candidates) {
    for (const id of candidate.match(SIYUAN_ID_GLOBAL) || []) values.add(id);
  }
  return [...values];
}

class CanvasView {
  private graph: CanvasGraph;
  private scale = 0.9;
  private pan: Point = { x: 80, y: 60 };
  private selectedNode?: string;
  private selectedEdge?: string;
  private linkMode = false;
  private interaction?: Interaction;
  private saveTimer?: number;
  private searchTimer?: number;
  private searchIndex = 0;
  private protyles = new Map<string, Protyle>();
  private plumbing?: BrowserJsPlumbInstance;
  private connections = new Map<string, Connection>();
  private syncingConnections = false;

  constructor(
    private app: App,
    private element: HTMLElement,
    private canvasId: string,
    private store: GraphStore,
  ) {
    this.graph = emptyGraph(canvasId);
  }

  async init() {
    this.mount();
    try {
      this.graph = (await this.store.load(this.canvasId)) || emptyGraph(this.canvasId);
    } catch (error) {
      showMessage(`Canvas-Speicher nicht erreichbar: ${String(error)}`);
    }
    this.setupConnections();
    this.bindGlobalEvents();
    await this.renderNodes();
    this.updateTransform();
    this.updateEmptyState();
  }

  private mount() {
    this.element.classList.add("syc-root");
    this.element.innerHTML = `
      <div class="syc-toolbar">
        <div class="syc-toolbar__group">
          <button class="syc-button syc-button--primary" data-action="reference">＋ Referenz</button>
          <button class="syc-button" data-action="text">＋ Text</button>
          <button class="syc-button" data-action="link">↗ Verbinden</button>
          <button class="syc-button" data-action="duplicate" data-requires-node disabled>⧉ Duplizieren</button>
          <button class="syc-button" data-action="color" data-requires-node disabled>● Farbe</button>
          <button class="syc-button syc-button--danger" data-action="delete" disabled>⌫ Löschen</button>
        </div>
        <div class="syc-toolbar__status" data-role="status">Bereit</div>
        <div class="syc-toolbar__group syc-toolbar__group--right">
          <button class="syc-icon-button" data-action="fit" title="Alle Karten einpassen">⛶</button>
          <button class="syc-icon-button" data-action="zoom-out" title="Verkleinern">−</button>
          <button class="syc-zoom" data-action="zoom-reset" title="Zoom zurücksetzen">90%</button>
          <button class="syc-icon-button" data-action="zoom-in" title="Vergrößern">＋</button>
          <button class="syc-button" data-action="save">Speichern</button>
        </div>
      </div>
      <div class="syc-viewport">
        <div class="syc-world"></div>
        <div class="syc-empty">
          <div class="syc-empty__icon">◇</div>
          <strong>Dein Canvas ist noch leer</strong>
          <span>Füge eine SiYuan-Seite, einen Block oder eine Textkarte hinzu.</span>
          <div><button class="syc-button syc-button--primary" data-action="reference">＋ Referenz</button><button class="syc-button" data-action="text">＋ Text</button></div>
        </div>
      </div>
      <div class="syc-dialog-backdrop is-hidden" data-role="search-dialog">
        <section class="syc-dialog" role="dialog" aria-modal="true" aria-label="SiYuan-Referenz hinzufügen">
          <header class="syc-dialog__header"><strong>Referenz hinzufügen</strong><button class="syc-dialog__close" data-action="close-search" title="Schließen">×</button></header>
          <input class="syc-search" data-role="search-input" type="search" placeholder="Dokument oder Block suchen …" autocomplete="off">
          <div class="syc-search-results" data-role="search-results"></div>
          <footer class="syc-dialog__footer">↑↓ auswählen · Enter hinzufügen · Esc schließen</footer>
        </section>
      </div>
      <div class="syc-dialog-backdrop is-hidden" data-role="edge-dialog">
        <form class="syc-dialog syc-dialog--small" data-role="edge-form">
          <header class="syc-dialog__header"><strong>Pfeil beschriften</strong><button type="button" class="syc-dialog__close" data-action="close-edge">×</button></header>
          <input class="syc-search" data-role="edge-label" maxlength="80" placeholder="Beschriftung (optional)">
          <div class="syc-dialog__actions"><button type="button" class="syc-button" data-action="close-edge">Abbrechen</button><button class="syc-button syc-button--primary" type="submit">Übernehmen</button></div>
        </form>
      </div>`;
  }

  private setupConnections() {
    this.plumbing = newInstance({
      container: this.world(),
      elementsDraggable: false,
      connector: { type: "Bezier", options: { curviness: 72 } },
      paintStyle: { stroke: "var(--b3-theme-primary)", strokeWidth: 2 },
      hoverPaintStyle: { stroke: "var(--b3-theme-primary)", strokeWidth: 3 },
      endpoint: { type: "Dot", options: { radius: 4 } },
      endpointStyle: { fill: "var(--b3-theme-primary)" },
      connectionOverlays: [{ type: "Arrow", options: { location: 1, width: 11, length: 11 } }],
      connectionsDetachable: true,
    });
    this.plumbing.addSourceSelector(".syc-port", {
      anchor: "Continuous",
      maxConnections: -1,
      uniqueEndpoint: true,
    });
    this.plumbing.addTargetSelector(".syc-card__header, .syc-card__body, .syc-card__footer", {
      anchor: "Continuous",
      maxConnections: -1,
    });
    this.plumbing.bind(INTERCEPT_BEFORE_DROP, (info: any) => info.sourceId !== info.targetId);
    this.plumbing.bind(EVENT_CONNECTION, (info: any) => this.onConnectionCreated(info));
    this.plumbing.bind(EVENT_CONNECTION_DETACHED, (info: any) => this.onConnectionDetached(info.connection));
    this.plumbing.bind("click", (connection: Connection) => {
      const edgeId = connection.getParameter("edgeId") as string;
      if (edgeId) this.selectEdge(edgeId);
    });
    this.plumbing.bind("dblclick", (connection: Connection) => {
      const edgeId = connection.getParameter("edgeId") as string;
      if (edgeId) this.openEdgeDialog(edgeId);
    });
  }

  private bindGlobalEvents() {
    const viewport = this.viewport();
    this.element.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action) void this.handleAction(action);
    });

    viewport.addEventListener(
      "wheel",
      (event) => {
        const insideCardContent = (event.target as Element).closest(".syc-card__body");
        if (insideCardContent && !event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        this.setScale(this.scale * (event.deltaY < 0 ? 1.1 : 0.9), { x: pointerX, y: pointerY });
      },
      { passive: false },
    );

    viewport.addEventListener("pointerdown", (event) => {
      if (event.target === viewport || event.target === this.world()) {
        this.clearSelection();
        this.interaction = {
          type: "pan",
          startX: event.clientX - this.pan.x,
          startY: event.clientY - this.pan.y,
        };
        viewport.setPointerCapture(event.pointerId);
      }
    });

    viewport.addEventListener("pointermove", (event) => this.onPointerMove(event));
    viewport.addEventListener("pointerup", (event) => {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (this.interaction?.type === "move" || this.interaction?.type === "resize") {
        this.queueSave();
      }
      this.interaction = undefined;
    });

    viewport.addEventListener("dragover", (event) => event.preventDefault());
    viewport.addEventListener("drop", (event) => {
      event.preventDefault();
      const ids = droppedSiYuanIds(event.dataTransfer);
      if (!ids.length) {
        showMessage("Der Drop enthält keine erkennbare SiYuan-ID.");
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const origin = this.toWorld(event.clientX - rect.left, event.clientY - rect.top);
      void Promise.all(ids.map((id, index) => this.addReferenceById(id, {
        x: origin.x + index * 32,
        y: origin.y + index * 32,
      })));
    });

    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.closeSearch();
        this.closeEdgeDialog();
        this.cancelLinkMode();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLInputElement)) {
        void this.handleAction("delete");
      }
    });
    const input = this.element.querySelector<HTMLInputElement>("[data-role='search-input']")!;
    input.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void this.renderSearchResults(input.value), 180);
    });
    input.addEventListener("keydown", (event) => this.onSearchKeydown(event));
    this.element.querySelector<HTMLFormElement>("[data-role='edge-form']")!.addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveEdgeLabel();
    });
    this.element.querySelectorAll<HTMLElement>(".syc-dialog-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) {
          this.closeSearch();
          this.closeEdgeDialog();
        }
      });
    });
    new ResizeObserver(() => this.plumbing?.repaintEverything()).observe(viewport);
  }

  private async handleAction(action: string) {
    if (action === "reference") {
      this.openSearch();
    } else if (action === "text") {
      this.addTextNode();
    } else if (action === "link") {
      this.toggleLinkMode();
    } else if (action === "duplicate") {
      await this.duplicateSelectedNode();
    } else if (action === "color") {
      this.cycleSelectedColor();
    } else if (action === "fit") {
      this.fitToContent();
    } else if (action === "close-search") {
      this.closeSearch();
    } else if (action === "close-edge") {
      this.closeEdgeDialog();
    } else if (action === "delete") {
      this.deleteSelection();
    } else if (action === "save") {
      await this.save(true);
    } else if (action === "zoom-in") {
      this.setScale(this.scale * 1.1);
    } else if (action === "zoom-out") {
      this.setScale(this.scale * 0.9);
    } else if (action === "zoom-reset") {
      this.scale = 1;
      this.updateTransform();
    }
  }

  private onPointerMove(event: PointerEvent) {
    if (!this.interaction) return;
    if (this.interaction.type === "pan") {
      this.pan.x = event.clientX - this.interaction.startX;
      this.pan.y = event.clientY - this.interaction.startY;
      this.updateTransform();
      return;
    }

    const node = this.graph.nodes.find((item) => item.id === this.interaction!.nodeId);
    if (!node) return;
    if (this.interaction.type === "move") {
      node.x = this.interaction.originX + (event.clientX - this.interaction.startX) / this.scale;
      node.y = this.interaction.originY + (event.clientY - this.interaction.startY) / this.scale;
      this.positionCard(node);
    } else {
      node.width = Math.max(280, this.interaction.width + (event.clientX - this.interaction.startX) / this.scale);
      node.height = Math.max(220, this.interaction.height + (event.clientY - this.interaction.startY) / this.scale);
      this.positionCard(node);
      (this.protyles.get(node.id) as any)?.resize?.();
    }
    if (this.interaction.type !== "pan") this.plumbing?.revalidate(this.card(node.id)!);
  }

  private openSearch() {
    const dialog = this.element.querySelector<HTMLElement>("[data-role='search-dialog']")!;
    const input = this.element.querySelector<HTMLInputElement>("[data-role='search-input']")!;
    dialog.classList.remove("is-hidden");
    input.value = "";
    this.searchIndex = 0;
    void this.renderSearchResults("");
    window.setTimeout(() => input.focus(), 0);
  }

  private closeSearch() {
    this.element.querySelector("[data-role='search-dialog']")?.classList.add("is-hidden");
  }

  private async renderSearchResults(query: string) {
    const container = this.element.querySelector<HTMLElement>("[data-role='search-results']")!;
    container.innerHTML = `<div class="syc-search-state">Suche …</div>`;
    try {
      const results = await searchReferences(query);
      if (this.element.querySelector<HTMLInputElement>("[data-role='search-input']")!.value !== query) return;
      container.innerHTML = "";
      this.searchIndex = Math.min(this.searchIndex, Math.max(0, results.length - 1));
      if (!results.length) {
        container.innerHTML = `<div class="syc-search-state">Keine Dokumente oder Blöcke gefunden.</div>`;
        return;
      }
      results.forEach((result, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "syc-search-result";
        button.dataset.index = String(index);
        button.classList.toggle("is-active", index === this.searchIndex);
        const icon = document.createElement("span");
        icon.className = "syc-search-result__icon";
        icon.textContent = result.type === "document" ? "▤" : "▦";
        const text = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = result.content;
        const meta = document.createElement("small");
        meta.textContent = result.hpath || `${result.type === "document" ? "Dokument" : "Block"} · ${result.id}`;
        text.append(title, meta);
        button.append(icon, text);
        button.addEventListener("pointermove", () => {
          this.searchIndex = index;
          this.refreshSearchSelection();
        });
        button.addEventListener("click", () => void this.chooseSearchResult(result));
        container.append(button);
      });
    } catch (error) {
      container.innerHTML = `<div class="syc-search-state">Suche fehlgeschlagen.</div>`;
      console.error(error);
    }
  }

  private onSearchKeydown(event: KeyboardEvent) {
    const results = [...this.element.querySelectorAll<HTMLElement>(".syc-search-result")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!results.length) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.searchIndex = (this.searchIndex + direction + results.length) % results.length;
      this.refreshSearchSelection();
    } else if (event.key === "Enter") {
      event.preventDefault();
      results[this.searchIndex]?.click();
    }
  }

  private refreshSearchSelection() {
    this.element.querySelectorAll<HTMLElement>(".syc-search-result").forEach((item, index) => {
      item.classList.toggle("is-active", index === this.searchIndex);
      if (index === this.searchIndex) item.scrollIntoView({ block: "nearest" });
    });
  }

  private async chooseSearchResult(result: ReferenceResult) {
    this.closeSearch();
    await this.addResolvedReference(result);
  }

  private async addReferenceById(id: string, position = this.nextPosition()) {
    try {
      const match = (await searchReferences(id))[0];
      if (!match) {
        showMessage("Keine passende SiYuan-Referenz gefunden.");
        return;
      }
      await this.addResolvedReference(match, position);
    } catch (error) {
      showMessage(String(error));
    }
  }

  private async addResolvedReference(match: ReferenceResult, position = this.nextPosition()) {
    try {
      const node: CanvasNode = {
        id: newId("node"),
        type: match.type,
        x: position.x,
        y: position.y,
        width: 430,
        height: 340,
        ...(match.type === "document" ? { docId: match.id } : { blockId: match.id }),
      };
      this.graph.nodes.push(node);
      await this.appendCard(node);
      this.selectNode(node.id);
      this.updateEmptyState();
      this.queueSave();
    } catch (error) {
      showMessage(String(error));
    }
  }

  private addTextNode() {
    const position = this.nextPosition();
    const node: CanvasNode = {
      id: newId("node"),
      type: "text",
      markdown: "",
      x: position.x,
      y: position.y,
      width: 340,
      height: 250,
    };
    this.graph.nodes.push(node);
    void this.appendCard(node).then(() => {
      this.selectNode(node.id);
      this.card(node.id)?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
    this.updateEmptyState();
    this.queueSave();
  }

  private async duplicateSelectedNode() {
    const source = this.graph.nodes.find((node) => node.id === this.selectedNode);
    if (!source) return;
    const duplicate: CanvasNode = {
      ...source,
      id: newId("node"),
      x: source.x + 42,
      y: source.y + 42,
    };
    this.graph.nodes.push(duplicate);
    await this.appendCard(duplicate);
    this.selectNode(duplicate.id);
    this.updateEmptyState();
    this.queueSave();
  }

  private cycleSelectedColor() {
    const node = this.graph.nodes.find((item) => item.id === this.selectedNode);
    if (!node) return;
    const current = CARD_COLORS.indexOf(node.color || "default");
    node.color = CARD_COLORS[(current + 1) % CARD_COLORS.length];
    const card = this.card(node.id);
    if (card) card.dataset.color = node.color;
    this.queueSave();
  }

  private fitToContent() {
    if (!this.graph.nodes.length) return;
    const padding = 72;
    const minX = Math.min(...this.graph.nodes.map((node) => node.x));
    const minY = Math.min(...this.graph.nodes.map((node) => node.y));
    const maxX = Math.max(...this.graph.nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...this.graph.nodes.map((node) => node.y + node.height));
    const viewport = this.viewport();
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    this.scale = Math.min(1.35, Math.max(0.35, Math.min(
      (viewport.clientWidth - padding * 2) / width,
      (viewport.clientHeight - padding * 2) / height,
    )));
    this.pan = {
      x: (viewport.clientWidth - width * this.scale) / 2 - minX * this.scale,
      y: (viewport.clientHeight - height * this.scale) / 2 - minY * this.scale,
    };
    this.updateTransform();
  }

  private async renderNodes() {
    this.destroyEditors();
    this.syncingConnections = true;
    this.plumbing?.deleteEveryConnection();
    this.connections.clear();
    this.world().innerHTML = "";
    await Promise.all(this.graph.nodes.map((node) => this.appendCard(node)));
    this.syncingConnections = false;
    this.renderConnections();
  }

  private async appendCard(node: CanvasNode) {
    const card = document.createElement("article");
    card.className = `syc-card syc-card--${node.type}`;
    card.id = node.id;
    card.dataset.nodeId = node.id;
    card.dataset.color = node.color || "default";
    card.innerHTML = `
      <header class="syc-card__header">
        <span class="syc-card__kind">${node.type === "document" ? "▤ Dokument" : node.type === "block" ? "▦ Block" : "✎ Text"}</span>
        <strong class="syc-card__title"></strong>
        <button class="syc-card__menu" title="Karte löschen">×</button>
      </header>
      <div class="syc-card__body"></div>
      <footer class="syc-card__footer"><span></span><span class="syc-card__hint">Am Kopf ziehen · Ecke zum Skalieren</span></footer>
      <button class="syc-port syc-port--top" title="Verbinden"></button>
      <button class="syc-port syc-port--right" title="Verbinden"></button>
      <button class="syc-port syc-port--bottom" title="Verbinden"></button>
      <button class="syc-port syc-port--left" title="Verbinden"></button>
      <div class="syc-resize" title="Kartengröße ändern"></div>`;
    this.world().append(card);
    this.positionCard(node);
    this.plumbing?.manage(card);

    const title = card.querySelector<HTMLElement>(".syc-card__title")!;
    const body = card.querySelector<HTMLElement>(".syc-card__body")!;
    const footer = card.querySelector<HTMLElement>(".syc-card__footer span")!;

    if (node.type === "text") {
      title.textContent = "Freie Textkarte";
      footer.textContent = "Nur im Canvas gespeichert";
      const textarea = document.createElement("textarea");
      textarea.className = "syc-text-editor";
      textarea.placeholder = "Schreibe direkt auf die Karte …";
      textarea.value = node.markdown || "";
      textarea.addEventListener("input", () => {
        node.markdown = textarea.value;
        this.queueSave();
      });
      body.append(textarea);
    } else {
      const id = referenceId(node)!;
      title.textContent = node.type === "document" ? "Dokument wird geladen …" : "Block wird geladen …";
      footer.textContent = id;
      body.classList.add("syc-card__body--protyle");
      try {
        title.textContent = await getReferenceTitle(node);
        const editorHost = document.createElement("div");
        editorHost.className = "syc-protyle-host";
        body.append(editorHost);
        const protyle = new Protyle(this.app, editorHost, { blockId: id });
        this.protyles.set(node.id, protyle);
        body.addEventListener("wheel", (event) => {
          if (event.ctrlKey || event.metaKey) return;
          event.stopPropagation();
          const scroller = body.querySelector<HTMLElement>(".protyle-content");
          if (!scroller) return;
          const factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 18
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? scroller.clientHeight
              : 1;
          event.preventDefault();
          scroller.scrollTop += event.deltaY * factor;
          scroller.scrollLeft += event.deltaX * factor;
        }, { passive: false });
      } catch (error) {
        body.textContent = `Quelle konnte nicht geladen werden: ${String(error)}`;
        body.classList.add("syc-card__error");
      }
    }

    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".syc-card__menu")) return;
      this.selectNode(node.id);
    });

    card.querySelector<HTMLElement>(".syc-card__header")!.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectNode(node.id);
      this.interaction = {
        type: "move",
        nodeId: node.id,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y,
      };
      this.viewport().setPointerCapture(event.pointerId);
    });

    card.querySelector<HTMLElement>(".syc-resize")!.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectNode(node.id);
      this.interaction = {
        type: "resize",
        nodeId: node.id,
        startX: event.clientX,
        startY: event.clientY,
        width: node.width,
        height: node.height,
      };
      this.viewport().setPointerCapture(event.pointerId);
    });

    card.querySelector<HTMLElement>(".syc-card__menu")!.addEventListener("click", (event) => {
      event.stopPropagation();
      this.selectNode(node.id);
      this.deleteSelection();
    });

  }

  private selectNode(id: string) {
    this.selectedNode = id;
    this.selectedEdge = undefined;
    this.refreshSelection();
  }

  private selectEdge(id: string) {
    this.selectedEdge = id;
    this.selectedNode = undefined;
    this.refreshSelection();
    this.refreshConnections();
  }

  private clearSelection() {
    this.selectedNode = undefined;
    this.selectedEdge = undefined;
    this.refreshSelection();
    this.refreshConnections();
  }

  private refreshSelection() {
    this.element.querySelectorAll<HTMLElement>(".syc-card").forEach((card) => {
      card.classList.toggle("is-selected", card.dataset.nodeId === this.selectedNode);
    });
    const deleteButton = this.element.querySelector<HTMLButtonElement>("[data-action='delete']")!;
    deleteButton.disabled = !this.selectedNode && !this.selectedEdge;
    this.element.querySelectorAll<HTMLButtonElement>("[data-requires-node]").forEach((button) => {
      button.disabled = !this.selectedNode;
    });
    this.refreshConnections();
  }

  private toggleLinkMode() {
    if (this.linkMode) this.cancelLinkMode();
    else this.startLinkMode();
  }

  private startLinkMode() {
    this.linkMode = true;
    this.element.classList.add("is-linking");
    this.element.querySelector("[data-action='link']")?.classList.add("is-active");
    this.setStatus("Verbindungspunkt einer Karte auf eine Zielkarte ziehen", true);
    this.refreshSelection();
  }

  private cancelLinkMode() {
    this.linkMode = false;
    this.element.classList.remove("is-linking");
    this.element.querySelector("[data-action='link']")?.classList.remove("is-active");
    this.setStatus("Bereit");
    this.refreshSelection();
  }

  private deleteSelection() {
    if (this.selectedEdge) {
      const connection = this.connections.get(this.selectedEdge);
      if (connection) this.plumbing?.deleteConnection(connection);
      else this.graph.edges = this.graph.edges.filter((edge) => edge.id !== this.selectedEdge);
      this.selectedEdge = undefined;
    } else if (this.selectedNode) {
      const id = this.selectedNode;
      (this.protyles.get(id) as any)?.destroy?.();
      this.protyles.delete(id);
      this.graph.nodes = this.graph.nodes.filter((node) => node.id !== id);
      this.graph.edges = this.graph.edges.filter((edge) => edge.source !== id && edge.target !== id);
      const card = this.card(id);
      if (card) this.plumbing?.unmanage(card, true);
      this.selectedNode = undefined;
    }
    this.refreshSelection();
    this.updateEmptyState();
    this.queueSave();
  }

  private renderConnections() {
    if (!this.plumbing) return;
    this.syncingConnections = true;
    for (const edge of this.graph.edges) {
      const source = this.card(edge.source);
      const target = this.card(edge.target);
      if (!source || !target) continue;
      const connection = this.plumbing.connect({ source, target });
      if (!connection) continue;
      connection.setParameter("edgeId", edge.id);
      connection.setLabel(edge.label || "");
      this.connections.set(edge.id, connection);
    }
    this.syncingConnections = false;
    this.refreshConnections();
  }

  private onConnectionCreated(info: { connection: Connection; sourceId: string; targetId: string }) {
    if (this.syncingConnections) return;
    const { connection } = info;
    const source = this.card(info.sourceId)?.dataset.nodeId || info.sourceId;
    const target = this.card(info.targetId)?.dataset.nodeId || info.targetId;
    if (!source || !target || source === target) return;
    const edge: CanvasEdge = { id: newId("edge"), source, target, label: "", directed: true };
    connection.setParameter("edgeId", edge.id);
    this.graph.edges.push(edge);
    this.connections.set(edge.id, connection);
    this.selectEdge(edge.id);
    this.openEdgeDialog(edge.id);
    this.cancelLinkMode();
    this.queueSave();
  }

  private onConnectionDetached(connection: Connection) {
    if (this.syncingConnections) return;
    const edgeId = connection.getParameter("edgeId") as string;
    if (!edgeId) return;
    this.connections.delete(edgeId);
    this.graph.edges = this.graph.edges.filter((edge) => edge.id !== edgeId);
    if (this.selectedEdge === edgeId) this.selectedEdge = undefined;
    this.refreshSelection();
    this.queueSave();
  }

  private refreshConnections() {
    this.connections.forEach((connection, id) => {
      connection.removeClass("syc-connection-selected");
      if (id === this.selectedEdge) connection.addClass("syc-connection-selected");
    });
  }

  private openEdgeDialog(edgeId: string) {
    const edge = this.graph.edges.find((item) => item.id === edgeId);
    if (!edge) return;
    this.selectedEdge = edgeId;
    this.refreshSelection();
    this.element.querySelector<HTMLElement>("[data-role='edge-dialog']")!.classList.remove("is-hidden");
    const input = this.element.querySelector<HTMLInputElement>("[data-role='edge-label']")!;
    input.value = edge.label || "";
    window.setTimeout(() => input.focus(), 0);
  }

  private closeEdgeDialog() {
    this.element.querySelector("[data-role='edge-dialog']")?.classList.add("is-hidden");
  }

  private saveEdgeLabel() {
    const edge = this.graph.edges.find((item) => item.id === this.selectedEdge);
    if (!edge) return this.closeEdgeDialog();
    edge.label = this.element.querySelector<HTMLInputElement>("[data-role='edge-label']")!.value.trim();
    this.connections.get(edge.id)?.setLabel(edge.label);
    this.closeEdgeDialog();
    this.queueSave();
  }

  private setScale(next: number, pointer?: Point) {
    const previous = this.scale;
    const clamped = Math.min(1.8, Math.max(0.35, next));
    if (pointer) {
      this.pan.x = pointer.x - ((pointer.x - this.pan.x) * clamped) / previous;
      this.pan.y = pointer.y - ((pointer.y - this.pan.y) * clamped) / previous;
    }
    this.scale = clamped;
    this.updateTransform();
  }

  private updateTransform() {
    this.world().style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
    this.element.querySelector<HTMLElement>(".syc-zoom")!.textContent = `${Math.round(this.scale * 100)}%`;
    this.plumbing?.setZoom(this.scale, true);
  }

  private positionCard(node: CanvasNode) {
    const card = this.card(node.id);
    if (!card) return;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${node.width}px`;
    card.style.height = `${node.height}px`;
  }

  private nextPosition(): Point {
    const offset = (this.graph.nodes.length % 7) * 28;
    const center = this.toWorld(this.viewport().clientWidth / 2, this.viewport().clientHeight / 2);
    return { x: center.x - 180 + offset, y: center.y - 130 + offset };
  }

  private toWorld(x: number, y: number): Point {
    return { x: (x - this.pan.x) / this.scale, y: (y - this.pan.y) / this.scale };
  }

  private queueSave() {
    window.clearTimeout(this.saveTimer);
    this.setStatus("Ungespeicherte Layoutänderungen");
    this.saveTimer = window.setTimeout(() => void this.save(false), 900);
  }

  private async save(notify: boolean) {
    try {
      await this.store.save(this.graph);
      this.setStatus("Gespeichert");
      if (notify) showMessage("Canvas gespeichert");
    } catch (error) {
      this.setStatus("Speichern fehlgeschlagen", true);
      showMessage(String(error));
    }
  }

  private setStatus(message: string, active = false) {
    const status = this.element.querySelector<HTMLElement>("[data-role='status']")!;
    status.textContent = message;
    status.classList.toggle("is-active", active);
  }

  private updateEmptyState() {
    this.element.querySelector(".syc-empty")?.classList.toggle("is-hidden", this.graph.nodes.length > 0);
  }

  private destroyEditors() {
    this.protyles.forEach((protyle) => (protyle as any)?.destroy?.());
    this.protyles.clear();
  }

  private viewport() {
    return this.element.querySelector<HTMLElement>(".syc-viewport")!;
  }

  private world() {
    return this.element.querySelector<HTMLElement>(".syc-world")!;
  }

  private card(id: string) {
    return this.element.querySelector<HTMLElement>(`.syc-card[data-node-id="${id}"]`);
  }
}

export default class SiYuanCanvas extends Plugin {
  private store = new GraphStore();
  private tabType = "siyuan-canvas";

  onload() {
    this.addIcons(`<symbol id="iconSiYuanCanvas" viewBox="0 0 32 32"><path d="M5 7h9v9H5zM18 16h9v9h-9zM14 11l4 5M14 16l4 4" fill="none" stroke="currentColor" stroke-width="2"/></symbol>`);
    const plugin = this;
    this.addTab({
      type: this.tabType,
      init(this: any) {
        const canvasId = this.data?.canvasId || `canvas-${Date.now()}`;
        new CanvasView(plugin.app, this.element, canvasId, plugin.store).init().catch((error) => {
          console.error("SiYuan Canvas konnte nicht initialisiert werden", error);
          this.element.innerHTML = `<div class="syc-error">Canvas konnte nicht geladen werden: ${String(error)}</div>`;
        });
      },
    });
  }

  onLayoutReady() {
    this.addTopBar({
      icon: "iconSiYuanCanvas",
      title: "SiYuan Canvas",
      position: "right",
      callback: () => void this.openMenu(),
    });
  }

  private async openMenu() {
    const known = await this.store.list();
    const options = ["Neuen Canvas erstellen", ...known.map((item) => item.id)];
    const selected = prompt(
      `Canvas öffnen:\n${options.map((item, index) => `${index + 1}: ${item}`).join("\n")}\n\nNummer:`,
      "1",
    );
    const index = (Number(selected) || 0) - 1;
    if (index < 0 || index >= options.length) return;
    this.open(index === 0 ? `canvas-${Date.now()}` : known[index - 1].id);
  }

  private open(canvasId: string) {
    openTab({
      app: this.app,
      custom: {
        icon: "iconSiYuanCanvas",
        title: "Canvas",
        data: { canvasId },
        id: `${this.name}${this.tabType}`,
      },
    });
  }
}
