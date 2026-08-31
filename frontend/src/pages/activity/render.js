
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

/* Everything below is filled by update(payload) on every refresh — the page
   holds no baked-in numbers, so a reload always reflects the live database.
   ActivityPage.tsx owns the fetching and calls update(). */
let D=null, DAYS=[], NDAYS=0, ACT=[], SIGNUPS=[], BOT=[], TRAIN=[], SOLVES=[],
    IMPORTS=[], PERSONA=[], ELO=[], FUNNEL=[], TTI=[], STICK=[], CONV=null, CONVCMP=[];

function apply(payload){
  D=payload;
  DAYS=payload.days; NDAYS=DAYS.length;
  ACT=payload.activity.map(([u,d,g,h])=>({u,d,g,h}));
  SIGNUPS=payload.signups; BOT=payload.bot; TRAIN=payload.train; SOLVES=payload.solves;
  IMPORTS=payload.imports; PERSONA=payload.persona; ELO=payload.elo;
  FUNNEL=payload.funnel; TTI=payload.tti; STICK=payload.stick;
  CONV=payload.conversion; CONVCMP=payload.conversion_compare;
}
const keep=a=>AUD==="all"?true:AUD==="reg"?a.g===0:a.g===1;

/* fill a sparse [date, ...] list into a dense day range */
function expand(rows){
  const first=rows[0][0], last=rows[rows.length-1][0];
  const i0=DAYS.indexOf(first), i1=DAYS.indexOf(last);
  const labels=DAYS.slice(i0,i1+1);
  const width=rows[0].length-1;
  const cols=Array.from({length:width},()=>new Array(labels.length).fill(0));
  rows.forEach(r=>{const i=DAYS.indexOf(r[0])-i0; for(let k=0;k<width;k++) cols[k][i]=r[k+1];});
  return {labels,cols};
}
function sets(){ const s=Array.from({length:NDAYS},()=>new Set());
  ACT.forEach(a=>{ if(keep(a)) s[a.d].add(a.u); }); return s; }
function rolling(s,win){ return s.map((_,i)=>{const u=new Set();
  for(let j=Math.max(0,i-win+1);j<=i;j++) s[j].forEach(x=>u.add(x)); return u.size;}); }
const hoursPerDay=()=>{ const h=new Array(NDAYS).fill(0); ACT.forEach(a=>{if(keep(a)) h[a.d]+=a.h;}); return h; };

