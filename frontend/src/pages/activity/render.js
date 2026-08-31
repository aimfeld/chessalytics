
(() => {
// Bound in mount(), not at module-evaluation time. Same trap as charts.js's
// #tip lookup: under the React host this script can evaluate before charts.js
// has published window.__fc, and an eager destructure would freeze every chart
// helper as undefined for the lifetime of the module.
let lineChart,barChart,hbar,funnel,gbar,sparkline,legend,table,C,num,short,long;
const bindCharts=()=>{
  ({lineChart,barChart,hbar,funnel,gbar,sparkline,legend,table,C,num,short,long}=window.__fc);
};
const $=s=>document.querySelector(s);
let AUD="all";

// Degrade to the em-dash placeholder rather than a NaN/undefined string when
// a share has no denominator (an empty window, or a metric with zero rows).
// Same character charts.js's own DASH uses, for a consistent placeholder.
const DASH="—";
// Fraction fed to a chart (0..1). 0 when the denominator is falsy, so an
// empty-window chart plots a flat zero instead of NaN geometry.
const ratio=(n,d)=>d?n/d:0;
// Percentage TEXT for copy and table cells. Em-dash (not "0%") when the
// denominator is falsy, so an empty cohort reads as "no data" rather than a
// misleadingly precise zero.
const pctText=(n,d)=>d?Math.round(100*n/d)+"%":DASH;

/* Everything below is filled by update(payload) on every refresh — the page
   holds no baked-in numbers, so a reload always reflects the live database.
   ActivityPage.tsx owns the fetching and calls update(). */
let D=null, DAYS=[], NDAYS=0, ACT=[], SIGNUPS=[], BOT=[], TRAIN=[], SOLVES=[],
    IMPORTS=[], PERSONA=[], ELO=[], FUNNEL=[], TTI=[], STICK=[], CONV=null, CONVCMP=[];

function apply(payload){
  D=payload;
  DAYS=payload.days; NDAYS=DAYS.length;
  // Fifth field `e` is the entrant flag: 1 when this user's global first
  // tracked day falls on or after the selected window's start (D3's cohort).
  ACT=payload.activity.map(([u,d,g,h,e])=>({u,d,g,h,e}));
  SIGNUPS=payload.signups; BOT=payload.bot; TRAIN=payload.train; SOLVES=payload.solves;
  IMPORTS=payload.imports; PERSONA=payload.persona; ELO=payload.elo;
  FUNNEL=payload.funnel; TTI=payload.tti; STICK=payload.stick;
  CONV=payload.conversion; CONVCMP=payload.conversion_compare;
}
const keep=a=>AUD==="all"?true:AUD==="reg"?a.g===0:a.g===1;

/* Drop every leading entry of `labels` (plus each parallel array in
   `arrays`) whose label sorts before the selected window's start. ISO dates
   compare correctly as plain strings, so no parsing is needed. This exists
   ONLY to strip the ROLLING_LEAD_IN_DAYS lookback the server ships so the
   30-day MAU and the 7-day rolling accuracy are already correct on the
   window's first visible day — the lead-in itself must never be plotted. */
function trimLeadIn(labels,...arrays){
  const cutoff=DAYS[D.window_start_index];
  let i0=labels.findIndex(d=>d>=cutoff);
  if(i0<0) i0=labels.length;
  return [labels.slice(i0),...arrays.map(a=>a.slice(i0))];
}

/* Write a short empty-state note into a chart or table host and skip
   rendering into it. One helper so the pattern is written once. */
function emptyNote(host,message){
  $(host).innerHTML=`<p class="note">${message}</p>`;
}

/* fill a sparse [date, ...] list into a dense day range. `width` is passed
   explicitly (not derived from rows[0]) so an empty row set can still return
   the right number of empty columns instead of throwing on rows[0]. */
function expand(rows,width){
  if(!rows.length) return {labels:[],cols:Array.from({length:width},()=>[])};
  const first=rows[0][0], last=rows[rows.length-1][0];
  const i0=DAYS.indexOf(first), i1=DAYS.indexOf(last);
  const labels=DAYS.slice(i0,i1+1);
  const cols=Array.from({length:width},()=>new Array(labels.length).fill(0));
  rows.forEach(r=>{const i=DAYS.indexOf(r[0])-i0; for(let k=0;k<width;k++) cols[k][i]=r[k+1];});
  return {labels,cols};
}
function sets(){ const s=Array.from({length:NDAYS},()=>new Set());
  ACT.forEach(a=>{ if(keep(a)) s[a.d].add(a.u); }); return s; }
function rolling(s,win){ return s.map((_,i)=>{const u=new Set();
  for(let j=Math.max(0,i-win+1);j<=i;j++) s[j].forEach(x=>u.add(x)); return u.size;}); }
const hoursPerDay=()=>{ const h=new Array(NDAYS).fill(0); ACT.forEach(a=>{if(keep(a)) h[a.d]+=a.h;}); return h; };

/* return-within-N-days curve, per cohort. Only ENTRANTS (first tracked day
   inside the selected window, per D3) are counted, so the cohort follows
   forward to today rather than being windowed on the return-visit date. */
function retention(g){
  const byUser=new Map();
  ACT.forEach(a=>{
    if(a.g!==g||!a.e) return;
    if(!byUser.has(a.u)) byUser.set(a.u,[]);
    byUser.get(a.u).push(a.d);
  });
  const users=[...byUser.values()].map(ds=>({first:Math.min(...ds),days:ds}));
  const out=[];
  for(let n=1;n<=14;n++){
    const elig=users.filter(u=>u.first+n<=NDAYS-1);
    // Eligibility shrinks monotonically as N grows, so once nobody is
    // eligible at N, nobody will be at N+1 either — stop and return the
    // shorter series rather than fabricating a zero point (D3).
    if(!elig.length) break;
    const back=elig.filter(u=>u.days.some(d=>d>u.first&&d<=u.first+n)).length;
    out.push(back/elig.length);
  }
  return out;
}
function roll7(rows,numIdx,denIdx){
  return rows.map((_,i)=>{ let a=0,b=0;
    for(let j=Math.max(0,i-6);j<=i;j++){ a+=rows[j][numIdx]; b+=rows[j][denIdx]; }
    return b?a/b:0; });
}

const totals=()=>({
  users:new Set(ACT.map(a=>a.u)).size,
  botGames:BOT.reduce((s,r)=>s+r[1],0),
  botWins:BOT.reduce((s,r)=>s+r[4],0),
  botDraws:BOT.reduce((s,r)=>s+r[5],0),
  sessions:TRAIN.reduce((s,r)=>s+r[1],0),
  done:TRAIN.reduce((s,r)=>s+r[3],0),
  expired:TRAIN.reduce((s,r)=>s+r[4],0),
  solves:SOLVES.reduce((s,r)=>s+r[1],0),
  solveOk:SOLVES.reduce((s,r)=>s+r[3],0),
  imported:IMPORTS.reduce((s,r)=>s+r[3],0),
});

function tiles(dau,wau,mau,days,last){
  const c=C(), T=totals();
  const span=n=>{ const from=days[Math.max(0,last-(n-1))];
    return "distinct users, "+short(from)+"–"+short(days[last]); };
  const t=[
    {k:"DAU · "+short(days[last]),v:dau[last],m:"distinct users that day",spark:dau.slice(-30),color:c.s3},
    {k:"WAU · 7-day",v:wau[last],m:span(7),spark:wau.slice(-30),color:c.s2},
    {k:"MAU · 30-day",v:mau[last],m:span(30),spark:mau.slice(-30),color:c.s1},
    {k:"Stickiness",v:pctText(dau[last],mau[last]),m:"DAU ÷ MAU"},
    {k:"Bot games",v:T.botGames,m:`${pctText(T.botWins+T.botDraws/2,T.botGames)} human score · ${D.bot_players} players`},
    {k:"Train sessions",v:T.sessions,m:`${pctText(T.done,T.done+T.expired)} completed, rest expired`},
  ];
  $("#tiles").innerHTML=t.map((x,i)=>
    `<div class="tile"><span class="k">${x.k}</span><span class="v">${typeof x.v==="number"?num(x.v):x.v}</span>
     <span class="m">${x.m}</span>${x.spark?`<div class="sp" data-i="${i}"></div>`:""}</div>`).join("");
  document.querySelectorAll("#tiles .sp").forEach(h=>sparkline(h,t[+h.dataset.i].spark,t[+h.dataset.i].color));
}

function chrome(){
  const T=totals(), last=DAYS[NDAYS-1];
  const winStart=DAYS[D.window_start_index];
  const visibleDays=NDAYS-D.window_start_index;
  $("#w-range").textContent=short(winStart)+" – "+long(last);
  $("#w-days").textContent=visibleDays+" days in view";
  $("#bot-blurb").textContent=BOT.length
    ? `Games played against the FlawChess bot — ${T.botGames} games from ${D.bot_players} players `+
      `since the feature went live on ${long(BOT[0][0])}.`
    : "Games played against the FlawChess bot — none in the selected range.";
  // Activity tracking's start is a fact about the whole user_activity table,
  // not about the selected window — read it from data_start, not days[0].
  $("#cav-start").textContent=long(D.data_start);
  $("#cav-partial").textContent=long(last);
  $("#cav-funnel").textContent=long(winStart);
  $("#cav-promoted").textContent=long(D.promoted_since);
  const botPhrase=BOT.length?`bot play starts ${long(BOT[0][0])}`:"no bot games in the selected range";
  const trainPhrase=TRAIN.length?`Train sessions ${long(TRAIN[0][0])}`:"no Train sessions in the selected range";
  $("#cav-features").textContent=`${botPhrase}, ${trainPhrase}`;
}

function renderActivesCard(){
  const c=C();
  const s=sets(), dau=rolling(s,1), wau=rolling(s,7), mau=rolling(s,30), hrs=hoursPerDay();
  // sets()/rolling() run on the FULL lead-in-inclusive arrays on purpose —
  // trim only for display, after the rolling windows have already looked back.
  const [days,tDau,tWau,tMau,tHrs]=trimLeadIn(DAYS,dau,wau,mau,hrs);
  const last=Math.max(0,D.last_complete_index-D.window_start_index);
  tiles(tDau,tWau,tMau,days,last);

  $("#au-title").textContent = AUD==="all"?"Rolling active users — all users"
    : AUD==="reg"?"Rolling active users — registered accounts":"Rolling active users — guest sessions";
  legend("#au-legend",[{name:"MAU (30-day)",color:c.s1,line:1},{name:"WAU (7-day)",color:c.s2,line:1},{name:"DAU",color:c.s3,line:1}]);
  lineChart($("#c-actives"),{labels:days,h:300,series:[
    {name:"MAU (30-day)",values:tMau,color:c.s1,area:true},
    {name:"WAU (7-day)",values:tWau,color:c.s2},
    {name:"DAU",values:tDau,color:c.s3}]});
  table("#t-actives",["Date","DAU","WAU","MAU","Active hours"],
    days.map((d,i)=>[long(d),tDau[i],tWau[i],tMau[i],tHrs[i]]).reverse());

  barChart($("#c-hours"),{labels:days,h:220,every:10,series:[{name:"Active hours",values:tHrs,color:c.s4}]});
}

function renderSignupsCard(){
  const c=C();
  if(!SIGNUPS.length){
    emptyNote("#c-signups","No signups in the selected range.");
    $("#su-legend").innerHTML="";
    return;
  }
  const su=expand(SIGNUPS,2);
  legend("#su-legend",[{name:"Registered signups",color:c.s1},{name:"Guest sessions",color:c.s5}]);
  barChart($("#c-signups"),{labels:su.labels,h:220,every:10,series:[
    {name:"Registered signups",values:su.cols[0],color:c.s1},
    {name:"Guest sessions",values:su.cols[1],color:c.s5}]});
}

function renderRetentionCard(){
  const c=C();
  const rr=retention(0), rg=retention(1);
  const longest=Math.max(rr.length,rg.length);
  if(!longest){
    emptyNote("#c-retention","No accounts entered in the selected range yet.");
    $("#ret-legend").innerHTML="";
    return;
  }
  const rl=Array.from({length:longest},(_,i)=>"day-"+(i+1));
  legend("#ret-legend",[{name:"Registered accounts",color:c.s1,line:1},{name:"Guest sessions",color:c.s5,line:1}]);
  lineChart($("#c-retention"),{labels:rl,h:250,every:1,pctAxis:true,yMax:1,
    xfmt:(lb,i)=>String(i+1), xcap:"days since first visit",
    fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Registered accounts",values:rr,color:c.s1,area:true},
            {name:"Guest sessions",values:rg,color:c.s5}]});
}

function renderFunnelCard(){
  const c=C();
  funnel($("#c-funnel-reg"),{color:c.s1,unit:"of registered accounts",
    rows:FUNNEL.map((f,i)=>({label:i?f[0]:"Account created",value:f[1]}))});
  funnel($("#c-funnel-guest"),{color:c.s5,unit:"of guest sessions",
    rows:FUNNEL.map((f,i)=>({label:i?f[0]:"Guest session started",value:f[2]}))});
  table("#t-funnel",["Stage","Registered","% of registered","Guests","% of guests"],
    FUNNEL.map(f=>[f[0],f[1],pctText(f[1],FUNNEL[0][1]),f[2],pctText(f[2],FUNNEL[0][2])]));
}

function renderTtiStickCards(){
  const c=C();
  legend("#tti-legend",[{name:"Registered accounts",color:c.s1},{name:"Guest sessions",color:c.s5}]);
  gbar($("#c-tti"),{labels:TTI.map(t=>t[0]),h:250,max:1,
    yFmt:v=>Math.round(v*100)+"%", fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Registered accounts",color:c.s1,values:TTI.map(t=>ratio(t[1],FUNNEL[0][1]))},
            {name:"Guest sessions",color:c.s5,values:TTI.map(t=>ratio(t[2],FUNNEL[0][2]))}]});

  legend("#stick-legend",[{name:"Imported games",color:c.s2},{name:"Never imported",color:c.draw}]);
  gbar($("#c-stick"),{labels:STICK.map(r=>r[0]),h:250,max:1,
    yFmt:v=>Math.round(v*100)+"%", fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Imported games",color:c.s2,values:STICK.map(r=>ratio(r[2],r[1]))},
            {name:"Never imported",color:c.draw,values:STICK.map(r=>ratio(r[4],r[3]))}]});
}

