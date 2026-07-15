import { App, Plugin, Protyle, openTab, showMessage } from "siyuan";
import "./index.css";

type NodeKind = "document" | "block" | "text";

interface CanvasNode {
  id: string;
  type: NodeKind;
  docId?: string;
  blockId?: string;
  markdown?: string;
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

type Interaction =
  | { type: "pan"; startX: number; startY: number }
  | { type: "move"; nodeId: string; startX: number; startY: number; originX: number; originY: number }
  | { type: "resize"; nodeId: string; startX: number; startY: number; width: number; height: number };

const STORAGE_ROOT = "/data/storage/petal/siyuan-canvas";
const SIYUAN_ID = /^[0-9]{14}-[a-z0-9]{7}$/;
const SVG_NS = "http://www.w3.org/2000/svg";

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

async function findReference(input: string) {
  const query = input.trim();
  const statement = SIYUAN_ID.test(query)
    ? `SELECT id, type, content FROM blocks WHERE id = '${query}' LIMIT 1`
    : `SELECT id, type, content FROM blocks WHERE content LIKE '%${query.replace(/'/g, "''")}%' ORDER BY updated DESC LIMIT 8`;
  const rows = await kernel<Array<{ id: string; type: string; content?: string }>>(
    "/api/query/sql",
    { stmt: statement },
  );
  if (!rows.length) return null;
  const chosen =
    rows.length === 1
      ? rows[0]
      : rows[
          (Number(
            prompt(
              `Treffer:\n${rows
                .map((row, index) => `${index + 1}: ${row.content || row.id}`)
                .join("\n")}\n\nNummer wählen:`,
              "1",
            ),
          ) || 0) - 1
        ];
  return chosen
    ? {
        id: chosen.id,
        type: chosen.type === "d" ? ("document" as const) : ("block" as const),
      }
    : null;
}

class CanvasView {
  private graph: CanvasGraph;
  private scale = 0.9;
  private pan: Point = { x: 80, y: 60 };
  private selectedNode?: string;
  private selectedEdge?: string;
  private linkMode = false;
  private linkSource?: string;
  private interaction?: Interaction;
  private saveTimer?: number;
  private protyles = new Map<string, Protyle>();
  private markerId: string;

  constructor(
    private app: App,
    private element: HTMLElement,
    private canvasId: string,
    private store: GraphStore,
  ) {
    this.graph = emptyGraph(canvasId);
    this.markerId = `syc-arrow-${canvasId.replace(/[^a-zA-Z0-9-]/g, "")}`;
  }