/* return-within-N-days curve, per cohort */
function retention(g){
  const byUser=new Map();
  ACT.forEach(a=>{ if(a.g!==g) return; if(!byUser.has(a.u)) byUser.set(a.u,[]); byUser.get(a.u).push(a.d); });
  const users=[...byUser.values()].map(ds=>({first:Math.min(...ds),days:ds}));
  const out=[];
  for(let n=1;n<=14;n++){
    const elig=users.filter(u=>u.first+n<=NDAYS-1);
    const back=elig.filter(u=>u.days.some(d=>d>u.first&&d<=u.first+n)).length;
    out.push(elig.length?back/elig.length:0);
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

function tiles(dau,wau,mau){
  const c=C(), T=totals(), LAST=D.last_complete_index;
  const span=n=>{ const from=DAYS[Math.max(0,LAST-(n-1))];
    return "distinct users, "+short(from)+"–"+short(DAYS[LAST]); };
  const t=[
    {k:"DAU · "+short(DAYS[LAST]),v:dau[LAST],m:"distinct users that day",spark:dau.slice(-30),color:c.s3},
    {k:"WAU · 7-day",v:wau[LAST],m:span(7),spark:wau.slice(-30),color:c.s2},
    {k:"MAU · 30-day",v:mau[LAST],m:span(30),spark:mau.slice(-30),color:c.s1},
    {k:"Stickiness",v:Math.round(100*dau[LAST]/Math.max(1,mau[LAST]))+"%",m:"DAU ÷ MAU"},
    {k:"Bot games",v:T.botGames,m:`${Math.round(100*(T.botWins+T.botDraws/2)/T.botGames)}% human score · ${D.bot_players} players`},
    {k:"Train sessions",v:T.sessions,m:`${Math.round(100*T.done/(T.done+T.expired))}% completed, rest expired`},
  ];
  $("#tiles").innerHTML=t.map((x,i)=>
    `<div class="tile"><span class="k">${x.k}</span><span class="v">${typeof x.v==="number"?num(x.v):x.v}</span>
     <span class="m">${x.m}</span>${x.spark?`<div class="sp" data-i="${i}"></div>`:""}</div>`).join("");
  document.querySelectorAll("#tiles .sp").forEach(h=>sparkline(h,t[+h.dataset.i].spark,t[+h.dataset.i].color));
}

function chrome(){
  const T=totals(), last=DAYS[NDAYS-1];
  $("#w-range").textContent=short(DAYS[0])+" – "+long(last);
  $("#w-days").textContent=NDAYS+" days of tracked activity";
  $("#bot-blurb").textContent=
    `Games played against the FlawChess bot — ${T.botGames} games from ${D.bot_players} players `+
    `since the feature went live on ${long(BOT[0][0])}.`;
  $("#cav-start").textContent=long(DAYS[0]);
  $("#cav-partial").textContent=long(last);
  $("#cav-funnel").textContent=long(DAYS[0]);
  $("#cav-promoted").textContent=long(D.promoted_since);
  $("#cav-features").textContent=
    `bot play starts ${long(BOT[0][0])}, Train sessions ${long(TRAIN[0][0])}`;
}

function render(){
  if(!D) return;
  const c=C();
  chrome();
  const s=sets(), dau=rolling(s,1), wau=rolling(s,7), mau=rolling(s,30), hrs=hoursPerDay();
  tiles(dau,wau,mau);

  $("#au-title").textContent = AUD==="all"?"Rolling active users — all users"
    : AUD==="reg"?"Rolling active users — registered accounts":"Rolling active users — guest sessions";
  legend("#au-legend",[{name:"MAU (30-day)",color:c.s1,line:1},{name:"WAU (7-day)",color:c.s2,line:1},{name:"DAU",color:c.s3,line:1}]);
  lineChart($("#c-actives"),{labels:DAYS,h:300,series:[
    {name:"MAU (30-day)",values:mau,color:c.s1,area:true},
    {name:"WAU (7-day)",values:wau,color:c.s2},
    {name:"DAU",values:dau,color:c.s3}]});
  table("#t-actives",["Date","DAU","WAU","MAU","Active hours"],
    DAYS.map((d,i)=>[long(d),dau[i],wau[i],mau[i],hrs[i]]).reverse());

  barChart($("#c-hours"),{labels:DAYS,h:220,every:10,series:[{name:"Active hours",values:hrs,color:c.s4}]});

  const su=expand(SIGNUPS);
  legend("#su-legend",[{name:"Registered signups",color:c.s1},{name:"Guest sessions",color:c.s5}]);
  barChart($("#c-signups"),{labels:su.labels,h:220,every:10,series:[
    {name:"Registered signups",values:su.cols[0],color:c.s1},
    {name:"Guest sessions",values:su.cols[1],color:c.s5}]});

  const rr=retention(0), rg=retention(1), rl=Array.from({length:14},(_,i)=>"day-"+(i+1));
  legend("#ret-legend",[{name:"Registered accounts",color:c.s1,line:1},{name:"Guest sessions",color:c.s5,line:1}]);
  lineChart($("#c-retention"),{labels:rl,h:250,every:1,pctAxis:true,yMax:1,
    xfmt:(lb,i)=>String(i+1), xcap:"days since first visit",
    fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Registered accounts",values:rr,color:c.s1,area:true},
            {name:"Guest sessions",values:rg,color:c.s5}]});

  funnel($("#c-funnel-reg"),{color:c.s1,unit:"of registered accounts",
    rows:FUNNEL.map((f,i)=>({label:i?f[0]:"Account created",value:f[1]}))});
  funnel($("#c-funnel-guest"),{color:c.s5,unit:"of guest sessions",
    rows:FUNNEL.map((f,i)=>({label:i?f[0]:"Guest session started",value:f[2]}))});
  table("#t-funnel",["Stage","Registered","% of registered","Guests","% of guests"],
    FUNNEL.map(f=>[f[0],f[1],Math.round(100*f[1]/FUNNEL[0][1])+"%",f[2],Math.round(100*f[2]/FUNNEL[0][2])+"%"]));

  legend("#tti-legend",[{name:"Registered accounts",color:c.s1},{name:"Guest sessions",color:c.s5}]);
  gbar($("#c-tti"),{labels:TTI.map(t=>t[0]),h:250,max:1,
    yFmt:v=>Math.round(v*100)+"%", fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Registered accounts",color:c.s1,values:TTI.map(t=>t[1]/FUNNEL[0][1])},
            {name:"Guest sessions",color:c.s5,values:TTI.map(t=>t[2]/FUNNEL[0][2])}]});

  legend("#stick-legend",[{name:"Imported games",color:c.s2},{name:"Never imported",color:c.draw}]);
  gbar($("#c-stick"),{labels:STICK.map(r=>r[0]),h:250,max:1,
    yFmt:v=>Math.round(v*100)+"%", fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Imported games",color:c.s2,values:STICK.map(r=>r[2]/r[1])},
            {name:"Never imported",color:c.draw,values:STICK.map(r=>r[4]/r[3])}]});

  const convPct=CONV.converted/CONV.sessions;
  $("#conv-big").textContent=(convPct*100).toFixed(1)+"%";
  // Bug fix: read the payload's snake_case keys. This block used camelCase
  // (avgDaysConv/avgDaysGuest), which fetch_conversion never emits, so the line
  // rendered "NaN x" and "undefined active days against undefined". The payload
  // type is Record<string, number|string>, too loose for TS to catch it.
  $("#conv-exp").innerHTML=`<b>${CONV.converted}</b> of <b>${CONV.sessions}</b> guest sessions have since become
    registered accounts. Converters stay active <b>${(CONV.avg_days_converted/CONV.avg_days_guest).toFixed(1)}&times;</b> longer
    than guests who never sign up &mdash; ${CONV.avg_days_converted} active days against ${CONV.avg_days_guest}.`;
  legend("#conv-legend",[{name:"Converted to an account",color:c.s2},{name:"Stayed a guest",color:c.s5}]);
  gbar($("#c-conv"),{labels:CONVCMP.map(r=>r[0]),h:240,max:1,
    yFmt:v=>Math.round(v*100)+"%", fmt:v=>Math.round(v*100)+"%",
    series:[{name:"Converted to an account",color:c.s2,values:CONVCMP.map(r=>r[1]/r[2])},
            {name:"Stayed a guest",color:c.s5,values:CONVCMP.map(r=>r[3]/r[4])}]});

  const bt=expand(BOT), [bg,bu,be,bw,bd]=bt.cols;
  const bl=bg.map((g,i)=>g-bw[i]-bd[i]);
  legend("#bot-legend",[{name:"Human win",color:c.win},{name:"Draw",color:c.draw},{name:"Bot win",color:c.loss}]);
  barChart($("#c-bot"),{labels:bt.labels,h:250,every:7,series:[
    {name:"Human win",values:bw,color:c.win},{name:"Draw",values:bd,color:c.draw},{name:"Bot win",values:bl,color:c.loss}],
    extra:i=>[{k:"Players",v:bu[i]},{k:"Avg bot rating",v:be[i]||"—"}]});
  table("#t-bot",["Date","Games","Players","Avg bot rating","Human score"],
    BOT.map(r=>[long(r[0]),r[1],r[2],r[3],Math.round(100*(r[4]+r[5]/2)/r[1])+"%"]).reverse());

  hbar($("#c-persona"),{rows:PERSONA.map((p,i)=>({label:p[0],value:p[1],color:[c.s1,c.s2,c.s3,c.s4,c.s5][i],
    sub:`${p[2]} players · ${Math.round(100*(p[3]+p[4]/2)/p[1])}% human score`}))});

  hbar($("#c-elo"),{fmt:v=>Math.round(v*100)+"%",rows:ELO.map(e=>({label:e[0]+" bot",
    value:(e[2]+e[3]/2)/e[1],color:c.s3,sub:`${e[1]} games`}))});

  const tr=expand(TRAIN), [ts,tu,tc,te,to,tp]=tr.cols;
  legend("#tr-legend",[{name:"Completed",color:c.win},{name:"Still open",color:c.draw},{name:"Expired unfinished",color:c.loss}]);
  barChart($("#c-train"),{labels:tr.labels,h:240,every:5,series:[
    {name:"Completed",values:tc,color:c.win},{name:"Still open",values:to,color:c.draw},
    {name:"Expired unfinished",values:te,color:c.loss}],
    extra:i=>[{k:"Puzzles served",v:tp[i]}]});
  table("#t-train",["Date","Sessions","Users","Completed","Expired","Open","Puzzles served"],
    TRAIN.map(r=>[long(r[0]),r[1],r[2],r[3],r[4],r[5],r[6]]).reverse());

  const sv=expand(SOLVES);
  barChart($("#c-solves"),{labels:sv.labels,h:220,every:5,
    series:[{name:"Puzzles solved",values:sv.cols[0],color:c.s2}],
    extra:i=>[{k:"Users",v:sv.cols[1][i]}]});
  const rowsS=sv.labels.map((_,i)=>[0,sv.cols[0][i],sv.cols[2][i],sv.cols[3][i]]);
  legend("#acc-legend",[{name:"Right move",color:c.s3,line:1},{name:"Right verdict",color:c.s4,line:1}]);
  lineChart($("#c-acc"),{labels:sv.labels,h:220,every:5,pctAxis:true,yMax:1,
    fmt:v=>Math.round(v*100)+"%",series:[
      {name:"Right move",values:roll7(rowsS,2,1),color:c.s3},
      {name:"Right verdict",values:roll7(rowsS,3,1),color:c.s4}]});

  const im=expand(IMPORTS);
  barChart($("#c-imports"),{labels:im.labels,h:220,every:10,log:true,
    series:[{name:"Games imported",values:im.cols[2],color:c.s1}],
    extra:i=>[{k:"Jobs",v:im.cols[0][i]},{k:"Failed",v:im.cols[3][i]}]});
  barChart($("#c-impusers"),{labels:im.labels,h:220,every:10,
    series:[{name:"Importing users",values:im.cols[1],color:c.s2}]});
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
  const segButtons=Array.from(document.querySelectorAll(".seg button"));
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
