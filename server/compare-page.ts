// DT-6.17: the deck compare page. A pure function from the page's data to one self-contained HTML document: no library, no
// web font, no request of any kind, so the file opens anywhere and can be passed around (ISC-136). Everything except the
// trigger graph is drawn here as plain HTML; the graph needs the page's width and a selection, so a small script draws it
// from the data block. All text goes through esc() or textContent, and the data block escapes `<`, so a card name, a plan
// or a note can never become markup (ISC-139). There is no date or random value in the output: same data, same bytes (ISC-137).

/** Marks a page this tool wrote, so a later run may replace it and nothing else (ISC-138). */
export const PAGE_GENERATOR = "mtg-deck-tune deck compare";

export type PageRow = { card: string; note?: string; conditional?: boolean; /** Added by Claude, not read from the card data. */ mine: boolean; before: boolean; after: boolean };
export type PageTrigger = { name: string; about?: string; causes: PageRow[]; payoffs: PageRow[] };
export type PageNumbers = { averageManaValue: number; lands: number; curve: Record<string, number>; roleCounts: Record<string, number>; pipLoad: Record<string, number>; onPlan: { onPlan: number; of: number } | null; links: number };
export type PageChange = { out?: string; in?: string; commander?: boolean };
export type PageCard = { manaValue: number; typeLine: string; oracleText: string };
export type PageData = {
  commander: string;
  plan: string | null;
  summary: string | null;
  /** False: one version of the deck, no switch (ISC-131). */
  compare: boolean;
  changes: PageChange[];
  /** Cards in the after deck only, and in the before deck only: the two lists compared, so a card swapped out and back is neither. */
  added: string[];
  cut: string[];
  numbers: { before: PageNumbers | null; after: PageNumbers };
  triggers: PageTrigger[];
  cards: Record<string, PageCard>;
};