  async init() {
    this.mount();
    try {
      this.graph = (await this.store.load(this.canvasId)) || emptyGraph(this.canvasId);
    } catch (error) {
      showMessage(`Canvas-Speicher nicht erreichbar: ${String(error)}`);
    }
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
          <button class="syc-button syc-button--danger" data-action="delete" disabled>⌫ Löschen</button>
        </div>
        <div class="syc-toolbar__status" data-role="status">Bereit</div>
        <div class="syc-toolbar__group syc-toolbar__group--right">
          <button class="syc-icon-button" data-action="zoom-out" title="Verkleinern">−</button>
          <button class="syc-zoom" data-action="zoom-reset" title="Zoom zurücksetzen">90%</button>
          <button class="syc-icon-button" data-action="zoom-in" title="Vergrößern">＋</button>
          <button class="syc-button" data-action="save">Speichern</button>
        </div>
      </div>
      <div class="syc-viewport">
        <svg class="syc-edges" aria-hidden="true">
          <defs>
            <marker id="${this.markerId}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L0,6 L9,3 z"></path>
            </marker>
          </defs>
        </svg>
        <div class="syc-world"></div>
        <div class="syc-empty">
          <div class="syc-empty__icon">◇</div>
          <strong>Dein Canvas ist noch leer</strong>
          <span>Füge eine SiYuan-Seite, einen Block oder eine Textkarte hinzu.</span>
          <div><button class="syc-button syc-button--primary" data-action="reference">＋ Referenz</button><button class="syc-button" data-action="text">＋ Text</button></div>
        </div>
      </div>`;
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
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        this.setScale(this.scale * (event.deltaY < 0 ? 1.1 : 0.9), { x: pointerX, y: pointerY });
      },
      { passive: false },
    );

    viewport.addEventListener("pointerdown", (event) => {
      if (event.target === viewport || event.target === this.world() || event.target === this.svg()) {
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
      const value = event.dataTransfer?.getData("text/plain") || "";
      const id = value.match(/[0-9]{14}-[a-z0-9]{7}/)?.[0];
      if (!id) {
        showMessage("Der Drop enthält keine SiYuan-Block-ID.");
        return;
      }
      const rect = viewport.getBoundingClientRect();
      void this.addReference(id, this.toWorld(event.clientX - rect.left, event.clientY - rect.top));
    });

    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.cancelLinkMode();
      if ((event.key === "Delete" || event.key === "Backspace") && !(event.target instanceof HTMLTextAreaElement)) {
        void this.handleAction("delete");
      }
    });

    new ResizeObserver(() => this.renderEdges()).observe(viewport);
  }

  private async handleAction(action: string) {
    if (action === "reference") {
      const query = prompt("Dokument-/Block-ID oder Suchtext:");
      if (query) await this.addReference(query);
    } else if (action === "text") {
      this.addTextNode();
    } else if (action === "link") {
      this.toggleLinkMode();
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
    this.renderEdges();
  }

  private async addReference(value: string, position = this.nextPosition()) {
    try {
      const match = await findReference(value);
      if (!match) {
        showMessage("Keine passende SiYuan-Referenz gefunden.");
        return;
      }
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

  private async renderNodes() {
    this.destroyEditors();
    this.world().innerHTML = "";
    await Promise.all(this.graph.nodes.map((node) => this.appendCard(node)));
    this.renderEdges();
  }

  private async appendCard(node: CanvasNode) {
    const card = document.createElement("article");
    card.className = `syc-card syc-card--${node.type}`;
    card.dataset.nodeId = node.id;
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
      } catch (error) {
        body.textContent = `Quelle konnte nicht geladen werden: ${String(error)}`;
        body.classList.add("syc-card__error");
      }
    }

    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".syc-card__menu")) return;
      if (this.linkMode) {
        event.preventDefault();
        event.stopPropagation();
        this.chooseLinkNode(node.id);
      } else {
        this.selectNode(node.id);
      }
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

    card.querySelectorAll<HTMLElement>(".syc-port").forEach((port) => {
      port.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.linkMode) this.startLinkMode();
        this.chooseLinkNode(node.id);
      });
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
    this.renderEdges();
  }

  private clearSelection() {
    this.selectedNode = undefined;
    this.selectedEdge = undefined;
    this.refreshSelection();
    this.renderEdges();
  }

  private refreshSelection() {
    this.element.querySelectorAll<HTMLElement>(".syc-card").forEach((card) => {
      card.classList.toggle("is-selected", card.dataset.nodeId === this.selectedNode);
      card.classList.toggle("is-link-source", card.dataset.nodeId === this.linkSource);
    });
    const deleteButton = this.element.querySelector<HTMLButtonElement>("[data-action='delete']")!;
    deleteButton.disabled = !this.selectedNode && !this.selectedEdge;
  }

  private toggleLinkMode() {
    if (this.linkMode) this.cancelLinkMode();
    else this.startLinkMode();
  }

  private startLinkMode() {
    this.linkMode = true;
    this.linkSource = undefined;
    this.element.classList.add("is-linking");
    this.element.querySelector("[data-action='link']")?.classList.add("is-active");
    this.setStatus("Verbindung: Quellkarte wählen", true);
    this.refreshSelection();
  }

  private cancelLinkMode() {
    this.linkMode = false;
    this.linkSource = undefined;
    this.element.classList.remove("is-linking");
    this.element.querySelector("[data-action='link']")?.classList.remove("is-active");
    this.setStatus("Bereit");
    this.refreshSelection();
  }

  private chooseLinkNode(id: string) {
    if (!this.linkSource) {
      this.linkSource = id;
      this.setStatus("Verbindung: Zielkarte wählen", true);
      this.refreshSelection();
      return;
    }
    if (this.linkSource === id) {
      showMessage("Quelle und Ziel müssen unterschiedliche Karten sein.");
      return;
    }
    this.graph.edges.push({
      id: newId("edge"),
      source: this.linkSource,
      target: id,
      label: prompt("Pfeiltext (optional):")?.trim() || "",
      directed: true,
    });
    this.cancelLinkMode();
    this.renderEdges();
    this.queueSave();
  }

  private deleteSelection() {
    if (this.selectedEdge) {
      this.graph.edges = this.graph.edges.filter((edge) => edge.id !== this.selectedEdge);
      this.selectedEdge = undefined;
    } else if (this.selectedNode) {
      const id = this.selectedNode;
      (this.protyles.get(id) as any)?.destroy?.();
      this.protyles.delete(id);
      this.graph.nodes = this.graph.nodes.filter((node) => node.id !== id);
      this.graph.edges = this.graph.edges.filter((edge) => edge.source !== id && edge.target !== id);
      this.card(id)?.remove();
      this.selectedNode = undefined;
    }
    this.refreshSelection();
    this.renderEdges();
    this.updateEmptyState();
    this.queueSave();
  }

  private renderEdges() {
    const svg = this.svg();
    const viewport = this.viewport();
    svg.setAttribute("viewBox", `0 0 ${viewport.clientWidth} ${viewport.clientHeight}`);
    svg.querySelectorAll(".syc-edge").forEach((element) => element.remove());
    const nodes = new Map(this.graph.nodes.map((node) => [node.id, node]));

    for (const edge of this.graph.edges) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) continue;
      const geometry = this.edgeGeometry(source, target);
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("syc-edge");
      if (edge.id === this.selectedEdge) group.classList.add("is-selected");
      group.dataset.edgeId = edge.id;

      const hit = document.createElementNS(SVG_NS, "path");
      hit.classList.add("syc-edge__hit");
      hit.setAttribute("d", geometry.path);
      const line = document.createElementNS(SVG_NS, "path");
      line.classList.add("syc-edge__line");
      line.setAttribute("d", geometry.path);
      line.setAttribute("marker-end", `url(#${this.markerId})`);
      group.append(hit, line);

      if (edge.label) {
        const label = document.createElementNS(SVG_NS, "text");
        label.classList.add("syc-edge__label");
        label.setAttribute("x", String(geometry.label.x));
        label.setAttribute("y", String(geometry.label.y));
        label.textContent = edge.label;
        group.append(label);
      }

      group.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectEdge(edge.id);
      });
      group.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        edge.label = prompt("Pfeiltext:", edge.label || "")?.trim() || "";
        this.renderEdges();
        this.queueSave();
      });
      svg.append(group);
    }
  }

  private edgeGeometry(source: CanvasNode, target: CanvasNode) {
    const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;
    let start: Point;
    let end: Point;
    let control1: Point;
    let control2: Point;

    if (Math.abs(dx) >= Math.abs(dy)) {
      start = { x: dx >= 0 ? source.x + source.width : source.x, y: sourceCenter.y };
      end = { x: dx >= 0 ? target.x : target.x + target.width, y: targetCenter.y };
      const bend = Math.max(45, Math.abs(end.x - start.x) * 0.42);
      control1 = { x: start.x + (dx >= 0 ? bend : -bend), y: start.y };
      control2 = { x: end.x - (dx >= 0 ? bend : -bend), y: end.y };
    } else {
      start = { x: sourceCenter.x, y: dy >= 0 ? source.y + source.height : source.y };
      end = { x: targetCenter.x, y: dy >= 0 ? target.y : target.y + target.height };
      const bend = Math.max(45, Math.abs(end.y - start.y) * 0.42);
      control1 = { x: start.x, y: start.y + (dy >= 0 ? bend : -bend) };
      control2 = { x: end.x, y: end.y - (dy >= 0 ? bend : -bend) };
    }

    const screen = (point: Point) => ({
      x: this.pan.x + point.x * this.scale,
      y: this.pan.y + point.y * this.scale,
    });
    const a = screen(start);
    const b = screen(control1);
    const c = screen(control2);
    const d = screen(end);
    return {
      path: `M ${a.x} ${a.y} C ${b.x} ${b.y}, ${c.x} ${c.y}, ${d.x} ${d.y}`,
      label: { x: (a.x + d.x) / 2, y: (a.y + d.y) / 2 - 9 },
    };
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
    this.renderEdges();
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

  private svg() {
    return this.element.querySelector<SVGSVGElement>(".syc-edges")!;
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