function renderConversionCard(){
  const c=C();
  $("#conv-big").textContent=CONV.sessions?(100*CONV.converted/CONV.sessions).toFixed(1)+"%":DASH;
  if(!CONV.sessions){
    $("#conv-exp").textContent="There were no guest sessions in the selected range.";
  } else if(!CONV.avg_days_guest){
    $("#conv-exp").innerHTML=`<b>${CONV.converted}</b> of <b>${CONV.sessions}</b> guest sessions have since become
      registered accounts.`;
  } else {
    // Bug fix: read the payload's snake_case keys. This block used camelCase
    // (avgDaysConv/avgDaysGuest), which fetch_conversion never emits, so the line
    // rendered "NaN x" and "undefined active days against undefined". The payload
    // type is Record<string, number|string>, too loose for TS to catch it.
    $("#conv-exp").innerHTML=`<b>${CONV.converted}</b> of <b>${CONV.sessions}</b> guest sessions have since become
      registered accounts. Converters stay active <b>${(CONV.avg_days_converted/CONV.avg_days_guest).toFixed(1)}&times;</b> longer
      than guests who never sign up &mdash; ${CONV.avg_days_converted} active days against ${CONV.avg_days_guest}.`;
  }
  legend("#conv-legend",[{name:"Converted to an account",color:c.s2},{name:"Stayed a guest",color:c.s5}]);
  gbar($("#c-conv"),{labels:CONVCMP.map(r=>r[0]),h:240,max:1,
    yFmt:v=>Math.round(v*100)+"%", fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Converted to an account",color:c.s2,values:CONVCMP.map(r=>ratio(r[1],r[2]))},
            {name:"Stayed a guest",color:c.s5,values:CONVCMP.map(r=>ratio(r[3],r[4]))}]});
}