export const connections = (t: PageTrigger, version: "before" | "after") => t.causes.filter((r) => r[version]).length + t.payoffs.filter((r) => r[version]).length;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const PIPS: Record<string, string> = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
const STYLE = String.raw`
:root{color-scheme:light;--bg:#F5F1E8;--card:#FFFDF8;--line:#DDD5C5;--outline:#A79C88;--ink:#2B2620;--strong:#15120E;--muted:#6A6152;--before:#A79C88;--after:#2F6F8F;--up:#1F7A4D;--down:#B23A36;
--h0:#2a78d6;--h1:#eb6834;--h2:#1baf7a;--h3:#eda100;--h4:#e87ba4;--h5:#008300;--h6:#6250d6;--h7:#e34948}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#1A1815;--card:#24211D;--line:#3A352E;--outline:#7A7061;--ink:#DDD6C8;--strong:#F3EEE3;--muted:#A89E8D;--before:#7A7061;--after:#6FB3D2;--up:#62C592;--down:#EE8580;
--h0:#3987e5;--h1:#d95926;--h2:#199e70;--h3:#c98500;--h4:#d55181;--h5:#008300;--h6:#9085e9;--h7:#e66767}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:32px 16px 56px;display:grid;gap:22px}
.wrap>*{min-width:0}
h1,h2,h3{font-family:ui-serif,Georgia,"Times New Roman",serif;color:var(--strong);margin:0;line-height:1.15}
h1{font-size:40px;overflow-wrap:anywhere}h2{font-size:24px}h3{font-size:18px}p{margin:0}
.kicker{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.lede{margin-top:8px;max-width:72ch}.lede b{color:var(--strong)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;min-width:0}
.panel>h2{margin-bottom:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
.stat b{display:block;font-family:ui-serif,Georgia,serif;font-size:28px;font-weight:600;color:var(--strong);font-variant-numeric:tabular-nums;line-height:1.2}
.stat b{white-space:nowrap}.stat b i{font-style:normal;color:var(--muted);font-weight:400;font-size:.68em}
.stat small{font-size:13px;color:var(--muted)}
.changes{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:6px 24px}
.changes .o{color:var(--down)}.changes .n{color:var(--up)}.changes i{font-style:normal;color:var(--muted)}
.two{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:22px;align-items:start}
.curve{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px}
.col{display:grid;gap:4px}
.bars{height:240px;padding-top:20px;display:flex;align-items:flex-end;justify-content:center;gap:2px;border-bottom:1px solid var(--outline)}
.bar{position:relative;flex:0 1 20px;border-radius:4px 4px 0 0;min-width:0}
.bar.b{background:var(--before)}.bar.a{background:var(--after)}
.bar span{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);font-size:12px;color:var(--ink);font-variant-numeric:tabular-nums}
.tick{text-align:center;font-size:13px;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted);align-items:center}
.legend span{display:inline-flex;align-items:center;gap:7px}
.key{width:12px;height:12px;border-radius:3px;display:inline-block}
.key.b{background:var(--before)}.key.a{background:var(--after)}
.line{width:26px;border-top:2px solid var(--muted);display:inline-block}.line.dash{border-top-style:dashed}
.curve-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;margin-bottom:12px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:5px 0;text-align:right;border-bottom:1px solid var(--line);font-size:14px}
th{font-size:12px;font-weight:500;color:var(--muted)}
th:first-child,td:first-child{text-align:left}
tr.gap td{padding-top:14px;font-size:12px;color:var(--muted);border-bottom-color:var(--outline)}
.up{color:var(--up);font-weight:600}.down{color:var(--down);font-weight:600}.same{color:var(--muted)}
.bar-row{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between}
.seg{display:inline-flex;border:1px solid var(--outline);border-radius:7px;overflow:hidden;background:var(--card)}
.seg button{font:500 14px system-ui,sans-serif;padding:8px 20px;border:0;background:transparent;color:var(--ink);cursor:pointer}
.seg button[aria-pressed=true]{background:var(--strong);color:var(--card)}
.seg button:focus-visible,g[role=button]:focus-visible,summary:focus-visible{outline:2px solid var(--after);outline-offset:2px}
.detail{min-height:210px}.detail ul{margin:6px 0 0;padding-left:18px;display:grid;gap:3px}.detail .rules{white-space:pre-line;margin-top:6px}
.graph{background:var(--card);border:1px solid var(--line);border-radius:10px}
svg{display:block;width:100%;height:auto}
.colhead{font-size:11px;letter-spacing:.08em;fill:var(--muted)}
.node rect{fill:var(--bg);stroke:var(--line)}.node text{font-size:13px;fill:var(--ink)}
.hub rect{fill:var(--card);stroke:var(--outline)}.hub .hn{font-family:ui-serif,Georgia,serif;font-size:16px;font-weight:600;fill:var(--strong)}.hub .hc{font-size:11.5px;fill:var(--muted)}
g[role=button]{cursor:pointer}
.edge{fill:none;stroke-width:1.5;opacity:.7}.edge.cond{stroke-dasharray:5 4}
.dim{opacity:.12}.edge.hot{opacity:1;stroke-width:2.4}.node.hot rect,.hub.hot rect{stroke:var(--strong);stroke-width:1.5}
.hubs{columns:2;column-gap:12px}
.hubc{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--hue);border-radius:10px;padding:14px 16px;display:grid;gap:8px;align-content:start;min-width:0;break-inside:avoid;margin-bottom:12px}
.hubc .top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.hubc .n{font-size:13px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.sub{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:2px}
details{border-top:1px solid var(--line)}details:first-of-type{border-top:0}
summary{cursor:pointer;padding:4px 0;font-size:14px;overflow-wrap:anywhere}
details>div{padding:0 0 8px;font-size:14px}.rules{white-space:pre-line}.type{color:var(--muted);font-size:13px}
.tag{font-size:11px;padding:0 6px;border-radius:9px;border:1px solid currentColor;margin-left:6px;white-space:nowrap}
.tag.added{color:var(--up)}.tag.cut{color:var(--down)}.tag.read,.tag.cond{color:var(--muted)}
.none{font-size:14px;color:var(--muted)}
.foot{font-size:13px;color:var(--muted);max-width:80ch}
body[data-mode=after] [data-v=b],body[data-mode=before] [data-v=a]{display:none}
body[data-mode=before] .only-after,body[data-mode=after] .only-before{display:none}
@media (max-width:859px){.graph,.detail{display:none}.hubs{columns:1}.two{grid-template-columns:minmax(0,1fr)}h1{font-size:32px}}
@media (max-width:519px){.stat b i{display:block}}
`;

