import { App, Dialog, Plugin, Protyle, openTab, showMessage } from "siyuan";
import {
  BrowserJsPlumbInstance,
  Connection,
  EVENT_CONNECTION,
  EVENT_CONNECTION_DETACHED,
  INTERCEPT_BEFORE_DROP,
  newInstance,
} from "@jsplumb/browser-ui";
import "./index.css";

type NodeKind = "document" | "block" | "text" | "group" | "shape" | "canvas" | "link";
type CardColor = string;
type ShapeKind = "rectangle" | "ellipse" | "diamond";
type EdgeStyle = "bezier" | "straight" | "orthogonal";

interface CanvasNode {
  id: string;
  type: NodeKind;
  docId?: string;
  blockId?: string;
  markdown?: string;
  label?: string;
  shape?: ShapeKind;
  canvasRefId?: string;
  url?: string;
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
  color?: CardColor;
  style?: EdgeStyle;
  directed: true;
}

interface CanvasGraph {
  canvasId: string;
  name: string;
  schemaVersion: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasIndexEntry {
  id: string;
  name?: string;
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
  | { type: "lasso"; startX: number; startY: number; additive: boolean; initial: string[] }
  | { type: "move"; nodeId: string; startX: number; startY: number; origins: Array<{ id: string; x: number; y: number }>; before: string }
  | { type: "resize"; nodeId: string; startX: number; startY: number; width: number; height: number; before: string };

const STORAGE_ROOT = "/data/storage/petal/siyuan-canvas";
const SIYUAN_ID = /^[0-9]{14}-[a-z0-9]{7}$/;
const SIYUAN_ID_GLOBAL = /[0-9]{14}-[a-z0-9]{7}/g;
const GRID_SIZE = 22;
const HISTORY_LIMIT = 50;
const CARD_COLORS = ["default", "red", "orange", "yellow", "green", "cyan", "blue", "pink", "purple"];
const COLOR_VALUES: Record<string, string> = {
  default: "",
  red: "#d65c5c",
  orange: "#df8b45",
  yellow: "#d5ad45",
  green: "#54a970",
  cyan: "#43a9b5",
  blue: "#568fd0",
  pink: "#d46f9c",
  purple: "#916dcc",
};

function normalizedUrl(value: string): string | undefined {
  const input = value.trim();
  if (!input) return undefined;
  try {
    const candidate = /^https?:\/\//i.test(input)
      ? input
      : input.startsWith("/")
        ? new URL(input, window.location.origin).href
        : /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]|$)/i.test(input)
          ? `https://${input}`
          : "";
    if (!candidate) return undefined;
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function mediaType(url: string): "image" | "video" | "audio" | "pdf" | "web" {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(path)) return "audio";
  if (/\.pdf$/.test(path)) return "pdf";
  return "web";
}

function embeddedUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === "youtu.be") return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;
  if (parsed.hostname.endsWith("youtube.com")) {
    const id = parsed.searchParams.get("v");
    if (id) return `https://www.youtube.com/embed/${id}`;
  }
  return url;
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const emptyGraph = (canvasId: string, name = "Unbenannter Canvas"): CanvasGraph => ({
  canvasId,
  name,
  schemaVersion: 1,
  nodes: [],
  edges: [],
});

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

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
    const entry = { id: graph.canvasId, name: graph.name, updatedAt: new Date().toISOString() };
    await putJson(`${STORAGE_ROOT}/index.json`, [
      entry,
      ...previous.filter((item) => item.id !== graph.canvasId),
    ]);
  }

  async rename(id: string, name: string) {
    const graph = await this.load(id);
    if (!graph) throw new Error("Canvas-Datei wurde nicht gefunden");
    graph.name = name;
    await this.save(graph);
  }

  async remove(id: string) {
    await kernel<void>("/api/file/removeFile", { path: `${STORAGE_ROOT}/${id}.json` });
    const previous = await this.list();
    await putJson(`${STORAGE_ROOT}/index.json`, previous.filter((item) => item.id !== id));
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
  private selectedNodes = new Set<string>();
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
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private spacePressed = false;

  constructor(
    private app: App,
    private element: HTMLElement,
    private canvasId: string,
    private store: GraphStore,
    private openCanvas: (canvasId: string, canvasName: string) => void,
    private initialName = "Unbenannter Canvas",
  ) {
    this.graph = emptyGraph(canvasId, initialName);
  }

  async init() {
    this.mount();
    try {
      const stored = await this.store.load(this.canvasId);
      this.graph = stored || emptyGraph(this.canvasId, this.initialName);
      this.graph.name ||= this.initialName;
      if (!stored) await this.store.save(this.graph);
    } catch (error) {
      showMessage(`Canvas-Speicher nicht erreichbar: ${String(error)}`);
    }
    this.setupConnections();
    this.bindGlobalEvents();
    this.element.querySelector<HTMLInputElement>("[data-role='canvas-name']")!.value = this.graph.name;
    await this.renderNodes();
    this.updateTransform();
    this.updateEmptyState();
  }

  private mount() {
    this.element.classList.add("syc-root");
    this.element.tabIndex = 0;
    this.element.innerHTML = `
      <div class="syc-toolbar">
        <div class="syc-toolbar__group">
          <button class="syc-button syc-button--primary" data-action="reference">＋ Referenz</button>
          <button class="syc-button" data-action="text">＋ Text</button>
          <button class="syc-button" data-action="canvas">◈ Canvas</button>
          <button class="syc-button" data-action="link-card">↗ Web/Media</button>
          <button class="syc-button" data-action="group">▣ Gruppe</button>
          <button class="syc-button" data-action="shape">◇ Form</button>
          <button class="syc-button" data-action="link">↗ Verbinden</button>
          <button class="syc-button" data-action="edit-edge" data-requires-edge disabled>✎ Pfeil</button>
          <button class="syc-button" data-action="duplicate" data-requires-node disabled>⧉ Duplizieren</button>
          <button class="syc-button" data-action="color" data-requires-selection disabled>● Farbe</button>
          <button class="syc-button syc-button--danger" data-action="delete" disabled>⌫ Löschen</button>
        </div>
        <input class="syc-canvas-name" data-role="canvas-name" maxlength="80" aria-label="Canvas-Name" value="Unbenannter Canvas">
        <div class="syc-toolbar__status" data-role="status">Bereit</div>
        <div class="syc-toolbar__group syc-toolbar__group--right">
          <button class="syc-icon-button" data-action="undo" data-role="undo" disabled title="Rückgängig (Strg+Z)">↶</button>
          <button class="syc-icon-button" data-action="redo" data-role="redo" disabled title="Wiederholen (Strg+Umschalt+Z)">↷</button>
          <button class="syc-icon-button" data-action="fit" title="Alle Karten einpassen">⛶</button>
          <button class="syc-icon-button" data-action="fit-selection" data-requires-selection disabled title="Auswahl einpassen">▣</button>
          <button class="syc-icon-button" data-action="zoom-out" title="Verkleinern">−</button>
          <button class="syc-zoom" data-action="zoom-reset" title="Zoom zurücksetzen">90%</button>
          <button class="syc-icon-button" data-action="zoom-in" title="Vergrößern">＋</button>
          <button class="syc-button" data-action="save">Speichern</button>
        </div>
      </div>
      <div class="syc-color-menu is-hidden" data-role="color-menu" aria-label="Farbe wählen">
        ${CARD_COLORS.map((color) => `<button class="syc-color-swatch syc-color-swatch--${color}" data-action="set-color" data-color="${color}" title="${color}"></button>`).join("")}
        <label class="syc-color-custom" title="Eigene Farbe"><input data-role="custom-color" type="color" value="#568fd0"><span>＋</span></label>
      </div>
      <div class="syc-shape-menu is-hidden" data-role="shape-menu" aria-label="Form hinzufügen">
        <button data-action="add-shape" data-shape="rectangle">▭ Rechteck</button>
        <button data-action="add-shape" data-shape="ellipse">◯ Ellipse</button>
        <button data-action="add-shape" data-shape="diamond">◇ Raute</button>
      </div>
      <div class="syc-viewport">
        <div class="syc-world"></div>
        <div class="syc-lasso is-hidden" data-role="lasso"></div>
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
          <header class="syc-dialog__header"><strong>Pfeil bearbeiten</strong><button type="button" class="syc-dialog__close" data-action="close-edge">×</button></header>
          <input class="syc-search" data-role="edge-label" maxlength="80" placeholder="Beschriftung (optional)">
          <label class="syc-field"><span>Von</span><select data-role="edge-source"></select></label>
          <label class="syc-field"><span>Nach</span><select data-role="edge-target"></select></label>
          <label class="syc-field"><span>Linienform</span><select data-role="edge-style"><option value="bezier">Gebogen</option><option value="straight">Gerade</option><option value="orthogonal">Rechtwinklig</option></select></label>
          <div class="syc-dialog__actions"><button type="button" class="syc-button" data-action="close-edge">Abbrechen</button><button class="syc-button syc-button--primary" type="submit">Übernehmen</button></div>
        </form>
      </div>
      <div class="syc-dialog-backdrop is-hidden" data-role="canvas-dialog">
        <form class="syc-dialog syc-dialog--small" data-role="canvas-form">
          <header class="syc-dialog__header"><strong>Canvas einbetten</strong><button type="button" class="syc-dialog__close" data-action="close-canvas">×</button></header>
          <label class="syc-field syc-field--spaced"><span>Canvas</span><select data-role="canvas-reference"></select></label>
          <p class="syc-dialog__note">Die Karte speichert nur eine Referenz. Doppelklick öffnet den verschachtelten Canvas.</p>
          <div class="syc-dialog__actions"><button type="button" class="syc-button" data-action="close-canvas">Abbrechen</button><button class="syc-button syc-button--primary" type="submit">Einbetten</button></div>
        </form>
      </div>
      <div class="syc-dialog-backdrop is-hidden" data-role="link-dialog">
        <form class="syc-dialog syc-dialog--small" data-role="link-form">
          <header class="syc-dialog__header"><strong>Web oder Medium einbetten</strong><button type="button" class="syc-dialog__close" data-action="close-link-card">×</button></header>
          <input class="syc-search" data-role="link-url" type="url" required placeholder="https://…">
          <input class="syc-search syc-search--second" data-role="link-label" maxlength="80" placeholder="Titel (optional)">
          <div class="syc-dialog__actions"><button type="button" class="syc-button" data-action="close-link-card">Abbrechen</button><button class="syc-button syc-button--primary" type="submit">Einbetten</button></div>
        </form>
      </div>
      <div class="syc-selection-bar is-hidden" data-role="selection-bar" aria-label="Auswahl bearbeiten">
        <span data-role="selection-count"></span>
        <button data-action="floating-color" title="Farbe">●</button>
        <button data-action="duplicate" title="Duplizieren">⧉</button>
        <button data-action="align-left" data-requires-multi title="Links ausrichten">⇤</button>
        <button data-action="align-center" data-requires-multi title="Horizontal zentrieren">↔</button>
        <button data-action="align-right" data-requires-multi title="Rechts ausrichten">⇥</button>
        <button data-action="align-top" data-requires-multi title="Oben ausrichten">⇡</button>
        <button data-action="align-middle" data-requires-multi title="Vertikal zentrieren">↕</button>
        <button data-action="align-bottom" data-requires-multi title="Unten ausrichten">⇣</button>
        <button data-action="distribute-horizontal" data-requires-three title="Horizontal verteilen">⇹</button>
        <button data-action="distribute-vertical" data-requires-three title="Vertikal verteilen">⇳</button>
        <button data-action="group-selection" title="Auswahl gruppieren">▣</button>
        <button data-action="delete" class="is-danger" title="Löschen">⌫</button>
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
      connectionsDetachable: true,
    });
    this.plumbing.addSourceSelector(".syc-port", {
      anchor: "Continuous",
      maxConnections: -1,
      uniqueEndpoint: true,
    });
    this.plumbing.addTargetSelector(".syc-card", {
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
      const trigger = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      const action = trigger?.dataset.action;
      if (action) void this.handleAction(action, trigger);
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
        this.element.focus({ preventScroll: true });
        event.preventDefault();
        if (event.button === 1 || this.spacePressed) {
          this.interaction = {
            type: "pan",
            startX: event.clientX - this.pan.x,
            startY: event.clientY - this.pan.y,
          };
        } else if (event.button === 0) {
          if (!event.shiftKey) this.clearSelection();
          this.interaction = {
            type: "lasso",
            startX: event.clientX,
            startY: event.clientY,
            additive: event.shiftKey,
            initial: [...this.selectedNodes],
          };
          this.updateLasso(event.clientX, event.clientY);
        } else {
          return;
        }
        viewport.setPointerCapture(event.pointerId);
      }
    });

    viewport.addEventListener("dblclick", (event) => {
      if (event.target !== viewport && event.target !== this.world()) return;
      const rect = viewport.getBoundingClientRect();
      this.addTextNode(this.toWorld(event.clientX - rect.left, event.clientY - rect.top));
    });

    viewport.addEventListener("pointermove", (event) => this.onPointerMove(event));
    viewport.addEventListener("pointerup", (event) => {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (this.interaction?.type === "lasso") {
        this.finishLasso(event.clientX, event.clientY, this.interaction);
      } else if (this.interaction?.type === "move" || this.interaction?.type === "resize") {
        this.commitHistorySnapshot(this.interaction.before);
        this.queueSave();
      }
      this.element.querySelector("[data-role='lasso']")?.classList.add("is-hidden");
      this.interaction = undefined;
    });

    viewport.addEventListener("dragover", (event) => event.preventDefault());
    viewport.addEventListener("drop", (event) => {
      event.preventDefault();
      const ids = droppedSiYuanIds(event.dataTransfer);
      const rect = viewport.getBoundingClientRect();
      const origin = this.toWorld(event.clientX - rect.left, event.clientY - rect.top);
      if (!ids.length) {
        const raw = event.dataTransfer?.getData("text/uri-list")
          || event.dataTransfer?.getData("text/plain")
          || "";
        const text = raw.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() || "";
        const url = normalizedUrl(text);
        if (url) this.addLinkNode(url, "", origin);
        else if (text) this.addTextNode(origin, text);
        else showMessage("Der Drop enthält keine erkennbare SiYuan-ID, URL oder Text.");
        return;
      }
      void Promise.all(ids.map((id, index) => this.addReferenceById(id, {
        x: origin.x + index * 32,
        y: origin.y + index * 32,
      })));
    });

    this.element.addEventListener("keydown", (event) => {
      const editing = event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLSelectElement
        || (event.target as HTMLElement).isContentEditable;
      if (event.key === "Escape") {
        this.closeSearch();
        this.closeEdgeDialog();
        this.closeCanvasDialog();
        this.closeLinkDialog();
        this.cancelLinkMode();
      }
      if (!editing && event.code === "Space") {
        event.preventDefault();
        this.spacePressed = true;
      }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? this.redo() : this.undo());
      }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void this.redo();
      }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        this.selectNodes(this.graph.nodes.map((node) => node.id));
      }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void this.duplicateSelectedNodes();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !editing) {
        void this.handleAction("delete");
      }
      if (!editing && event.shiftKey && event.key === "1") {
        event.preventDefault();
        this.fitToContent();
      }
      if (!editing && event.shiftKey && event.key === "2") {
        event.preventDefault();
        this.fitToSelection();
      }
    });
    this.element.addEventListener("paste", (event) => {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      event.preventDefault();
      const url = normalizedUrl(text);
      if (url) this.addLinkNode(url);
      else this.addTextNode(this.nextPosition(), text);
    });
    this.element.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spacePressed = false;
    });
    const input = this.element.querySelector<HTMLInputElement>("[data-role='search-input']")!;
    input.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void this.renderSearchResults(input.value), 180);
    });
    input.addEventListener("keydown", (event) => this.onSearchKeydown(event));
    const canvasName = this.element.querySelector<HTMLInputElement>("[data-role='canvas-name']")!;
    canvasName.addEventListener("focus", () => this.recordHistory());
    canvasName.addEventListener("input", (event) => {
      this.graph.name = (event.target as HTMLInputElement).value.trim() || "Unbenannter Canvas";
      this.queueSave();
    });
    this.element.querySelector<HTMLFormElement>("[data-role='edge-form']")!.addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveEdgeLabel();
    });
    this.element.querySelector<HTMLFormElement>("[data-role='canvas-form']")!.addEventListener("submit", (event) => {
      event.preventDefault();
      const select = this.element.querySelector<HTMLSelectElement>("[data-role='canvas-reference']")!;
      const option = select.selectedOptions[0];
      if (select.value && option) this.addCanvasNode(select.value, option.textContent || select.value);
    });
    this.element.querySelector<HTMLFormElement>("[data-role='link-form']")!.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.element.querySelector<HTMLInputElement>("[data-role='link-url']")!;
      const url = normalizedUrl(input.value);
      if (!url) return showMessage("Bitte eine gültige HTTP- oder HTTPS-Adresse eingeben.");
      const label = this.element.querySelector<HTMLInputElement>("[data-role='link-label']")!.value.trim();
      this.addLinkNode(url, label);
    });
    this.element.querySelector<HTMLInputElement>("[data-role='custom-color']")!.addEventListener("change", (event) => {
      this.setSelectedColor((event.target as HTMLInputElement).value);
    });
    this.element.querySelectorAll<HTMLElement>(".syc-dialog-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) {
          this.closeSearch();
          this.closeEdgeDialog();
          this.closeCanvasDialog();
          this.closeLinkDialog();
        }
      });
    });
    new ResizeObserver(() => {
      this.plumbing?.repaintEverything();
      this.positionSelectionBar();
    }).observe(viewport);
  }

  private async handleAction(action: string, trigger?: HTMLElement) {
    if (action === "reference") {
      this.openSearch();
    } else if (action === "text") {
      this.addTextNode();
    } else if (action === "canvas") {
      await this.openCanvasDialog();
    } else if (action === "link-card") {
      this.openLinkDialog();
    } else if (action === "group") {
      this.addGroupNode();
    } else if (action === "shape") {
      this.element.querySelector("[data-role='shape-menu']")?.classList.toggle("is-hidden");
    } else if (action === "add-shape") {
      this.addShapeNode((trigger?.dataset.shape || "rectangle") as ShapeKind);
    } else if (action === "edit-edge") {
      if (this.selectedEdge) this.openEdgeDialog(this.selectedEdge);
    } else if (action === "link") {
      this.toggleLinkMode();
    } else if (action === "duplicate") {
      await this.duplicateSelectedNodes();
    } else if (action === "color") {
      this.toggleColorMenu();
    } else if (action === "set-color") {
      this.setSelectedColor((trigger?.dataset.color || "default") as CardColor);
    } else if (action === "floating-color") {
      this.toggleColorMenu(true);
    } else if (["align-left", "align-center", "align-right", "align-top", "align-middle", "align-bottom", "distribute-horizontal", "distribute-vertical"].includes(action)) {
      this.alignSelection(action);
    } else if (action === "group-selection") {
      this.groupSelection();
    } else if (action === "fit") {
      this.fitToContent();
    } else if (action === "fit-selection") {
      this.fitToSelection();
    } else if (action === "close-search") {
      this.closeSearch();
    } else if (action === "close-edge") {
      this.closeEdgeDialog();
    } else if (action === "close-canvas") {
      this.closeCanvasDialog();
    } else if (action === "close-link-card") {
      this.closeLinkDialog();
    } else if (action === "delete") {
      this.deleteSelection();
    } else if (action === "save") {
      await this.save(true);
    } else if (action === "undo") {
      await this.undo();
    } else if (action === "redo") {
      await this.redo();
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
    if (this.interaction.type === "lasso") {
      this.updateLasso(event.clientX, event.clientY);
      return;
    }

    const node = this.graph.nodes.find((item) => item.id === this.interaction!.nodeId);
    if (!node) return;
    if (this.interaction.type === "move") {
      let dx = (event.clientX - this.interaction.startX) / this.scale;
      let dy = (event.clientY - this.interaction.startY) / this.scale;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const primary = this.interaction.origins.find((origin) => origin.id === this.interaction!.nodeId)
        || this.interaction.origins[0];
      if (primary && !event.altKey) {
        dx = Math.round((primary.x + dx) / GRID_SIZE) * GRID_SIZE - primary.x;
        dy = Math.round((primary.y + dy) / GRID_SIZE) * GRID_SIZE - primary.y;
      }
      this.interaction.origins.forEach((origin) => {
        const member = this.graph.nodes.find((item) => item.id === origin.id);
        if (!member) return;
        member.x = origin.x + dx;
        member.y = origin.y + dy;
        this.positionCard(member);
        const memberCard = this.card(member.id);
        if (memberCard) this.plumbing?.revalidate(memberCard);
      });
    } else {
      const minWidth = node.type === "shape" ? 120 : 280;
      const minHeight = node.type === "shape" ? 90 : 220;
      node.width = Math.max(minWidth, this.interaction.width + (event.clientX - this.interaction.startX) / this.scale);
      node.height = Math.max(minHeight, this.interaction.height + (event.clientY - this.interaction.startY) / this.scale);
      this.positionCard(node);
      (this.protyles.get(node.id) as any)?.resize?.();
    }
    const card = this.card(node.id);
    if (card && node.type !== "group") this.plumbing?.revalidate(card);
    this.positionSelectionBar();
  }

  private updateLasso(clientX: number, clientY: number) {
    if (this.interaction?.type !== "lasso") return;
    const rect = this.viewport().getBoundingClientRect();
    const lasso = this.element.querySelector<HTMLElement>("[data-role='lasso']")!;
    const left = Math.min(this.interaction.startX, clientX) - rect.left;
    const top = Math.min(this.interaction.startY, clientY) - rect.top;
    lasso.style.left = `${left}px`;
    lasso.style.top = `${top}px`;
    lasso.style.width = `${Math.abs(clientX - this.interaction.startX)}px`;
    lasso.style.height = `${Math.abs(clientY - this.interaction.startY)}px`;
    lasso.classList.remove("is-hidden");
  }

  private finishLasso(clientX: number, clientY: number, interaction: Extract<Interaction, { type: "lasso" }>) {
    const rect = this.viewport().getBoundingClientRect();
    const start = this.toWorld(interaction.startX - rect.left, interaction.startY - rect.top);
    const end = this.toWorld(clientX - rect.left, clientY - rect.top);
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    const selected = this.graph.nodes
      .filter((node) => node.x >= left && node.x + node.width <= right && node.y >= top && node.y + node.height <= bottom)
      .map((node) => node.id);
    const ids = interaction.additive ? [...new Set([...interaction.initial, ...selected])] : selected;
    this.selectNodes(ids);
  }

  private groupMembers(group: CanvasNode) {
    return this.graph.nodes.filter((node) => {
      if (node.id === group.id || node.type === "group") return false;
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      return centerX >= group.x && centerX <= group.x + group.width
        && centerY >= group.y && centerY <= group.y + group.height;
    });
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
        icon.className = `syc-search-result__icon syc-search-result__icon--${result.type}`;
        icon.textContent = result.type === "document" ? "▤" : "¶";
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
      this.recordHistory();
      this.graph.nodes.push(node);
      await this.appendCard(node);
      this.selectNode(node.id);
      this.updateEmptyState();
      this.queueSave();
    } catch (error) {
      showMessage(String(error));
    }
  }

  private addTextNode(position = this.nextPosition(), markdown = "") {
    const node: CanvasNode = {
      id: newId("node"),
      type: "text",
      markdown,
      x: position.x,
      y: position.y,
      width: 340,
      height: 250,
    };
    this.recordHistory();
    this.graph.nodes.push(node);
    void this.appendCard(node).then(() => {
      this.selectNode(node.id);
      this.card(node.id)?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
    this.updateEmptyState();
    this.queueSave();
  }

  private async openCanvasDialog() {
    const dialog = this.element.querySelector<HTMLElement>("[data-role='canvas-dialog']")!;
    const select = this.element.querySelector<HTMLSelectElement>("[data-role='canvas-reference']")!;
    select.innerHTML = "";
    let canvases: CanvasIndexEntry[];
    try {
      canvases = (await this.store.list()).filter((item) => item.id !== this.canvasId);
    } catch (error) {
      showMessage(`Canvas-Liste konnte nicht geladen werden: ${String(error)}`);
      return;
    }
    if (!canvases.length) {
      showMessage("Lege zuerst einen zweiten Canvas an. Ein Canvas kann sich nicht selbst einbetten.");
      return;
    }
    canvases.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name || item.id;
      select.append(option);
    });
    dialog.classList.remove("is-hidden");
    window.setTimeout(() => select.focus(), 0);
  }

  private closeCanvasDialog() {
    this.element.querySelector("[data-role='canvas-dialog']")?.classList.add("is-hidden");
  }

  private addCanvasNode(canvasRefId: string, label: string, position = this.nextPosition()) {
    if (!canvasRefId || canvasRefId === this.canvasId) return;
    const node: CanvasNode = {
      id: newId("node"), type: "canvas", canvasRefId, label,
      x: position.x, y: position.y, width: 390, height: 270, color: "cyan",
    };
    this.recordHistory();
    this.graph.nodes.push(node);
    void this.appendCard(node).then(() => this.selectNode(node.id));
    this.closeCanvasDialog();
    this.updateEmptyState();
    this.queueSave();
  }

  private openLinkDialog() {
    const dialog = this.element.querySelector<HTMLElement>("[data-role='link-dialog']")!;
    const url = this.element.querySelector<HTMLInputElement>("[data-role='link-url']")!;
    const label = this.element.querySelector<HTMLInputElement>("[data-role='link-label']")!;
    url.value = "";
    label.value = "";
    dialog.classList.remove("is-hidden");
    window.setTimeout(() => url.focus(), 0);
  }

  private closeLinkDialog() {
    this.element.querySelector("[data-role='link-dialog']")?.classList.add("is-hidden");
  }

  private addLinkNode(url: string, label = "", position = this.nextPosition()) {
    const node: CanvasNode = {
      id: newId("node"), type: "link", url, label,
      x: position.x, y: position.y, width: 420, height: 300, color: "default",
    };
    this.recordHistory();
    this.graph.nodes.push(node);
    void this.appendCard(node).then(() => this.selectNode(node.id));
    this.closeLinkDialog();
    this.updateEmptyState();
    this.queueSave();
  }

  private addGroupNode(position = this.nextGroupPosition()) {
    const node: CanvasNode = {
      id: newId("node"),
      type: "group",
      label: "Neue Gruppe",
      color: "default",
      x: position.x,
      y: position.y,
      width: 620,
      height: 420,
    };
    this.recordHistory();
    this.graph.nodes.unshift(node);
    void this.appendCard(node).then(() => {
      this.selectNode(node.id);
      this.fitToSelection();
      this.card(node.id)?.querySelector<HTMLInputElement>(".syc-group-label")?.select();
    });
    this.updateEmptyState();
    this.queueSave();
  }

  private addShapeNode(shape: ShapeKind, position = this.nextPosition()) {
    if (!["rectangle", "ellipse", "diamond"].includes(shape)) return;
    const node: CanvasNode = {
      id: newId("node"),
      type: "shape",
      shape,
      label: shape === "rectangle" ? "Rechteck" : shape === "ellipse" ? "Ellipse" : "Raute",
      color: "blue",
      x: position.x,
      y: position.y,
      width: 280,
      height: 180,
    };
    this.recordHistory();
    this.graph.nodes.push(node);
    void this.appendCard(node).then(() => {
      this.selectNode(node.id);
      this.card(node.id)?.querySelector<HTMLTextAreaElement>(".syc-shape-editor")?.select();
    });
    this.element.querySelector("[data-role='shape-menu']")?.classList.add("is-hidden");
    this.updateEmptyState();
    this.queueSave();
  }

  private async duplicateSelectedNodes() {
    const sources = this.graph.nodes.filter((node) => this.selectedNodes.has(node.id));
    if (!sources.length) return;
    this.recordHistory();
    const ids = new Map<string, string>();
    const duplicates = sources.map((source) => {
      const id = newId("node");
      ids.set(source.id, id);
      return { ...source, id, x: source.x + 42, y: source.y + 42 };
    });
    const duplicateEdges = this.graph.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ ...edge, id: newId("edge"), source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
    this.graph.nodes.push(...duplicates);
    this.graph.edges.push(...duplicateEdges);
    await Promise.all(duplicates.map((node) => this.appendCard(node)));
    this.renderConnectionsFresh();
    this.selectNodes(duplicates.map((node) => node.id));
    this.updateEmptyState();
    this.queueSave();
  }

  private toggleColorMenu(fromFloating = false) {
    const menu = this.element.querySelector<HTMLElement>("[data-role='color-menu']")!;
    menu.classList.toggle("is-hidden");
    menu.classList.toggle("is-floating", fromFloating && !menu.classList.contains("is-hidden"));
    if (fromFloating) this.positionColorMenu();
  }

  private setSelectedColor(color: CardColor) {
    if (!CARD_COLORS.includes(color) && !/^#[0-9a-f]{6}$/i.test(color)) return;
    if (!this.selectedNodes.size && !this.selectedEdge) return;
    this.recordHistory();
    this.graph.nodes.filter((item) => this.selectedNodes.has(item.id)).forEach((node) => {
      node.color = color;
      const card = this.card(node.id);
      if (card) this.applyCardColor(card, color);
    });
    const edge = this.graph.edges.find((item) => item.id === this.selectedEdge);
    if (edge) edge.color = color;
    this.element.querySelector("[data-role='color-menu']")?.classList.add("is-hidden");
    this.refreshConnections();
    this.queueSave();
  }

  private fitToContent() {
    this.fitNodes(this.graph.nodes);
  }

  private fitToSelection() {
    const nodes = this.graph.nodes.filter((item) => this.selectedNodes.has(item.id));
    if (nodes.length) this.fitNodes(nodes);
    else if (this.selectedEdge) {
      const edge = this.graph.edges.find((item) => item.id === this.selectedEdge);
      if (!edge) return;
      this.fitNodes(this.graph.nodes.filter((item) => item.id === edge.source || item.id === edge.target));
    }
  }

  private alignSelection(action: string) {
    const nodes = this.graph.nodes.filter((node) => this.selectedNodes.has(node.id));
    if (nodes.length < 2) return;
    this.recordHistory();
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    if (action === "align-left") nodes.forEach((node) => { node.x = minX; });
    if (action === "align-top") nodes.forEach((node) => { node.y = minY; });
    if (action === "align-center") {
      const center = (minX + maxX) / 2;
      nodes.forEach((node) => { node.x = center - node.width / 2; });
    }
    if (action === "align-right") nodes.forEach((node) => { node.x = maxX - node.width; });
    if (action === "align-middle") {
      const center = (minY + maxY) / 2;
      nodes.forEach((node) => { node.y = center - node.height / 2; });
    }
    if (action === "align-bottom") nodes.forEach((node) => { node.y = maxY - node.height; });
    if (action === "distribute-horizontal" && nodes.length >= 3) {
      const ordered = [...nodes].sort((a, b) => a.x - b.x);
      const totalWidth = ordered.reduce((sum, node) => sum + node.width, 0);
      const gap = Math.max(0, (maxX - minX - totalWidth) / (ordered.length - 1));
      let x = minX;
      ordered.forEach((node) => {
        node.x = x;
        x += node.width + gap;
      });
    }
    if (action === "distribute-vertical" && nodes.length >= 3) {
      const ordered = [...nodes].sort((a, b) => a.y - b.y);
      const totalHeight = ordered.reduce((sum, node) => sum + node.height, 0);
      const gap = Math.max(0, (maxY - minY - totalHeight) / (ordered.length - 1));
      let y = minY;
      ordered.forEach((node) => {
        node.y = y;
        y += node.height + gap;
      });
    }
    nodes.forEach((node) => {
      this.positionCard(node);
      const card = this.card(node.id);
      if (card) this.plumbing?.revalidate(card);
    });
    this.positionSelectionBar();
    this.queueSave();
  }

  private groupSelection() {
    const nodes = this.graph.nodes.filter((node) => this.selectedNodes.has(node.id) && node.type !== "group");
    if (!nodes.length) return;
    this.recordHistory();
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    const group: CanvasNode = {
      id: newId("node"), type: "group", label: "Neue Gruppe", color: "default",
      x: minX - 40, y: minY - 62, width: maxX - minX + 80, height: maxY - minY + 102,
    };
    this.graph.nodes.unshift(group);
    void this.appendCard(group).then(() => {
      this.selectNode(group.id);
      this.card(group.id)?.querySelector<HTMLInputElement>(".syc-group-label")?.select();
    });
    this.queueSave();
  }

  private fitNodes(nodes: CanvasNode[]) {
    if (!nodes.length) return;
    const padding = 72;
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
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
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    this.syncingConnections = false;
    this.renderConnections();
    this.graph.nodes.forEach((node) => {
      const card = this.card(node.id);
      if (card) this.plumbing?.revalidate(card);
    });
    this.plumbing?.repaintEverything();
  }

  private async appendCard(node: CanvasNode) {
    const card = document.createElement("article");
    card.className = `syc-card syc-card--${node.type}`;
    card.id = node.id;
    card.dataset.nodeId = node.id;
    this.applyCardColor(card, node.color || "default");
    if (node.type === "shape") card.dataset.shape = node.shape || "rectangle";
    card.innerHTML = `
      <header class="syc-card__header">
        <span class="syc-card__kind">${node.type === "document" ? "▤ Dokument" : node.type === "block" ? "¶ Block" : node.type === "group" ? "▣ Gruppe" : node.type === "shape" ? "◇ Form" : node.type === "canvas" ? "◈ Canvas" : node.type === "link" ? "↗ Web/Media" : "✎ Text"}</span>
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

    if (node.type === "shape") {
      title.textContent = "Form";
      footer.textContent = node.shape === "ellipse" ? "Ellipse" : node.shape === "diamond" ? "Raute" : "Rechteck";
      body.classList.add("syc-shape-body");
      const textarea = document.createElement("textarea");
      textarea.className = "syc-shape-editor";
      textarea.setAttribute("aria-label", "Formbeschriftung");
      textarea.placeholder = "Text";
      textarea.value = node.label || "";
      textarea.addEventListener("focus", () => this.recordHistory());
      textarea.addEventListener("input", () => {
        node.label = textarea.value;
        this.queueSave();
      });
      body.append(textarea);
    } else if (node.type === "group") {
      card.classList.add("syc-group");
      title.remove();
      const input = document.createElement("input");
      input.className = "syc-group-label";
      input.value = node.label || "Gruppe";
      input.setAttribute("aria-label", "Gruppenname");
      input.addEventListener("focus", () => this.recordHistory());
      input.addEventListener("input", () => {
        node.label = input.value;
        this.queueSave();
      });
      card.querySelector(".syc-card__kind")?.after(input);
      footer.textContent = "Enthaltene Karten bewegen sich mit der Gruppe";
      body.innerHTML = `<span class="syc-group__hint">Karten hier anordnen</span>`;
    } else if (node.type === "canvas") {
      let canvas: CanvasGraph | null = null;
      try {
        canvas = node.canvasRefId ? await this.store.load(node.canvasRefId) : null;
      } catch {
        canvas = null;
      }
      title.textContent = canvas?.name || node.label || "Canvas nicht gefunden";
      node.label = title.textContent;
      footer.textContent = canvas
        ? `${canvas.nodes.length} Karten · ${canvas.edges.length} Verbindungen`
        : "Referenz fehlt";
      body.classList.add("syc-canvas-preview");
      const summary = document.createElement("div");
      summary.className = "syc-canvas-preview__summary";
      const names = canvas?.nodes.slice(0, 6).map((item) => this.nodeDataName(item)).filter(Boolean) || [];
      summary.innerHTML = `<strong>${canvas ? "Enthaltener Canvas" : "Canvas nicht verfügbar"}</strong><span>${escapeHtml(names.join(" · ") || "Noch keine Karten")}</span>`;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "syc-button syc-button--primary syc-canvas-preview__open";
      open.textContent = "Canvas öffnen";
      open.disabled = !canvas || !node.canvasRefId;
      open.addEventListener("click", (event) => {
        event.stopPropagation();
        if (node.canvasRefId) this.openCanvas(node.canvasRefId, title.textContent || node.canvasRefId);
      });
      body.append(summary, open);
      card.addEventListener("dblclick", (event) => {
        if ((event.target as HTMLElement).closest("input, textarea, button")) return;
        event.stopPropagation();
        if (node.canvasRefId && canvas) this.openCanvas(node.canvasRefId, title.textContent || node.canvasRefId);
      });
    } else if (node.type === "link") {
      const url = node.url ? normalizedUrl(node.url) : undefined;
      title.textContent = node.label || (url ? new URL(url).hostname : "Ungültiger Link");
      footer.textContent = url || "Adresse fehlt";
      body.classList.add("syc-media-card");
      if (!url) {
        body.textContent = "Diese Web-Adresse ist ungültig.";
        body.classList.add("syc-card__error");
      } else {
        const kind = mediaType(url);
        if (kind === "image") {
          const image = document.createElement("img");
          image.src = url;
          image.alt = node.label || "Eingebettetes Bild";
          image.loading = "lazy";
          body.append(image);
        } else if (kind === "video") {
          const video = document.createElement("video");
          video.src = url;
          video.controls = true;
          video.preload = "metadata";
          body.append(video);
        } else if (kind === "audio") {
          const audio = document.createElement("audio");
          audio.src = url;
          audio.controls = true;
          body.append(audio);
        } else {
          const frame = document.createElement("iframe");
          frame.src = embeddedUrl(url);
          frame.loading = "lazy";
          frame.referrerPolicy = "no-referrer";
          frame.title = node.label || "Web-Inhalt";
          body.append(frame);
        }
        const open = document.createElement("a");
        open.className = "syc-media-card__open";
        open.href = url;
        open.target = "_blank";
        open.rel = "noreferrer";
        open.textContent = "↗ Öffnen";
        body.append(open);
      }
    } else if (node.type === "text") {
      title.textContent = "Freie Textkarte";
      footer.textContent = "Nur im Canvas gespeichert";
      const textarea = document.createElement("textarea");
      textarea.className = "syc-text-editor";
      textarea.placeholder = "Schreibe direkt auf die Karte …";
      textarea.value = node.markdown || "";
      textarea.addEventListener("focus", () => this.recordHistory());
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
      if ((event.target as HTMLElement).closest(".syc-card__header, .syc-resize") || node.type === "shape") return;
      if (event.shiftKey) this.selectNode(node.id, true);
      else if (!this.selectedNodes.has(node.id)) this.selectNode(node.id);
    });

    const dragHandle = card.querySelector<HTMLElement>(node.type === "shape" ? ".syc-card__body" : ".syc-card__header")!;
    dragHandle.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) this.selectNode(node.id, true);
      else if (!this.selectedNodes.has(node.id)) this.selectNode(node.id);
      if (!this.selectedNodes.has(node.id)) return;
      this.interaction = {
        type: "move",
        nodeId: node.id,
        startX: event.clientX,
        startY: event.clientY,
        origins: this.movementNodes().map((member) => ({ id: member.id, x: member.x, y: member.y })),
        before: this.serializeGraph(),
      };
      this.viewport().setPointerCapture(event.pointerId);
    });

    card.querySelector<HTMLElement>(".syc-resize")!.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.selectedNodes.has(node.id)) this.selectNode(node.id);
      this.interaction = {
        type: "resize",
        nodeId: node.id,
        startX: event.clientX,
        startY: event.clientY,
        width: node.width,
        height: node.height,
        before: this.serializeGraph(),
      };
      this.viewport().setPointerCapture(event.pointerId);
    });

    card.querySelector<HTMLElement>(".syc-card__menu")!.addEventListener("click", (event) => {
      event.stopPropagation();
      this.selectNode(node.id);
      this.deleteSelection();
    });

  }

  private movementNodes() {
    const ids = new Set(this.selectedNodes);
    this.graph.nodes.filter((node) => this.selectedNodes.has(node.id) && node.type === "group")
      .forEach((group) => this.groupMembers(group).forEach((member) => ids.add(member.id)));
    return this.graph.nodes.filter((node) => ids.has(node.id));
  }

  private selectNode(id: string, additive = false) {
    if (additive) {
      if (this.selectedNodes.has(id)) this.selectedNodes.delete(id);
      else this.selectedNodes.add(id);
    } else {
      this.selectedNodes = new Set([id]);
    }
    this.selectedNode = this.selectedNodes.has(id) ? id : [...this.selectedNodes].at(-1);
    this.selectedEdge = undefined;
    this.refreshSelection();
  }

  private selectNodes(ids: string[]) {
    this.selectedNodes = new Set(ids.filter((id) => this.graph.nodes.some((node) => node.id === id)));
    this.selectedNode = [...this.selectedNodes].at(-1);
    this.selectedEdge = undefined;
    this.refreshSelection();
  }

  private selectEdge(id: string) {
    this.selectedEdge = id;
    this.selectedNode = undefined;
    this.selectedNodes.clear();
    this.refreshSelection();
    this.refreshConnections();
  }

  private clearSelection() {
    this.selectedNode = undefined;
    this.selectedNodes.clear();
    this.selectedEdge = undefined;
    this.refreshSelection();
    this.refreshConnections();
  }

  private refreshSelection() {
    this.element.querySelectorAll<HTMLElement>(".syc-card").forEach((card) => {
      card.classList.toggle("is-selected", this.selectedNodes.has(card.dataset.nodeId || ""));
    });
    const deleteButton = this.element.querySelector<HTMLButtonElement>("[data-action='delete']")!;
    deleteButton.disabled = !this.selectedNodes.size && !this.selectedEdge;
    this.element.querySelectorAll<HTMLButtonElement>("[data-requires-node]").forEach((button) => {
      button.disabled = !this.selectedNodes.size;
    });
    this.element.querySelectorAll<HTMLButtonElement>("[data-requires-selection]").forEach((button) => {
      button.disabled = !this.selectedNodes.size && !this.selectedEdge;
    });
    this.element.querySelectorAll<HTMLButtonElement>("[data-requires-edge]").forEach((button) => {
      button.disabled = !this.selectedEdge;
    });
    this.element.querySelectorAll<HTMLButtonElement>("[data-requires-multi]").forEach((button) => {
      button.disabled = this.selectedNodes.size < 2;
    });
    this.element.querySelectorAll<HTMLButtonElement>("[data-requires-three]").forEach((button) => {
      button.disabled = this.selectedNodes.size < 3;
    });
    if (!this.selectedNodes.size && !this.selectedEdge) {
      this.element.querySelector("[data-role='color-menu']")?.classList.add("is-hidden");
    }
    const bar = this.element.querySelector<HTMLElement>("[data-role='selection-bar']")!;
    bar.classList.toggle("is-hidden", this.selectedNodes.size === 0);
    this.element.querySelector<HTMLElement>("[data-role='selection-count']")!.textContent = `${this.selectedNodes.size} ausgewählt`;
    this.positionSelectionBar();
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
      this.recordHistory();
      const edgeId = this.selectedEdge;
      const connection = this.connections.get(this.selectedEdge);
      this.syncingConnections = true;
      if (connection) this.plumbing?.deleteConnection(connection);
      this.syncingConnections = false;
      this.connections.delete(edgeId);
      this.graph.edges = this.graph.edges.filter((edge) => edge.id !== edgeId);
      this.selectedEdge = undefined;
    } else if (this.selectedNodes.size) {
      this.recordHistory();
      const ids = new Set(this.selectedNodes);
      this.syncingConnections = true;
      ids.forEach((id) => {
        (this.protyles.get(id) as any)?.destroy?.();
        this.protyles.delete(id);
        const card = this.card(id);
        if (card && card.hasAttribute("data-jtk-managed")) this.plumbing?.unmanage(card, true);
        else card?.remove();
      });
      this.syncingConnections = false;
      this.graph.nodes = this.graph.nodes.filter((node) => !ids.has(node.id));
      this.graph.edges = this.graph.edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
      this.selectedNode = undefined;
      this.selectedNodes.clear();
      this.renderConnectionsFresh();
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
      const connection = this.plumbing.connect({ source, target, connector: this.edgeConnector(edge.style) });
      if (!connection) continue;
      connection.setParameter("edgeId", edge.id);
      this.connections.set(edge.id, connection);
      this.configureConnection(connection, edge);
    }
    this.syncingConnections = false;
    this.refreshConnections();
  }

  private renderConnectionsFresh() {
    if (!this.plumbing) return;
    this.syncingConnections = true;
    this.plumbing.deleteEveryConnection();
    this.connections.clear();
    this.syncingConnections = false;
    this.renderConnections();
  }

  private onConnectionCreated(info: { connection: Connection; sourceId: string; targetId: string }) {
    if (this.syncingConnections) return;
    const { connection } = info;
    const source = this.connectionNodeId(connection.source, info.sourceId);
    const target = this.connectionNodeId(connection.target, info.targetId);
    if (!source || !target || source === target) {
      this.syncingConnections = true;
      this.plumbing?.deleteConnection(connection);
      this.syncingConnections = false;
      return;
    }
    this.recordHistory();
    const edge: CanvasEdge = { id: newId("edge"), source, target, label: "", color: "default", style: "bezier", directed: true };
    connection.setParameter("edgeId", edge.id);
    this.graph.edges.push(edge);
    this.connections.set(edge.id, connection);
    this.configureConnection(connection, edge);
    this.selectEdge(edge.id);
    this.openEdgeDialog(edge.id);
    this.cancelLinkMode();
    this.queueSave();
  }

  private connectionNodeId(element: unknown, fallbackId: string) {
    const candidate = element instanceof Element ? element : document.getElementById(fallbackId);
    return candidate?.closest<HTMLElement>(".syc-card")?.dataset.nodeId
      || this.card(fallbackId)?.dataset.nodeId;
  }

  private onConnectionDetached(connection: Connection) {
    if (this.syncingConnections) return;
    const edgeId = connection.getParameter("edgeId") as string;
    if (!edgeId) return;
    this.recordHistory();
    this.connections.delete(edgeId);
    this.graph.edges = this.graph.edges.filter((edge) => edge.id !== edgeId);
    if (this.selectedEdge === edgeId) this.selectedEdge = undefined;
    this.refreshSelection();
    this.queueSave();
  }

  private refreshConnections() {
    this.connections.forEach((connection, id) => {
      const edge = this.graph.edges.find((item) => item.id === id);
      if (!edge) return;
      this.configureConnection(connection, edge);
      const color = edge?.color || "default";
      const stroke = COLOR_VALUES[color]
        || (/^#[0-9a-f]{6}$/i.test(color) ? color : "")
        || getComputedStyle(this.element).getPropertyValue("--syc-accent").trim()
        || "#888";
      connection.setPaintStyle({
        stroke,
        strokeWidth: id === this.selectedEdge ? 3 : 2,
        outlineStroke: "transparent",
        outlineWidth: 8,
      });
      connection.removeClass("syc-connection-selected");
      if (id === this.selectedEdge) connection.addClass("syc-connection-selected");
    });
  }

  private configureConnection(connection: Connection, edge: CanvasEdge) {
    connection.setLabel(edge.label || "");
    if (!connection.getOverlay("syc-arrow")) {
      this.plumbing?.addOverlay(connection, {
        type: "Arrow",
        options: { id: "syc-arrow", location: 1, width: 14, length: 14, foldback: 0.72 },
      });
    }
  }

  private edgeConnector(style: EdgeStyle = "bezier") {
    if (style === "straight") return { type: "Straight", options: {} } as const;
    if (style === "orthogonal") return { type: "Flowchart", options: { cornerRadius: 8, stub: 24 } } as const;
    return { type: "Bezier", options: { curviness: 72 } } as const;
  }

  private openEdgeDialog(edgeId: string) {
    const edge = this.graph.edges.find((item) => item.id === edgeId);
    if (!edge) return;
    this.selectedEdge = edgeId;
    this.refreshSelection();
    this.element.querySelector<HTMLElement>("[data-role='edge-dialog']")!.classList.remove("is-hidden");
    const input = this.element.querySelector<HTMLInputElement>("[data-role='edge-label']")!;
    const source = this.element.querySelector<HTMLSelectElement>("[data-role='edge-source']")!;
    const target = this.element.querySelector<HTMLSelectElement>("[data-role='edge-target']")!;
    const style = this.element.querySelector<HTMLSelectElement>("[data-role='edge-style']")!;
    source.innerHTML = "";
    target.innerHTML = "";
    this.graph.nodes.forEach((node) => {
      const sourceOption = document.createElement("option");
      sourceOption.value = node.id;
      sourceOption.textContent = this.nodeDisplayName(node);
      source.append(sourceOption);
      target.append(sourceOption.cloneNode(true));
    });
    input.value = edge.label || "";
    source.value = edge.source;
    target.value = edge.target;
    style.value = edge.style || "bezier";
    window.setTimeout(() => input.focus(), 0);
  }

  private closeEdgeDialog() {
    this.element.querySelector("[data-role='edge-dialog']")?.classList.add("is-hidden");
  }

  private saveEdgeLabel() {
    const edge = this.graph.edges.find((item) => item.id === this.selectedEdge);
    if (!edge) return this.closeEdgeDialog();
    const source = this.element.querySelector<HTMLSelectElement>("[data-role='edge-source']")!.value;
    const target = this.element.querySelector<HTMLSelectElement>("[data-role='edge-target']")!.value;
    if (!source || !target || source === target) {
      showMessage("Quelle und Ziel müssen unterschiedliche Karten sein.");
      return;
    }
    this.recordHistory();
    edge.label = this.element.querySelector<HTMLInputElement>("[data-role='edge-label']")!.value.trim();
    edge.style = this.element.querySelector<HTMLSelectElement>("[data-role='edge-style']")!.value as EdgeStyle;
    const endpointsChanged = edge.source !== source || edge.target !== target;
    edge.source = source;
    edge.target = target;
    const connection = this.connections.get(edge.id);
    connection?.setLabel(edge.label);
    if (connection) this.plumbing?.select({ connections: [connection] }).setConnector(this.edgeConnector(edge.style));
    if (connection) this.plumbing?.revalidate(connection.source);
    this.plumbing?.repaintEverything();
    if (endpointsChanged) this.renderConnectionsFresh();
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
    this.positionSelectionBar();
  }

  private positionCard(node: CanvasNode) {
    const card = this.card(node.id);
    if (!card) return;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${node.width}px`;
    card.style.height = `${node.height}px`;
  }

  private applyCardColor(card: HTMLElement, color: CardColor) {
    const custom = /^#[0-9a-f]{6}$/i.test(color);
    card.dataset.color = custom ? "custom" : color;
    if (custom) card.style.setProperty("--syc-card-tint", color);
    else card.style.removeProperty("--syc-card-tint");
  }

  private nextPosition(): Point {
    const offset = (this.graph.nodes.length % 7) * 28;
    const center = this.toWorld(this.viewport().clientWidth / 2, this.viewport().clientHeight / 2);
    return { x: center.x - 180 + offset, y: center.y - 130 + offset };
  }

  private nextGroupPosition(): Point {
    const latestGroup = this.graph.nodes.find((node) => node.type === "group");
    if (latestGroup) {
      return { x: latestGroup.x + latestGroup.width + 60, y: latestGroup.y };
    }
    const position = this.nextPosition();
    return { x: position.x - 100, y: position.y - 80 };
  }

  private toWorld(x: number, y: number): Point {
    return { x: (x - this.pan.x) / this.scale, y: (y - this.pan.y) / this.scale };
  }

  private serializeGraph() {
    return JSON.stringify(this.graph);
  }

  private recordHistory() {
    this.pushHistorySnapshot(this.serializeGraph());
  }

  private commitHistorySnapshot(before: string) {
    if (before !== this.serializeGraph()) this.pushHistorySnapshot(before);
  }

  private pushHistorySnapshot(snapshot: string) {
    if (this.undoStack.at(-1) !== snapshot) {
      this.undoStack.push(snapshot);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.refreshHistoryButtons();
  }

  private async undo() {
    const current = this.serializeGraph();
    let snapshot = this.undoStack.pop();
    while (snapshot === current) snapshot = this.undoStack.pop();
    if (!snapshot) {
      this.refreshHistoryButtons();
      return;
    }
    this.redoStack.push(current);
    await this.restoreSnapshot(snapshot);
  }

  private async redo() {
    const current = this.serializeGraph();
    let snapshot = this.redoStack.pop();
    while (snapshot === current) snapshot = this.redoStack.pop();
    if (!snapshot) {
      this.refreshHistoryButtons();
      return;
    }
    this.undoStack.push(current);
    await this.restoreSnapshot(snapshot);
  }

  private async restoreSnapshot(snapshot: string) {
    this.graph = JSON.parse(snapshot) as CanvasGraph;
    this.clearSelection();
    this.element.querySelector<HTMLInputElement>("[data-role='canvas-name']")!.value = this.graph.name;
    await this.renderNodes();
    this.updateEmptyState();
    this.refreshHistoryButtons();
    await this.save(false);
  }

  private refreshHistoryButtons() {
    const undo = this.element.querySelector<HTMLButtonElement>("[data-role='undo']");
    const redo = this.element.querySelector<HTMLButtonElement>("[data-role='redo']");
    if (undo) undo.disabled = this.undoStack.length === 0;
    if (redo) redo.disabled = this.redoStack.length === 0;
  }

  private positionSelectionBar() {
    const bar = this.element.querySelector<HTMLElement>("[data-role='selection-bar']");
    if (!bar || !this.selectedNodes.size) return;
    const nodes = this.graph.nodes.filter((node) => this.selectedNodes.has(node.id));
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const viewport = this.viewport();
    const left = this.pan.x + ((minX + maxX) / 2) * this.scale;
    const top = viewport.offsetTop + this.pan.y + minY * this.scale;
    bar.style.left = `${Math.max(100, Math.min(viewport.clientWidth - 100, left))}px`;
    bar.style.top = `${Math.max(viewport.offsetTop + 10, top)}px`;
  }

  private positionColorMenu() {
    const menu = this.element.querySelector<HTMLElement>("[data-role='color-menu']");
    const bar = this.element.querySelector<HTMLElement>("[data-role='selection-bar']");
    if (!menu || !bar || menu.classList.contains("is-hidden")) return;
    menu.style.left = `${Math.max(8, bar.offsetLeft - menu.offsetWidth / 2)}px`;
    menu.style.top = `${Math.max(50, bar.offsetTop + 6)}px`;
  }

  private nodeDisplayName(node: CanvasNode) {
    const visible = this.card(node.id)?.querySelector<HTMLElement>(".syc-card__title")?.textContent?.trim();
    if (visible) return visible;
    return this.nodeDataName(node);
  }

  private nodeDataName(node: CanvasNode) {
    if (node.type === "shape" || node.type === "group") return node.label || "Unbenannt";
    if (node.type === "text") return (node.markdown || "Textkarte").slice(0, 48);
    if (node.type === "canvas") return node.label || "Canvas";
    if (node.type === "link") return node.label || node.url || "Web/Media";
    return node.type === "document" ? `Dokument ${node.docId || ""}` : `Block ${node.blockId || ""}`;
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
  private registeredTabTypes = new Set<string>();

  onload() {
    this.addIcons(`<symbol id="iconSiYuanCanvas" viewBox="0 0 32 32"><path d="M5 7h9v9H5zM18 16h9v9h-9zM14 11l4 5M14 16l4 4" fill="none" stroke="currentColor" stroke-width="2"/></symbol>`);
    this.registerCanvasTab(this.tabType);
    void this.registerStoredCanvasTabs();
  }

  private canvasTabType(canvasId: string) {
    return `${this.tabType}${canvasId}`;
  }

  private registerCanvasTab(type: string) {
    if (this.registeredTabTypes.has(type)) return;
    const plugin = this;
    this.addTab({
      type,
      init(this: any) {
        const canvasId = this.data?.canvasId || `canvas-${Date.now()}`;
        const canvasName = this.data?.canvasName || "Unbenannter Canvas";
        const element = this.element as HTMLElement | undefined;
        if (!element) {
          console.error("SiYuan Canvas: Tab-Element fehlt", { canvasId, type });
          return;
        }
        new CanvasView(plugin.app, element, canvasId, plugin.store, (id, name) => plugin.open(id, name), canvasName).init().catch((error) => {
          console.error("SiYuan Canvas konnte nicht initialisiert werden", error);
          element.innerHTML = `<div class="syc-error">Canvas konnte nicht geladen werden: ${String(error)}</div>`;
        });
      },
    });
    this.registeredTabTypes.add(type);
  }

  private async registerStoredCanvasTabs() {
    try {
      const known = await this.store.list();
      known.forEach((canvas) => this.registerCanvasTab(this.canvasTabType(canvas.id)));
    } catch (error) {
      console.error("SiYuan Canvas: Gespeicherte Canvas-Tabs konnten nicht registriert werden", error);
    }
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
    const rows = known.map((item) => {
      const updated = new Date(item.updatedAt);
      const date = Number.isNaN(updated.getTime()) ? "" : updated.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
      return `<div class="syc-manager__row" data-canvas-id="${escapeHtml(item.id)}">
        <div class="syc-manager__file">
          <input class="b3-text-field syc-manager__name" maxlength="80" value="${escapeHtml(item.name || item.id)}" aria-label="Canvas-Name">
          <small>${escapeHtml(date || item.id)}</small>
        </div>
        <button class="b3-button b3-button--outline" data-action="manager-open">Öffnen</button>
        <button class="b3-button b3-button--outline" data-action="manager-rename">Speichern</button>
        <button class="b3-button b3-button--cancel syc-manager__delete" data-action="manager-delete">Löschen</button>
      </div>`;
    }).join("");
    const dialog = new Dialog({
      title: "Canvas verwalten",
      width: "720px",
      content: `<div class="b3-dialog__content syc-manager">
        <form class="syc-manager__create" data-role="manager-create">
          <input class="b3-text-field" data-role="manager-new-name" maxlength="80" value="Neuer Canvas" aria-label="Name des neuen Canvas">
          <button class="b3-button b3-button--text" type="submit">＋ Erstellen</button>
        </form>
        <div class="syc-manager__hint">Canvas öffnen, umbenennen oder dauerhaft löschen. Geöffnete Canvas-Tabs vor dem Löschen schließen.</div>
        <div class="syc-manager__list" data-role="manager-list">${rows || '<div class="syc-manager__empty">Noch keine Canvas-Dateien vorhanden.</div>'}</div>
      </div>`,
    });
    const createForm = dialog.element.querySelector<HTMLFormElement>("[data-role='manager-create']")!;
    createForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = dialog.element.querySelector<HTMLInputElement>("[data-role='manager-new-name']")!.value.trim();
      if (!name) return;
      dialog.destroy();
      this.open(`canvas-${Date.now()}`, name);
    });
    dialog.element.addEventListener("click", async (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
      const row = button?.closest<HTMLElement>(".syc-manager__row");
      if (!button || !row) return;
      const id = row.dataset.canvasId!;
      const input = row.querySelector<HTMLInputElement>(".syc-manager__name")!;
      const name = input.value.trim();
      if (button.dataset.action === "manager-open") {
        dialog.destroy();
        this.open(id, name || "Unbenannter Canvas");
        return;
      }
      if (button.dataset.action === "manager-rename") {
        if (!name) return showMessage("Der Canvas-Name darf nicht leer sein");
        try {
          await this.store.rename(id, name);
          button.textContent = "Gespeichert";
          window.setTimeout(() => { button.textContent = "Speichern"; }, 1400);
        } catch (error) {
          showMessage(`Canvas konnte nicht umbenannt werden: ${String(error)}`);
        }
        return;
      }
      if (button.dataset.action === "manager-delete") {
        if (button.dataset.confirm !== "true") {
          button.dataset.confirm = "true";
          button.textContent = "Wirklich löschen?";
          window.setTimeout(() => {
            if (!button.isConnected) return;
            button.dataset.confirm = "false";
            button.textContent = "Löschen";
          }, 4000);
          return;
        }
        try {
          await this.store.remove(id);
          row.remove();
          const list = dialog.element.querySelector<HTMLElement>("[data-role='manager-list']")!;
          if (!list.querySelector(".syc-manager__row")) list.innerHTML = '<div class="syc-manager__empty">Noch keine Canvas-Dateien vorhanden.</div>';
          showMessage("Canvas gelöscht");
        } catch (error) {
          showMessage(`Canvas konnte nicht gelöscht werden: ${String(error)}`);
        }
      }
    });
  }

  private open(canvasId: string, canvasName: string) {
    const type = this.canvasTabType(canvasId);
    this.registerCanvasTab(type);
    openTab({
      app: this.app,
      custom: {
        icon: "iconSiYuanCanvas",
        title: canvasName,
        data: { canvasId, canvasName },
        id: `${this.name}${type}`,
      },
    });
  }
}