function renderBotCard(){
  const c=C();
  if(!BOT.length){
    emptyNote("#c-bot","No bot games in the selected range.");
    emptyNote("#t-bot","No bot games in the selected range.");
    $("#bot-legend").innerHTML="";
  } else {
    const bt=expand(BOT,5), [bg,bu,be,bw,bd]=bt.cols;
    const bl=bg.map((g,i)=>g-bw[i]-bd[i]);
    legend("#bot-legend",[{name:"Human win",color:c.win},{name:"Draw",color:c.draw},{name:"Bot win",color:c.loss}]);
    barChart($("#c-bot"),{labels:bt.labels,h:250,every:7,series:[
      {name:"Human win",values:bw,color:c.win},{name:"Draw",values:bd,color:c.draw},{name:"Bot win",values:bl,color:c.loss}],
      extra:i=>[{k:"Players",v:bu[i]},{k:"Avg bot rating",v:be[i]||"—"}]});
    table("#t-bot",["Date","Games","Players","Avg bot rating","Human score"],
      BOT.map(r=>[long(r[0]),r[1],r[2],r[3],pctText(r[4]+r[5]/2,r[1])]).reverse());
  }

  if(!PERSONA.length){
    emptyNote("#c-persona","No bot games in the selected range.");
  } else {
    hbar($("#c-persona"),{rows:PERSONA.map((p,i)=>({label:p[0],value:p[1],color:[c.s1,c.s2,c.s3,c.s4,c.s5][i],
      sub:`${pctText(p[3]+p[4]/2,p[1])} human score`}))});
  }

  if(!ELO.length){
    emptyNote("#c-elo","No bot games in the selected range.");
  } else {
    hbar($("#c-elo"),{fmt:v=>Math.round(v*100)+"%",rows:ELO.map(e=>({label:e[0]+" bot",
      value:ratio(e[2]+e[3]/2,e[1]),color:c.s3,sub:`${e[1]} games`}))});
  }
}

