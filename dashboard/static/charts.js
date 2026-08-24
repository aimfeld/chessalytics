(() => {
const NS="http://www.w3.org/2000/svg";
const $=s=>document.querySelector(s);
// Resolve #tip at call time, never at module-evaluation time. Under the React
// host (frontend/src/pages/ActivityPage.tsx) this script is evaluated before
// the page markup is mounted, so an eager `const tip=$("#tip")` binds null for
// the lifetime of the module and every hover throws on `tip.innerHTML`. The
// standalone page loads this after the markup, which is why the eager form
// worked there and would have failed only once hosted.
const tipEl=()=>$("#tip");
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// Degrade to the em-dash placeholder instead of throwing when a date is
// missing. A long-running server process serves the payload it was started
// with, so a newly added key (promoted_since) reads as undefined here until
// the operator restarts — and an unguarded d.split() turned that cosmetic gap
// into a whole-page render failure that fell back to the last snapshot.
const DASH="\u2014";
const short=d=>{if(!d)return DASH;const [y,m,dd]=d.split("-");return (+dd)+" "+MON[+m-1];};
const long=d=>{if(!d)return DASH;const [y,m,dd]=d.split("-");return (+dd)+" "+MON[+m-1]+" "+y;};
const num=n=>n>=10000?(n/1000).toFixed(n>=100000?0:1).replace(/\.0$/,"")+"k":n.toLocaleString("en-US");
const pct=x=>Math.round(x*100)+"%";
// Axis ticks need a formatter distinct from num(): num()'s thousands-comma
// form ("1,000") is wider than the narrow y-axis gutter can hold, and any
// chart whose max reaches four digits — trivially true for the log-scale
// imports axis on an ordinary day — clipped past x=0. Axis ticks always
// compress to a k/M suffix instead; tooltips (which use num() via each
// chart's `fmt` prop) keep full precision.
const axisNum=n=>n>=1e6?(n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,"")+"M"
  :n>=1000?(n/1000).toFixed(n>=10000?0:1).replace(/\.0$/,"")+"k":String(Math.round(n));

/* ---- layout constants (dashboard/check_layout.mjs asserts against these) ----
   Every threshold, gutter and character-width ratio a chart function needs is
   named here rather than inlined at the call site. Widths marked "narrow"
   apply once frame() reports the container is below NARROW_CHART_WIDTH; that
   threshold is measured in CHART pixels and is deliberately independent of
   the CSS breakpoint in styles.css — CSS buys width, this adapts to whatever
   width it is actually handed. */
const MIN_CHART_WIDTH=200;        // degenerate-container guard; never binds on a real phone
const NARROW_CHART_WIDTH=420;
const AXIS_LEFT=52, AXIS_LEFT_NARROW=40;
const AXIS_RIGHT=14, AXIS_RIGHT_NARROW=10;
const HBAR_LEFT=94, HBAR_RIGHT=58; // wide layout only
const HBAR_ROW_H=46, HBAR_ROW_H_NARROW=64;
const FUNNEL_PAD=2;
const FUNNEL_INDEX_W=26, FUNNEL_INDEX_W_NARROW=20;
const FUNNEL_LABEL_PX=14.5, FUNNEL_LABEL_PX_NARROW=13.5;
const MONO_CHAR_RATIO=0.6, SANS_CHAR_RATIO=0.55; // advance / font-size for IBM Plex Mono, Source Sans 3
const MIN_TICK_GAP_PX=8; // whitespace required between two tick labels
const GBAR_LABEL_PX=13, GBAR_LABEL_PX_NARROW=12; // consistent with the 12/12.5px already used elsewhere in this file
const GBAR_LABEL_LINE_H=15, GBAR_LABEL_MAX_LINES=3, GBAR_LABEL_BASE=10;
// Estimated text-box width. Not a real measurement — but it's the SAME
// estimate every layout decision below is made with, so the harness in
// check_layout.mjs and this renderer agree by construction.
function textPx(text,fontPx,mono){ return String(text).length*fontPx*(mono?MONO_CHAR_RATIO:SANS_CHAR_RATIO); }

function C(){
  // Read the palette off the SCOPED wrapper, not documentElement. styles.css
  // defines --ink/--s1/... on .activity-dash rather than :root so the
  // dashboard's generic token names cannot collide with the app's theme; a
  // getComputedStyle(documentElement) here returns "" for every one of them,
  // which SVG renders as black — every bar and line silently loses its colour.
  // Falling back to documentElement keeps check_layout.mjs (which renders
  // without the wrapper) working.
  const host=document.querySelector(".activity-dash")||document.documentElement;
  const s=getComputedStyle(host), g=k=>s.getPropertyValue(k).trim();
  return {ink:g("--ink"),ink2:g("--ink-2"),ink3:g("--ink-3"),grid:g("--grid"),rule:g("--rule"),
    surface:g("--surface"),brand:g("--brand"),s1:g("--s1"),s2:g("--s2"),s3:g("--s3"),s4:g("--s4"),s5:g("--s5"),
    win:g("--win"),draw:g("--draw"),loss:g("--loss")};
}
const el=(t,a={})=>{const n=document.createElementNS(NS,t);for(const k in a)n.setAttribute(k,a[k]);return n;};
// The single place chart width is decided. resolveFrame() is split out so a
// chart that needs to know narrow-ness before it knows its own height (hbar)
// can ask without frame() creating an svg twice.
function resolveFrame(host){
  const w=Math.max(MIN_CHART_WIDTH,host.clientWidth||host.parentElement.clientWidth);
  return {w,narrow:w<NARROW_CHART_WIDTH};
}
function frame(host,h){
  host.innerHTML="";
  const {w,narrow}=resolveFrame(host);
  let name="Chart";
  try{ const t=host.closest(".card").querySelector("h3").textContent; if(t) name=t; }catch(e){}
  const svg=el("svg",{width:w,height:h,viewBox:`0 0 ${w} ${h}`,role:"img","aria-label":name});
  host.appendChild(svg); return {svg,w,h,narrow};
}
function niceMax(v){ if(v<=0)return 1; const p=Math.pow(10,Math.floor(Math.log10(v))); const n=v/p;
  return (n<=1?1:n<=1.5?1.5:n<=2?2:n<=3?3:n<=4?4:n<=5?5:n<=8?8:10)*p; }
function yAxis(svg,x0,x1,yTop,yBot,max,fmt,c,ticks=4){
  for(let i=0;i<=ticks;i++){
    const v=max*i/ticks, y=yBot-(yBot-yTop)*(i/ticks);
    svg.appendChild(el("line",{x1:x0,x2:x1,y1:y,y2:y,stroke:i?c.grid:c.rule,"stroke-width":1}));
    const t=el("text",{x:x0-8,y:y+4,"text-anchor":"end",fill:c.ink3,"font-size":12,"font-family":"IBM Plex Mono, monospace"});
    t.textContent=fmt(v); svg.appendChild(t);
  }
}
// The widest formatted label, at the axis tick font size (12px, mono).
function widestLabelPx(labels,fmt){
  const f=fmt||short;
  return Math.max(...labels.map((lb,i)=>textPx(f(lb,i),12,true)));
}
// `every` is a LOWER bound, not the answer — this adapts it upward so
// intermediate ticks never collide at the width they're actually given.
// Works for both the linear X of lineChart and the band X of
// barChart/gbar alike, since it only reads the pixel span of one index.
function tickStep(labels,x,every,fmt){
  const widest=widestLabelPx(labels,fmt);
  const span=x(1)-x(0);
  return Math.max(every,Math.ceil((widest+MIN_TICK_GAP_PX)/span),1);
}
function xAxis(svg,labels,x,yBot,c,every,xfmt){
  const f=xfmt||short, last=labels.length-1, endX=x(last);
  const step=tickStep(labels,x,every,xfmt);
  // The last label is end-anchored while the others are middle-anchored, so
  // its required clearance from its neighbor is ~1.5x a label's width, not
  // a fixed constant.
  const guard=1.5*widestLabelPx(labels,xfmt)+MIN_TICK_GAP_PX;
  labels.forEach((lb,i)=>{
    if(i%step && i!==last) return;
    if(i!==last && endX-x(i)<guard) return;   // keep the final tick from colliding
    const t=el("text",{x:x(i),y:yBot+20,"text-anchor":i===last?"end":"middle",
      fill:c.ink3,"font-size":12,"font-family":"IBM Plex Mono, monospace"});
    t.textContent=f(lb,i); svg.appendChild(t); });
}
function launchMark(svg,labels,x,yTop,yBot,c){
  const i=labels.indexOf(window.__LAUNCH); if(i<0)return;
  svg.appendChild(el("line",{x1:x(i),x2:x(i),y1:yTop-4,y2:yBot,stroke:c.brand,"stroke-width":1.5,"stroke-dasharray":"3 4",opacity:.75}));
  const t=el("text",{x:x(i)+5,y:yTop+6,fill:c.brand,"font-size":11.5,"font-family":"IBM Plex Mono, monospace"});
  t.textContent="launch"; svg.appendChild(t);
}
function hover(svg,x0,x1,yTop,yBot,n,xAt,onIdx,c){
  const cross=el("line",{y1:yTop,y2:yBot,stroke:c.ink3,"stroke-width":1,opacity:0});
  const dots=el("g",{opacity:0}); svg.appendChild(cross); svg.appendChild(dots);
  const rect=el("rect",{x:x0,y:yTop,width:Math.max(1,x1-x0),height:yBot-yTop,fill:"transparent"});
  svg.appendChild(rect);
  const move=ev=>{
    const b=svg.getBoundingClientRect(), mx=ev.clientX-b.left;
    let i=0,best=Infinity;
    for(let k=0;k<n;k++){const d=Math.abs(xAt(k)-mx); if(d<best){best=d;i=k;}}
    const px=xAt(i);
    cross.setAttribute("x1",px); cross.setAttribute("x2",px); cross.setAttribute("opacity",".45");
    dots.innerHTML=""; dots.setAttribute("opacity",1);
    const rows=onIdx(i,dots,px);
    const tip=tipEl(); if(!tip) return;
    tip.innerHTML=rows; tip.style.opacity=1;
    const tw=tip.offsetWidth, th=tip.offsetHeight;
    tip.style.left=Math.min(window.innerWidth-tw-10,Math.max(10,ev.clientX-tw/2))+"px";
    tip.style.top=(ev.clientY-th-14<10?ev.clientY+18:ev.clientY-th-14)+"px";
  };
  const out=()=>{cross.setAttribute("opacity",0);dots.setAttribute("opacity",0);
    const tip=tipEl(); if(tip) tip.style.opacity=0;};
  rect.addEventListener("pointermove",move); rect.addEventListener("pointerleave",out);
}
const tipRows=(title,rows)=>`<div class="th">${title}</div>`+rows.map(r=>
  `<div class="r"><span class="lab">${r.c?`<i style="background:${r.c}"></i>`:""}${r.k}</span><b>${r.v}</b></div>`).join("");

/* ---------- line chart ---------- */
function lineChart(host,{labels,series,h=280,fmt=num,every=7,mark=true,yMax=null,pctAxis=false,xfmt=null,xcap=null}){
  const c=C(), {svg,w,narrow}=frame(host,h);
  const x0=narrow?AXIS_LEFT_NARROW:AXIS_LEFT, x1=w-(narrow?AXIS_RIGHT_NARROW:AXIS_RIGHT), yTop=18,yBot=h-30;
  const max=yMax!=null?yMax:niceMax(Math.max(1,...series.flatMap(s=>s.values)));
  const X=i=>x0+(labels.length>1?(x1-x0)*i/(labels.length-1):0);
  const Y=v=>yBot-(yBot-yTop)*(v/max);
  yAxis(svg,x0,x1,yTop,yBot,max,pctAxis?(v=>Math.round(v*100)+"%"):axisNum,c);
  xAxis(svg,labels,X,yBot,c,every,xfmt);
  if(xcap){const t=el('text',{x:x1,y:14,'text-anchor':'end',fill:c.ink3,'font-size':12.5});t.textContent=xcap;svg.appendChild(t);}
  if(mark) launchMark(svg,labels,X,yTop,yBot,c);
  series.forEach(s=>{
    if(s.area){
      const d="M"+X(0)+","+yBot+" "+s.values.map((v,i)=>"L"+X(i)+","+Y(v)).join(" ")+" L"+X(labels.length-1)+","+yBot+"Z";
      svg.appendChild(el("path",{d,fill:s.color,opacity:.12}));
    }
    svg.appendChild(el("path",{d:"M"+s.values.map((v,i)=>X(i)+","+Y(v)).join(" L"),fill:"none",stroke:s.color,
      "stroke-width":2,"stroke-linejoin":"round","stroke-linecap":"round"}));
    const li=s.values.length-1;
    svg.appendChild(el("circle",{cx:X(li),cy:Y(s.values[li]),r:4,fill:s.color,stroke:c.surface,"stroke-width":2}));
  });
  hover(svg,x0,x1,yTop,yBot,labels.length,X,(i,dots,px)=>{
    series.forEach(s=>dots.appendChild(el("circle",{cx:px,cy:Y(s.values[i]),r:4.5,fill:s.color,stroke:c.surface,"stroke-width":2})));
    return tipRows(xfmt?xfmt(labels[i],i):long(labels[i]),series.map(s=>({c:s.color,k:s.name,v:fmt(s.values[i])})));
  },c);
}
/* ---------- stacked / plain bars ---------- */
function barChart(host,{labels,series,h=240,fmt=num,every=7,mark=true,log=false,extra=null}){
  const c=C(), {svg,w,narrow}=frame(host,h);
  const x0=narrow?AXIS_LEFT_NARROW:AXIS_LEFT, x1=w-(narrow?AXIS_RIGHT_NARROW:AXIS_RIGHT), yTop=18,yBot=h-30;
  const totals=labels.map((_,i)=>series.reduce((a,s)=>a+s.values[i],0));
  const tf=v=>log?Math.log10(v+1):v;
  const max=log?Math.ceil(Math.max(1,...totals.map(tf))):niceMax(Math.max(1,...totals));
  const band=(x1-x0)/labels.length, bw=Math.max(2,Math.min(22,band-3));
  const X=i=>x0+band*i+band/2;
  const Y=v=>yBot-(yBot-yTop)*(tf(v)/max);
  if(log){ for(let k=0;k<=max;k++){ const y=yBot-(yBot-yTop)*(k/max);
      svg.appendChild(el("line",{x1:x0,x2:x1,y1:y,y2:y,stroke:k?c.grid:c.rule}));
      const t=el("text",{x:x0-8,y:y+4,"text-anchor":"end",fill:c.ink3,"font-size":12,"font-family":"IBM Plex Mono, monospace"});
      t.textContent=axisNum(Math.pow(10,k)); svg.appendChild(t);} }
  else yAxis(svg,x0,x1,yTop,yBot,max,axisNum,c);
  xAxis(svg,labels,X,yBot,c,every);
  if(mark) launchMark(svg,labels,X,yTop,yBot,c);
  labels.forEach((_,i)=>{
    let acc=0;
    series.forEach(s=>{
      const v=s.values[i]; if(!v) return;
      const yA=Y(acc+v), yB=Y(acc), hgt=Math.max(1,yB-yA-(acc?2:0));
      svg.appendChild(el("rect",{x:X(i)-bw/2,y:yA,width:bw,height:hgt,fill:s.color,rx:Math.min(4,bw/2)}));
      acc+=v;
    });
  });
  hover(svg,x0,x1,yTop,yBot,labels.length,X,(i,dots,px)=>{
    dots.appendChild(el("rect",{x:X(i)-bw/2-3,y:yTop,width:bw+6,height:yBot-yTop,fill:c.ink3,opacity:.09,rx:4}));
    const rows=series.map(s=>({c:s.color,k:s.name,v:fmt(s.values[i])}));
    if(series.length>1) rows.push({k:"Total",v:fmt(totals[i])});
    if(extra) rows.push(...extra(i));
    return tipRows(long(labels[i]),rows);
  },c);
}
/* ---------- horizontal bars ---------- */
// Wide: label | bar | value on one line, sub-line below. Below
// NARROW_CHART_WIDTH the sub-line (e.g. "12 players · 48% human score") runs
// off a phone-width chart at the wide x0=94 origin, so narrow switches to a
// stacked row: label/value share the top baseline, the bar spans the full
// width, and the sub-line is left-anchored at x=0 where it has room.
function drawHbarRowWide(svg,r,y,w,max,fmt,c){
  const x0=HBAR_LEFT,x1=w-HBAR_RIGHT, bw=(x1-x0)*r.value/max;
  const lb=el("text",{x:x0-12,y:y+16,"text-anchor":"end",fill:c.ink,"font-size":14,"font-weight":600}); lb.textContent=r.label;
  svg.appendChild(lb);
  svg.appendChild(el("rect",{x:x0,y:y,width:Math.max(2,bw),height:20,rx:5,fill:r.color}));
  const vt=el("text",{x:x0+bw+9,y:y+16,fill:c.ink2,"font-size":13.5,"font-family":"IBM Plex Mono, monospace"});
  vt.textContent=fmt(r.value); svg.appendChild(vt);
  const sub=el("text",{x:x0,y:y+36,fill:c.ink3,"font-size":13}); sub.textContent=r.sub; svg.appendChild(sub);
}
function drawHbarRowNarrow(svg,r,y,w,max,fmt,c){
  const lb=el("text",{x:0,y:y+14,fill:c.ink,"font-size":14,"font-weight":600}); lb.textContent=r.label;
  svg.appendChild(lb);
  const vt=el("text",{x:w,y:y+14,"text-anchor":"end",fill:c.ink2,"font-size":13.5,"font-family":"IBM Plex Mono, monospace"});
  vt.textContent=fmt(r.value); svg.appendChild(vt);
  const bw=Math.max(2,w*r.value/max);
  svg.appendChild(el("rect",{x:0,y:y+22,width:bw,height:18,rx:5,fill:r.color}));
  const sub=el("text",{x:0,y:y+58,fill:c.ink3,"font-size":13}); sub.textContent=r.sub; svg.appendChild(sub);
}
function hbar(host,{rows,h=null,fmt=num}){
  const c=C(), {narrow}=resolveFrame(host);
  const rowH=narrow?HBAR_ROW_H_NARROW:HBAR_ROW_H, H=h||rows.length*rowH+16;
  const {svg,w}=frame(host,H);
  const max=niceMax(Math.max(...rows.map(r=>r.value)));
  rows.forEach((r,i)=>{
    const y=14+i*rowH;
    if(narrow) drawHbarRowNarrow(svg,r,y,w,max,fmt,c);
    else drawHbarRowWide(svg,r,y,w,max,fmt,c);
  });
}
function funnel(host,{rows,color,unit}){
  const c=C(), H=rows.length*58+8, {svg,w,narrow}=frame(host,H);
  const top=rows[0].value, x0=FUNNEL_PAD, x1=w-FUNNEL_PAD;
  const indexW=narrow?FUNNEL_INDEX_W_NARROW:FUNNEL_INDEX_W;
  const labelPx=narrow?FUNNEL_LABEL_PX_NARROW:FUNNEL_LABEL_PX;
  rows.forEach((r,i)=>{
    const y=i*58+6, share=r.value/top;
    const n=el("text",{x:x0,y:y+13,fill:c.ink3,"font-size":12.5,"font-family":"IBM Plex Mono, monospace"});
    n.textContent=String(i+1).padStart(2,"0"); svg.appendChild(n);
    const lb=el("text",{x:x0+indexW,y:y+13,fill:c.ink,"font-size":labelPx,"font-weight":600}); lb.textContent=r.label;
    svg.appendChild(lb);
    const vt=el("text",{x:x1,y:y+13,"text-anchor":"end",fill:c.ink,"font-size":labelPx,"font-weight":600,
      "font-family":"IBM Plex Mono, monospace"}); vt.textContent=r.value; svg.appendChild(vt);
    svg.appendChild(el("rect",{x:x0,y:y+22,width:x1-x0,height:14,rx:4,fill:c.ink3,opacity:.13}));
    svg.appendChild(el("rect",{x:x0,y:y+22,width:Math.max(3,(x1-x0)*share),height:14,rx:4,fill:color}));
    const meta=el("text",{x:x0,y:y+51,fill:c.ink3,"font-size":13});
    // narrow drops the `unit` suffix (redundant with the .eyebrow above each
    // funnel) — that suffix is what overruns the box on a phone.
    const lost=i?rows[i-1].value-r.value:0;
    const tail=i&&lost?"  ·  "+lost+" lost at this step":i?"  ·  no drop-off":"";
    meta.textContent=narrow?Math.round(share*100)+"%"+tail:Math.round(share*100)+"% "+unit+tail;
    svg.appendChild(meta);
  });
}
// Greedy word-wrap against the real available band width, instead of the
// old fixed word-count split (first two words / rest) that had no idea how
// narrow the band actually was. A single word wider than maxPx still gets
// its own line rather than being character-split.
function wrapLabel(text,maxPx,fontPx){
  const words=String(text).split(" ");
  const lines=[]; let line="";
  for(const word of words){
    const candidate=line?line+" "+word:word;
    if(!line || textPx(candidate,fontPx,false)<=maxPx) line=candidate;
    else { lines.push(line); line=word; }
  }
  if(line) lines.push(line);
  return lines.slice(0,GBAR_LABEL_MAX_LINES);
}
function gbar(host,{labels,series,h=230,fmt=num,yFmt=null,max=null}){
  const c=C(), {svg,w,narrow}=frame(host,h);
  const x0=narrow?AXIS_LEFT_NARROW:AXIS_LEFT, x1=w-(narrow?AXIS_RIGHT_NARROW:AXIS_RIGHT), yTop=16;
  const band=(x1-x0)/labels.length;
  const labelPx=narrow?GBAR_LABEL_PX_NARROW:GBAR_LABEL_PX;
  const wrapped=labels.map(lb=>wrapLabel(lb,band,labelPx));
  const lines=Math.max(1,...wrapped.map(w=>w.length));
  // The plot area yields exactly the vertical space the wrapped labels need.
  const yBot=h-GBAR_LABEL_BASE-lines*GBAR_LABEL_LINE_H;
  const lineGap=(GBAR_LABEL_LINE_H-labelPx)/2;
  const M=max!=null?max:niceMax(Math.max(...series.flatMap(s=>s.values)));
  yAxis(svg,x0,x1,yTop,yBot,M,yFmt||axisNum,c);
  const bw=Math.max(2,Math.min(30,(band-14)/series.length));
  const X=i=>x0+band*i+band/2;
  const Y=v=>yBot-(yBot-yTop)*(v/M);
  labels.forEach((lb,i)=>{
    series.forEach((s,k)=>{
      const bx=X(i)-(series.length*bw+2*(series.length-1))/2+k*(bw+2), v=s.values[i];
      svg.appendChild(el("rect",{x:bx,y:Y(v),width:bw,height:Math.max(1,yBot-Y(v)),rx:4,fill:s.color}));
    });
    wrapped[i].forEach((line,li)=>{
      const t=el("text",{x:X(i),y:yBot+(li+1)*GBAR_LABEL_LINE_H-lineGap,"text-anchor":"middle",fill:c.ink2,"font-size":labelPx});
      t.textContent=line; svg.appendChild(t);
    });
  });
  hover(svg,x0,x1,yTop,yBot,labels.length,X,(i,dots)=>{
    dots.appendChild(el("rect",{x:X(i)-band/2+3,y:yTop,width:band-6,height:yBot-yTop,fill:c.ink3,opacity:.09,rx:4}));
    return tipRows(labels[i],series.map(s=>({c:s.color,k:s.name,v:fmt(s.values[i])})));
  },c);
}
function sparkline(host,values,color,h=34){
  const c=C(); host.innerHTML="";
  const w=Math.max(80,host.clientWidth||160);
  const svg=el("svg",{width:w,height:h,viewBox:`0 0 ${w} ${h}`,"aria-hidden":"true"});
  const max=Math.max(1,...values), X=i=>values.length>1?w*i/(values.length-1):0, Y=v=>h-2-(h-6)*(v/max);
  svg.appendChild(el("path",{d:"M0,"+h+" "+values.map((v,i)=>"L"+X(i)+","+Y(v)).join(" ")+" L"+w+","+h+"Z",fill:color,opacity:.14}));
  svg.appendChild(el("path",{d:"M"+values.map((v,i)=>X(i)+","+Y(v)).join(" L"),fill:"none",stroke:color,"stroke-width":2,"stroke-linejoin":"round"}));
  svg.appendChild(el("circle",{cx:X(values.length-1),cy:Y(values[values.length-1]),r:3,fill:color}));
  host.appendChild(svg);
}
const legend=(host,items)=>{ $(host).innerHTML=items.map(i=>
  `<span><i class="${i.line?"line":""}" style="background:${i.color}"></i>${i.name}</span>`).join(""); };
function table(host,head,rows){
  $(host).innerHTML='<table><thead><tr>'+head.map(h=>`<th>${h}</th>`).join("")+
    '</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map((v,i)=>`<td${i?' class="mono"':''}>${v}</td>`).join("")+'</tr>').join("")+'</tbody></table>';
}
window.__fc={lineChart,barChart,hbar,funnel,gbar,sparkline,legend,table,C,num,pct,short,long,niceMax,textPx};
})();