// The browser script: the before/after switch, and the trigger graph (three columns: cards that cause a trigger, the trigger,
// cards that pay it off), which sorts each card by the mean position of its triggers so the lines cross less.
const SCRIPT = String.raw`
const D=JSON.parse(document.getElementById("deck-data").textContent);
const NS="http://www.w3.org/2000/svg";let mode="after",sel=null;
const $=id=>document.getElementById(id);
const on=(r)=>r[mode];
function s(t,a,p){const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e}
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
const clip=(x,n)=>x.length>n?x.slice(0,n-1)+"…":x;
function draw(){
  const vis=D.triggers.map((t,i)=>({t,i,causes:t.causes.filter(on),payoffs:t.payoffs.filter(on)}));
  const collect=key=>{const m=new Map();vis.forEach(v=>v[key].forEach(r=>{if(!m.has(r.card))m.set(r.card,[]);m.get(r.card).push(v.i)}));
    return [...m.entries()].map(([n,a])=>({n,a:a.reduce((x,y)=>x+y,0)/a.length})).sort((p,q)=>p.a-q.a||(p.n<q.n?-1:1)).map(x=>x.n)};
  const left=collect("causes"),right=collect("payoffs"),n=vis.length;
  const top=44,rowH=27,avail=Math.max(left.length*rowH,right.length*rowH,n*78),W=1040,H=top+avail+18,nodeW=226,hubW=232,hubH=56,hubX=(W-hubW)/2;
  const g=$("graph");g.textContent="";
  const svg=s("svg",{viewBox:"0 0 "+W+" "+H,role:"group","aria-label":"Cards connected through "+n+" triggers"},g);
  [["CAUSES IT",14,"start"],["TRIGGER",W/2,"middle"],["PAYS IT OFF",W-14,"end"]].forEach(c=>{s("text",{x:c[1],y:26,class:"colhead","text-anchor":c[2]},svg).textContent=c[0]});
  const w=vis.map(v=>Math.max(v.causes.length,v.payoffs.length,2)),sum=w.reduce((a,b)=>a+b,0),slack=avail-n*72;
  let y=top;const hubY=w.map(x=>{const slot=72+slack*x/sum,c=y+slot/2;y+=slot;return c});
  const pos=(list)=>new Map(list.map((c,i)=>[c,top+(i+.5)*avail/list.length]));
  const lp=pos(left),rp=pos(right),edges=s("g",{},svg);
  const line=(x1,y1,x2,y2,r,v)=>{const m=(x1+x2)/2;s("path",{d:"M"+x1+" "+y1+"C"+m+" "+y1+" "+m+" "+y2+" "+x2+" "+y2,class:"edge"+(r.conditional?" cond":""),stroke:"var(--h"+v.i+")","data-card":r.card,"data-hub":v.i},edges)};
  vis.forEach(v=>{v.causes.forEach(r=>line(14+nodeW,lp.get(r.card),hubX,hubY[v.i],r,v));v.payoffs.forEach(r=>line(hubX+hubW,hubY[v.i],W-14-nodeW,rp.get(r.card),r,v))});
  const added=new Set(D.added),cut=new Set(D.cut);
  const node=(name,x,yy)=>{const b=s("g",{class:"node",role:"button",tabindex:0,"data-card":name,"aria-label":name},svg);
    s("rect",{x,y:yy-11,width:nodeW,height:22,rx:4},b);s("title",{},b).textContent=name;s("text",{x:x+10,y:yy+4.5},b).textContent=clip(name,30);
    if(D.compare&&(mode==="after"?added.has(name):cut.has(name)))s("circle",{cx:x+nodeW-11,cy:yy,r:3.5,fill:mode==="after"?"var(--up)":"var(--down)"},b);
    bind(b,{card:name})};
  left.forEach(c=>node(c,14,lp.get(c)));right.forEach(c=>node(c,W-14-nodeW,rp.get(c)));
  vis.forEach(v=>{const yy=hubY[v.i],b=s("g",{class:"hub",role:"button",tabindex:0,"data-hub":v.i,"aria-label":v.t.name},svg);
    s("rect",{x:hubX,y:yy-hubH/2,width:hubW,height:hubH,rx:6},b);s("circle",{cx:hubX+14,cy:yy-9,r:4,fill:"var(--h"+v.i+")"},b);
    s("title",{},b).textContent=v.t.name;s("text",{x:hubX+26,y:yy-3,class:"hn"},b).textContent=clip(v.t.name,24);
    s("text",{x:hubX+26,y:yy+16,class:"hc"},b).textContent=v.causes.length+" cause · "+v.payoffs.length+" pay off";bind(b,{hub:String(v.i)})});
  if(sel&&sel.card&&!D.triggers.some(t=>[...t.causes,...t.payoffs].some(r=>r.card===sel.card&&on(r))))sel=null;
  apply();
}
function bind(g,t){const pick=e=>{e.stopPropagation();sel=(sel&&sel.card===t.card&&sel.hub===t.hub)?null:t;apply()};g.addEventListener("click",pick);g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();pick(e)}})}
function apply(){
  const svg=document.querySelector("#graph svg"),E=[...svg.querySelectorAll(".edge")],N=[...svg.querySelectorAll(".node")],H=[...svg.querySelectorAll(".hub")];
  [...E,...N,...H].forEach(x=>x.classList.remove("dim","hot"));
  if(sel){const m=e=>sel.card?e.dataset.card===sel.card:e.dataset.hub===sel.hub,c=new Set(),h=new Set();
    E.forEach(e=>{if(m(e)){e.classList.add("hot");c.add(e.dataset.card);h.add(e.dataset.hub)}else e.classList.add("dim")});
    N.forEach(n=>n.classList.add(c.has(n.dataset.card)?"hot":"dim"));H.forEach(n=>n.classList.add(h.has(n.dataset.hub)?"hot":"dim"))}
  detail();
}
function detail(){
  const d=$("detail");d.textContent="";
  if(!sel){d.append(el("h3",null,"Trace a connection"),el("p",null,"Select a card or a trigger to see what it is connected to."));return}
  if(sel.hub){const t=D.triggers[+sel.hub];d.append(el("h3",null,t.name));if(t.about)d.append(el("p",null,t.about));d.append(el("p","type",t.causes.filter(on).length+" cards cause it, "+t.payoffs.filter(on).length+" pay it off."));return}
  const f=D.cards[sel.card];d.append(el("h3",null,sel.card));
  if(f)d.append(el("p","type",f.typeLine+" · mana value "+f.manaValue));
  const u=el("ul");const row=(t,r,w)=>{if(r.card===sel.card&&on(r))u.append(el("li",null,w+" “"+t.name+"”"+(r.note?" (my read: "+r.note+")":"")))};
  D.triggers.forEach(t=>{t.causes.forEach(r=>row(t,r,"Causes"));t.payoffs.forEach(r=>row(t,r,"Pays off"))});d.append(u);
  if(f&&f.oracleText)d.append(el("p","rules",f.oracleText));
}
function setMode(m){mode=m;document.body.dataset.mode=m;if($("btn-before")){$("btn-before").setAttribute("aria-pressed",m==="before");$("btn-after").setAttribute("aria-pressed",m==="after")}draw()}
if($("btn-before")){$("btn-before").addEventListener("click",()=>setMode("before"));$("btn-after").addEventListener("click",()=>setMode("after"))}
$("graph").addEventListener("click",()=>{if(sel){sel=null;apply()}});
setMode("after");
`;