function renderTrainCard(){
  const c=C();
  if(!TRAIN.length){
    emptyNote("#c-train","No Train sessions in the selected range.");
    emptyNote("#t-train","No Train sessions in the selected range.");
    $("#tr-legend").innerHTML="";
    return;
  }
  const tr=expand(TRAIN,6), [,,tc,te,to,tp]=tr.cols;
  legend("#tr-legend",[{name:"Completed",color:c.win},{name:"Still open",color:c.draw},{name:"Expired unfinished",color:c.loss}]);
  barChart($("#c-train"),{labels:tr.labels,h:240,every:5,series:[
    {name:"Completed",values:tc,color:c.win},{name:"Still open",values:to,color:c.draw},
    {name:"Expired unfinished",values:te,color:c.loss}],
    extra:i=>[{k:"Puzzles served",v:tp[i]}]});
  table("#t-train",["Date","Sessions","Users","Completed","Expired","Open","Puzzles served"],
    TRAIN.map(r=>[long(r[0]),r[1],r[2],r[3],r[4],r[5],r[6]]).reverse());
}

function renderSolvesCard(){
  const c=C();
  if(!SOLVES.length){
    emptyNote("#c-solves","No puzzles solved in the selected range.");
    emptyNote("#c-acc","No puzzles solved in the selected range.");
    $("#acc-legend").innerHTML="";
    return;
  }
  // Roll over the FULL expanded (lead-in-inclusive) arrays first, so the
  // 7-day rolling accuracy is already correct on the window's first visible
  // day, then trim the lead-in off everything before plotting.
  const sv=expand(SOLVES,4);
  const rowsS=sv.labels.map((_,i)=>[0,sv.cols[0][i],sv.cols[2][i],sv.cols[3][i]]);
  const rolledMove=roll7(rowsS,2,1), rolledGuess=roll7(rowsS,3,1);
  const [labels,solvesCount,usersCount,tMove,tGuess]=
    trimLeadIn(sv.labels,sv.cols[0],sv.cols[1],rolledMove,rolledGuess);

  barChart($("#c-solves"),{labels,h:220,every:5,
    series:[{name:"Puzzles solved",values:solvesCount,color:c.s2}],
    extra:i=>[{k:"Users",v:usersCount[i]}]});
  legend("#acc-legend",[{name:"Right move",color:c.s3,line:1},{name:"Right verdict",color:c.s4,line:1}]);
  lineChart($("#c-acc"),{labels,h:220,every:5,pctAxis:true,yMax:1,
    fmt:v=>Math.round(v*100)+"%",series:[
      {name:"Right move",values:tMove,color:c.s3},
      {name:"Right verdict",values:tGuess,color:c.s4}]});
}

