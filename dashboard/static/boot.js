/* Standalone driver for the local dashboard server (dashboard/server.py).
   Fetches /api/stats, polls on the payload's own interval, and renders the
   live-status pill and error banner.

   This file is loaded ONLY by dashboard/static/index.html. The hosted React
   page (frontend/src/pages/ActivityPage.tsx) drives window.__fcApp.mount()
   itself and deliberately never loads this script, which is what keeps the
   60-second poll off production (D-6). Keep fetching logic here, not in
   app.js — app.js is the shared render layer. */
(() => {
const $=s=>document.querySelector(s);
const live=$("#live"), liveText=$("#live-text"), refreshBtn=$("#btn-refresh"), banner=$("#banner");
const handle=window.__fcApp.mount();
let timer=null, D=null;

function status(state,text){ live.className="live "+state; liveText.textContent=text; }
const clock=iso=>new Date(iso).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});

async function load(force){
  refreshBtn.disabled=true;
  status(D?"stale":"", D?"refreshing…":"loading…");
  try{
    const res=await fetch("/api/stats"+(force?"?refresh=1":""), {cache:"no-store"});
    if(!res.ok){
      let detail="Request failed ("+res.status+").";
      try{ const body=await res.json(); if(body.detail) detail=body.detail; }catch(e){}
      throw new Error(detail);
    }
    D=await res.json();
    handle.update(D);
    banner.hidden=true;
    status("ok","updated "+clock(D.generated_at));
    schedule();
  }catch(err){
    status("error", D?"stale — retrying":"no data");
    banner.hidden=false;
    banner.innerHTML="<b>Cannot refresh from production.</b> "+err.message+
      (D?" Showing the last successful snapshot.":"");
    schedule();
  }finally{
    refreshBtn.disabled=false;
  }
}
function schedule(){
  clearTimeout(timer);
  const secs=(D&&D.poll_interval_seconds)||60;
  timer=setTimeout(()=>load(false), secs*1000);
}
refreshBtn.addEventListener("click",()=>load(true));
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) load(false); });
load(false);
})();