function statsHtml(d: PageData): string {
  const { before: b, after: a } = d.numbers;
  const tile = (was: string | null, is: string, label: string) => `<div class="stat"><b>${was === null ? "" : `<i>${esc(was)} → </i>`}${esc(is)}</b><small>${esc(label)}</small></div>`;
  const map = (v: "before" | "after") => String(d.triggers.reduce((n, t) => n + connections(t, v), 0));
  const fit = (n: PageNumbers) => `${n.onPlan!.onPlan}/${n.onPlan!.of}`;
  return [
    tile(b && b.averageManaValue.toFixed(2), a.averageManaValue.toFixed(2), "Average mana value"),
    tile(b && String(b.lands), String(a.lands), "Lands"),
    ...(a.onPlan ? [tile(b?.onPlan ? fit(b) : null, fit(a), "Cards on the plan")] : []),
    tile(b && String(b.links), String(a.links), "All card connections in the deck"),
    tile(b && map("before"), map("after"), "Connections shown on this map"),
  ].join("");
}

function changesHtml(d: PageData): string {
  if (!d.changes.length) return "";
  const items = d.changes.map((c) => {
    const parts = [c.out ? `<span class="o">${esc(c.out)}</span>` : "<i>Added</i>", c.out && c.in ? "<i> → </i>" : c.out ? "<i> cut</i>" : " ", c.in ? `<span class="n">${esc(c.in)}</span>` : ""];
    return `<li>${parts.join("")}${c.commander ? '<i> (commander)</i>' : ""}</li>`;
  });
  return `<section class="panel"><h2>What changed</h2><ul class="changes">${items.join("")}</ul></section>`;
}

