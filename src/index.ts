import { Plugin, openTab, showMessage } from "siyuan";
import "./index.css";

type Kind = "document" | "block" | "text";
type Node = { id:string; type:Kind; docId?:string; blockId?:string; markdown?:string; x:number; y:number; width:number; height:number };
type Edge = { id:string; source:string; target:string; label?:string; directed:true };
type Graph = { canvasId:string; schemaVersion:1; nodes:Node[]; edges:Edge[] };
type Index = { id:string; updatedAt:string };
const ROOT = "/data/storage/petal/siyuan-canvas";
const ID = /^[0-9]{14}-[a-z0-9]{7}$/;
const uid = (prefix:string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
const empty = (canvasId:string):Graph => ({canvasId,schemaVersion:1,nodes:[],edges:[]});

async function post<T>(path:string, data:unknown):Promise<T> {
  const res=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  const body=await res.json(); if(!res.ok||body.code!==0) throw Error(body.msg||`Fehler: ${path}`); return body.data as T;
}
async function read<T>(path:string):Promise<T|null> {
  const res=await fetch("/api/file/getFile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path})});
  if(res.status===202) return null; if(!res.ok) throw Error(`Datei konnte nicht geladen werden: ${path}`); return JSON.parse(await res.text()) as T;
}
async function write(path:string, value:unknown) {
  const form=new FormData(); form.append("path",path); form.append("file",new File([JSON.stringify(value,null,2)],path.split("/").pop()!,{type:"application/json"}));
  const res=await fetch("/api/file/putFile",{method:"POST",body:form}); const body=await res.json(); if(!res.ok||body.code!==0) throw Error(body.msg||"Speichern fehlgeschlagen");
}
let directoryReady=false;
async function ensureDirectory(){if(directoryReady)return;const form=new FormData();form.append("path",ROOT);form.append("isDir","true");const res=await fetch("/api/file/putFile",{method:"POST",body:form});const body=await res.json();if(!res.ok||body.code!==0)throw Error(body.msg||"Canvas-Ordner konnte nicht angelegt werden");directoryReady=true;}
class Store {
  load(id:string) { return read<Graph>(`${ROOT}/${id}.json`); }
  async list() { return await read<Index[]>(`${ROOT}/index.json`) || []; }
  async save(graph:Graph) { await ensureDirectory(); await write(`${ROOT}/${graph.canvasId}.json`,graph); const old=await this.list(); await write(`${ROOT}/index.json`,[{id:graph.canvasId,updatedAt:new Date().toISOString()},...old.filter(x=>x.id!==graph.canvasId)]); }
}
async function reference(node:Node) {
  const id=node.type==="document"?node.docId:node.blockId; if(!id) throw Error("Referenz-ID fehlt");
  const content=await post<{kramdown?:string}>("/api/block/getBlockKramdown",{id});
  const rows=await post<Array<{content?:string}>>("/api/query/sql",{stmt:`SELECT content FROM blocks WHERE id = '${id}' LIMIT 1`});
  return {title:rows[0]?.content || (node.type==="document"?"Dokument":"Block"), markdown:content.kramdown||""};
}
async function find(input:string) {
  const sql=ID.test(input)?`SELECT id,type,content FROM blocks WHERE id='${input}' LIMIT 1`:`SELECT id,type,content FROM blocks WHERE content LIKE '%${input.replace(/'/g,"''") }%' ORDER BY updated DESC LIMIT 8`;
  const rows=await post<Array<{id:string;type:string;content?:string}>>("/api/query/sql",{stmt:sql}); if(!rows.length)return null;
  const selected=rows.length===1?rows[0]:rows[(Number(prompt(`Treffer:\n${rows.map((r,i)=>`${i+1}: ${r.content||r.id}`).join("\n")}\n\nNummer:`,"1"))||0)-1];
  return selected && {id:selected.id,type:selected.type==="d"?"document" as const:"block" as const};
}

class CanvasView {
  private graph:Graph=empty(this.canvasId); private scale=.85; private pan={x:80,y:60}; private selected?:string; private linking=false; private linkSource?:string; private timer?:number; private drag?:{id:string;dx:number;dy:number}|{pan:true;x:number;y:number}; private cache=new Map<string,{title:string;markdown:string}>();
  constructor(private element:HTMLElement, private canvasId:string, private store:Store) {}
  async init(){ this.graph=await this.store.load(this.canvasId)||empty(this.canvasId); this.element.innerHTML=`<div class="syc-toolbar"><button data-action="ref">+ Referenz</button><button data-action="text">+ Text</button><button data-action="link">Verbinden</button><button data-action="delete">Löschen</button><span></span><button data-action="save">Canvas speichern</button></div><div class="syc-main"><div class="syc-viewport"><svg class="syc-edges"><defs><marker id="syc-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z"/></marker></defs></svg><div class="syc-world"></div></div><aside class="syc-inspector"><h3>Canvas</h3><p>Karte auswählen, um sie zu bearbeiten.</p></aside></div>`; this.bind(); await this.render(); }
  private bind(){ const root=this.element, view=root.querySelector<HTMLElement>(".syc-viewport")!;
    root.querySelector(".syc-toolbar")!.addEventListener("click",e=>this.action((e.target as HTMLElement).dataset.action));
    view.addEventListener("wheel",e=>{e.preventDefault(); const r=view.getBoundingClientRect(),old=this.scale,next=Math.max(.35,Math.min(2.2,old*(e.deltaY<0?1.12:.89))),mx=e.clientX-r.left,my=e.clientY-r.top; this.pan.x=mx-(mx-this.pan.x)*next/old;this.pan.y=my-(my-this.pan.y)*next/old;this.scale=next;this.render();},{passive:false});
    view.addEventListener("pointerdown",e=>{if(e.target===view||e.target instanceof SVGElement){this.drag={pan:true,x:e.clientX-this.pan.x,y:e.clientY-this.pan.y};view.setPointerCapture(e.pointerId);}});
    view.addEventListener("pointermove",e=>{if(!this.drag)return;if("pan" in this.drag){this.pan={x:e.clientX-this.drag.x,y:e.clientY-this.drag.y};this.render();}else{const n=this.graph.nodes.find(n=>n.id===this.drag!.id)!;n.x=(e.clientX-this.drag.dx-this.pan.x)/this.scale;n.y=(e.clientY-this.drag.dy-this.pan.y)/this.scale;this.render();this.queue();}}); view.addEventListener("pointerup",()=>this.drag=undefined);
    view.addEventListener("dragover",e=>e.preventDefault());view.addEventListener("drop",e=>{e.preventDefault();const id=e.dataTransfer?.getData("text/plain").match(/[0-9]{14}-[a-z0-9]{7}/)?.[0];if(id)this.addRef(id);}); }
  private async action(action?:string){ if(action==="ref"){const q=prompt("Dokument-/Block-ID oder Suchtext:");if(q)await this.addRef(q);} if(action==="text"){this.graph.nodes.push({id:uid("node"),type:"text",markdown:"Neuer Gedanke",x:180,y:160,width:270,height:150});this.queue();this.render();} if(action==="link"){this.linking=true;this.linkSource=undefined;showMessage("Quellkarte und anschließend Zielkarte anklicken.");} if(action==="delete"&&this.selected){this.graph.nodes=this.graph.nodes.filter(n=>n.id!==this.selected);this.graph.edges=this.graph.edges.filter(e=>e.source!==this.selected&&e.target!==this.selected);this.selected=undefined;this.queue();this.render();} if(action==="save")await this.save(); }
  private async addRef(value:string){try{const hit=await find(value);if(!hit){showMessage("Keine Referenz gefunden");return;}this.graph.nodes.push({id:uid("node"),type:hit.type,[hit.type==="document"?"docId":"blockId"]:hit.id,x:200,y:140,width:310,height:190});this.queue();await this.render();}catch(e){showMessage(String(e));}}
  private queue(){clearTimeout(this.timer);this.timer=window.setTimeout(()=>this.save(),600);}
  private async save(){try{await this.store.save(this.graph);showMessage("Canvas gespeichert");}catch(e){showMessage(String(e));}}
  private async render(){const world=this.element.querySelector<HTMLElement>(".syc-world")!,svg=this.element.querySelector<SVGSVGElement>(".syc-edges")!;world.style.transform=`translate(${this.pan.x}px,${this.pan.y}px) scale(${this.scale})`;svg.setAttribute("viewBox",`0 0 ${this.element.clientWidth} ${this.element.clientHeight}`);world.innerHTML=""; const byId=new Map(this.graph.nodes.map(n=>[n.id,n]));svg.querySelectorAll(".syc-edge").forEach(x=>x.remove());
    for(const edge of this.graph.edges){const a=byId.get(edge.source),b=byId.get(edge.target);if(!a||!b)continue;const x1=this.pan.x+(a.x+a.width)*this.scale,y1=this.pan.y+(a.y+a.height/2)*this.scale,x2=this.pan.x+b.x*this.scale,y2=this.pan.y+(b.y+b.height/2)*this.scale;svg.insertAdjacentHTML("beforeend",`<g class="syc-edge"><path d="M${x1} ${y1} C${x1+55} ${y1},${x2-55} ${y2},${x2} ${y2}" marker-end="url(#syc-arrow)"/>${edge.label?`<text x="${(x1+x2)/2}" y="${(y1+y2)/2-7}">${edge.label}</text>`:""}</g>`);}
    for(const node of this.graph.nodes){let data=this.cache.get(node.id);if(!data&&node.type!=="text"){try{data=await reference(node);this.cache.set(node.id,data);}catch{data={title:"Nicht verfügbar",markdown:"Quelle konnte nicht geladen werden."};}}const card=document.createElement("article");card.className=`syc-card ${this.selected===node.id?"selected":""}`;card.style.cssText=`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`;card.innerHTML=`<header>${node.type==="text"?"Text":node.type==="document"?"Dokument":"Block"}</header><strong>${node.type==="text"?"Freie Textkarte":data!.title}</strong><p>${(node.type==="text"?node.markdown:data!.markdown).replace(/\n/g," ").slice(0,220)}</p>`;card.addEventListener("pointerdown",e=>{e.stopPropagation();this.drag={id:node.id,dx:e.clientX-this.pan.x-node.x*this.scale,dy:e.clientY-this.pan.y-node.y*this.scale};});card.addEventListener("click",e=>{e.stopPropagation();this.pick(node.id);});world.append(card);}
    this.inspector(); }
  private pick(id:string){if(this.linking){if(!this.linkSource){this.linkSource=id;showMessage("Jetzt Zielkarte anklicken.");return;}if(this.linkSource!==id)this.graph.edges.push({id:uid("edge"),source:this.linkSource,target:id,label:prompt("Pfeiltext (optional):")||"",directed:true});this.linking=false;this.linkSource=undefined;this.queue();this.render();return;}this.selected=id;this.inspector();}
  private inspector(){const box=this.element.querySelector<HTMLElement>(".syc-inspector")!,node=this.graph.nodes.find(n=>n.id===this.selected);if(!node){box.innerHTML="<h3>Canvas</h3><p>Karte auswählen, um sie zu bearbeiten.</p>";return;}const data=this.cache.get(node.id);box.innerHTML=`<h3>${node.type==="text"?"Textkarte":"Quelle bearbeiten"}</h3><p>${node.type==="text"?"Freier Markdown":"Änderungen werden in SiYuan gespeichert."}</p><textarea>${node.type==="text"?node.markdown||"":data?.markdown||""}</textarea><button>${node.type==="text"?"Text übernehmen":"Quelle speichern"}</button>`;box.querySelector("button")!.onclick=async()=>{const value=box.querySelector("textarea")!.value;try{if(node.type==="text")node.markdown=value;else{await post("/api/block/updateBlock",{id:node.type==="document"?node.docId:node.blockId,dataType:"markdown",data:value});this.cache.set(node.id,{title:data?.title||"Quelle",markdown:value});}this.queue();await this.render();showMessage("Gespeichert");}catch(e){showMessage(String(e));}};}
}
export default class SiYuanCanvas extends Plugin { private store=new Store(); private tabType="siyuan-canvas";
  onload(){this.addIcons(`<symbol id="iconSiYuanCanvas" viewBox="0 0 32 32"><path d="M5 7h9v9H5zM18 16h9v9h-9zM14 11l4 5M14 16l4 4" fill="none" stroke="currentColor" stroke-width="2"/></symbol>`);const store=this.store;this.addTab({type:this.tabType,init(this:any){new CanvasView(this.element,this.data.canvasId,store).init();}});}
  onLayoutReady(){this.addTopBar({icon:"iconSiYuanCanvas",title:"SiYuan Canvas",position:"right",callback:()=>this.openMenu()});}
  private async openMenu(){const known=await this.store.list();const options=["Neuen Canvas erstellen",...known.map(x=>x.id)];const picked=prompt(`Canvas öffnen:\n${options.map((x,i)=>`${i+1}: ${x}`).join("\n")}\n\nNummer:`,"1");const index=(Number(picked)||0)-1;if(index<0||index>=options.length)return;this.open(index===0?`canvas-${Date.now()}`:known[index-1].id);}
  private open(canvasId:string){openTab({app:this.app,custom:{icon:"iconSiYuanCanvas",title:"Canvas",data:{canvasId},id:`${this.name}-${this.tabType}-${canvasId}`}});}
}