function renderImportsCard(){
  if(!IMPORTS.length){
    emptyNote("#c-imports","No imports in the selected range.");
    emptyNote("#c-impusers","No imports in the selected range.");
    return;
  }
  const c=C();
  const im=expand(IMPORTS,4);
  barChart($("#c-imports"),{labels:im.labels,h:220,every:10,log:true,
    series:[{name:"Games imported",values:im.cols[2],color:c.s1}],
    extra:i=>[{k:"Jobs",v:im.cols[0][i]},{k:"Failed",v:im.cols[3][i]}]});
  barChart($("#c-impusers"),{labels:im.labels,h:220,every:10,
    series:[{name:"Importing users",values:im.cols[1],color:c.s2}]});
}

function render(){
  if(!D) return;
  chrome();
  renderActivesCard();
  renderSignupsCard();
  renderRetentionCard();
  renderFunnelCard();
  renderTtiStickCards();
  renderConversionCard();
  renderBotCard();
  renderTrainCard();
  renderSolvesCard();
  renderImportsCard();
}

/* ---------- mount ---------- */
/* render.js is the RENDER layer only. Fetching, the live-status pill and the
   error banner belong to the React host (./ActivityPage.tsx). Keeping them out
   of here is what makes "the page never polls on a timer" structural rather
   than a convention someone can undo by accident. */