function curveHtml(d: PageData): string {
  const { before: b, after: a } = d.numbers;
  const keys = Object.keys(a.curve);
  const top = Math.max(1, ...keys.flatMap((k) => [a.curve[k], b?.curve[k] ?? 0]));
  const bar = (cls: string, n: number, k: string, what: string) => `<div class="bar ${cls}" style="height:${Math.round((n / top) * 100)}%" title="${esc(`Mana value ${k}: ${n} ${what}`)}"><span>${n}</span></div>`;
  const words = keys.map((k) => (b ? `${k}: ${b.curve[k]} before, ${a.curve[k]} after` : `${k}: ${a.curve[k]}`)).join("; ");
  const cols = keys.map((k) => `<div class="col"><div class="bars">${b ? bar("b", b.curve[k], k, "before") : ""}${bar("a", a.curve[k], k, b ? "after" : "cards")}</div><div class="tick">${esc(k)}</div></div>`);
  const legend = b ? '<div class="legend"><span><i class="key b"></i>Before</span><span><i class="key a"></i>After</span></div>' : "";
  return `<section class="panel"><div class="curve-head"><h2>Mana curve</h2>${legend}</div><div class="curve" role="img" aria-label="${esc(`Mana curve by mana value. ${words}`)}">${cols.join("")}</div></section>`;
}

function tableHtml(d: PageData): string {
  const { before: b, after: a } = d.numbers;
  const row = (label: string, was: number | undefined, is: number) => {
    if (!b) return `<tr><td>${esc(label)}</td><td>${is}</td></tr>`;
    const diff = is - (was ?? 0);
    return `<tr><td>${esc(label)}</td><td>${was ?? 0}</td><td>${is}</td><td class="${diff > 0 ? "up" : diff < 0 ? "down" : "same"}">${diff > 0 ? `+${diff}` : diff < 0 ? `−${-diff}` : "0"}</td></tr>`;
  };
  const head = b ? "<tr><th>Role</th><th>Before</th><th>After</th><th>Change</th></tr>" : "<tr><th>Role</th><th>Cards</th></tr>";
  const roles = Object.keys(a.roleCounts).map((r) => row(r.charAt(0).toUpperCase() + r.slice(1), b?.roleCounts[r], a.roleCounts[r]));
  const pips = Object.keys(PIPS).filter((c) => a.pipLoad[c] || b?.pipLoad[c]).map((c) => row(PIPS[c], b?.pipLoad[c], a.pipLoad[c]));
  const gap = pips.length ? `<tr class="gap"><td colspan="${b ? 4 : 2}">Colored mana symbols</td></tr>` : "";
  return `<section class="panel"><h2>Roles</h2><table><thead>${head}</thead><tbody>${roles.join("")}${gap}${pips.join("")}</tbody></table></section>`;
}

function rowHtml(d: PageData, r: PageRow): string {
  const v = !d.compare ? "ab" : r.before && r.after ? "ab" : r.before ? "b" : "a";
  const added = r.after && d.added.includes(r.card);
  const cut = r.before && d.cut.includes(r.card);
  const f = d.cards[r.card];
  const body = [
    r.note ? `<p><b>My read:</b> ${esc(r.note)}</p>` : "",
    f ? `<p class="type">${esc(f.typeLine)} · mana value ${f.manaValue}</p>${f.oracleText ? `<p class="rules">${esc(f.oracleText)}</p>` : ""}` : "",
  ].join("");
  const tags = [added ? '<span class="tag added only-after">added</span>' : "", cut ? '<span class="tag cut only-before">cut</span>' : "", r.mine ? '<span class="tag read">my read</span>' : "", r.conditional ? '<span class="tag cond">needs a condition</span>' : ""].join("");
  return `<details data-v="${v}"><summary>${esc(r.card)}${tags}</summary><div>${body}</div></details>`;
}

function triggerHtml(d: PageData, t: PageTrigger, i: number): string {
  const list = (rows: PageRow[]) => (rows.length ? rows.map((r) => rowHtml(d, r)).join("") : '<p class="none">Nothing here</p>');
  const count = d.compare ? `${connections(t, "before")} → ${connections(t, "after")}` : String(connections(t, "after"));
  return `<article class="hubc" style="--hue:var(--h${i})"><div class="top"><h3>${esc(t.name)}</h3><span class="n">${count}</span></div>${t.about ? `<p>${esc(t.about)}</p>` : ""}` +
    `<div><span class="sub">Causes it</span>${list(t.causes)}</div><div><span class="sub">Pays it off</span>${list(t.payoffs)}</div></article>`;
}

/** The whole page. Same data, same bytes. */
export function comparePage(d: PageData): string {
  const title = `${d.commander} ${d.compare ? "deck compare" : "deck overview"}`;
  const lede = [d.plan ? `<p class="lede"><b>The plan:</b> ${esc(d.plan)}</p>` : "", d.summary ? `<p class="lede"><b>My read:</b> ${esc(d.summary)}</p>` : ""].join("");
  const dataBlock = JSON.stringify(d).replace(/</g, "\\u003c");
  const swtch = d.compare ? '<div class="seg" role="group" aria-label="Choose deck version"><button id="btn-before" type="button">Before</button><button id="btn-after" type="button">After</button></div>' : "<span></span>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="${PAGE_GENERATOR}"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body data-mode="after"><main class="wrap">
<header><span class="kicker">${d.compare ? "Deck compare" : "Deck overview"}</span><h1>${esc(d.commander)}</h1>${lede}</header>
<section class="stats" aria-label="Totals">${statsHtml(d)}</section>
${changesHtml(d)}
<div class="two">${curveHtml(d)}${tableHtml(d)}</div>
<section style="display:grid;gap:12px;min-width:0"><h2>How the deck connects</h2>
<div class="bar-row">${swtch}<div class="legend"><span><i class="line"></i>Always connects</span><span><i class="line dash"></i>Needs a condition</span></div></div>
<section class="panel detail" id="detail" aria-live="polite"></section>
<section class="graph" id="graph" aria-label="Trigger connection graph"></section>
<div class="hubs">${d.triggers.map((t, i) => triggerHtml(d, t, i)).join("")}</div></section>
<p class="foot">The numbers, the rules text and the connections come from the card data. Which triggers are shown, the line describing each one, and anything marked my read are my read of how this deck wins. Cards that work through a lasting effect, such as an anthem or a cost reduction, show no connection unless marked my read.</p>
</main>
<script id="deck-data" type="application/json">${dataBlock}</script>
<script>${SCRIPT}</script></body></html>
`;
}