function mount(){
  bindCharts();
  let destroyed=false;
  const draw=()=>{ if(!destroyed) render(); };

  // The audience segmented control owns its own aria-pressed attributes
  // imperatively. Do NOT lift this into React state — dual ownership of one
  // attribute is exactly the bug this seam exists to avoid.
  // Narrowed to [data-aud] buttons: ActivityPage.tsx adds a second `.seg`
  // group for the range filter, and an unnarrowed ".seg button" selector
  // would bind those buttons too and set the audience to undefined on click.
  const segButtons=Array.from(document.querySelectorAll(".seg button[data-aud]"));
  const segBound=segButtons.map(b=>{
    const h=()=>{
      AUD=b.dataset.aud;
      segButtons.forEach(x=>x.setAttribute("aria-pressed",String(x===b)));
      draw();
    };
    b.addEventListener("click",h);
    return [b,h];
  });

  let rt=null;
  const onResize=()=>{clearTimeout(rt);rt=setTimeout(draw,150);};
  addEventListener("resize",onResize);

  const mq=matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change",draw);

  const obs=new MutationObserver(draw);
  obs.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});

  if(document.fonts) document.fonts.ready.then(draw);

  return {
    update(payload){ apply(payload); draw(); },
    // destroy() is not optional: React 19 StrictMode mounts effects twice in
    // dev, so without it the second mount leaves the first mount's resize
    // listener re-rendering into a detached DOM.
    destroy(){
      destroyed=true;
      segBound.forEach(([b,h])=>b.removeEventListener("click",h));
      removeEventListener("resize",onResize);
      clearTimeout(rt);
      mq.removeEventListener("change",draw);
      obs.disconnect();
    },
  };
}

window.__fcApp={mount};
})();
