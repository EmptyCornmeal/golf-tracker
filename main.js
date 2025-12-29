// main.js
/**
 * Phase 2 + 3 upgrade:
 * - Detail mode hole fields (optional): putts, penalties, FIR, GIR, first putt bucket, notes
 * - Player profile + handicap scaffolding + score differentials (18 only; 9 marked partial)
 * - Analysis pages: Putting, Mistakes, Course view, Archetypes
 * - Filter bar across analysis pages
 * - Import: JSON + CSV (long format, one row per hole)
 * - Export: JSON + CSV (long format)
 * - Insights engine + simple goal tracking
 * - Persistence moved to IndexedDB with migration from old localStorage
 *
 * PASSWORD SETUP:
 * 1) Pick a password string.
 * 2) In browser console, run:
 *    (async () => {
 *      const enc = new TextEncoder().encode("YOUR_PASSWORD");
 *      const buf = await crypto.subtle.digest("SHA-256", enc);
 *      console.log([...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""));
 *    })();
 * 3) Paste the hex into PASSWORD_SHA256_HEX.
 */

const PASSWORD_SHA256_HEX = "ced15993b5a2e1e23a24fa7bac91e68665a8584b3c2928415218c234c709c6f7";
const UNLOCK_KEY = "golfTracker.unlocked.v1";

// Old/localStorage key (migration)
const LEGACY_STORAGE_KEY = "golfTracker.v1";

// IndexedDB config
const DB_NAME = "golfTrackerDB";
const DB_VER = 1;
const KV_STORE = "kv";
const KV_KEY = "store_v2";

const V2_DEFAULT = {
  version: 2,
  playerProfile: { homeCountryRuleset: "WHS_UK", handicapIndex: null },
  goals: {
    // Auto goal: reduce doubles+ by 20% over next 5 rounds (based on baseline = last 5)
    active: true,
    type: "reduce_blowups",
    windowRounds: 5,
    reductionPct: 20,
    baselineBlowups: null,
    createdAt: null
  },
  courses: [],
  rounds: []
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function uid(prefix="id"){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; }

function todayISODate(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

async function sha256Hex(str){
  const enc=new TextEncoder().encode(str);
  const buf=await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

/* ---------------- IndexedDB KV ---------------- */
function idbOpen(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

async function idbGet(key){
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(KV_STORE,"readonly");
    const st=tx.objectStore(KV_STORE);
    const rq=st.get(key);
    rq.onsuccess=()=>resolve(rq.result ?? null);
    rq.onerror=()=>reject(rq.error);
  });
}

async function idbSet(key,val){
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(KV_STORE,"readwrite");
    tx.objectStore(KV_STORE).put(val,key);
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error);
  });
}

/* ---------------- Store load/save + migration ---------------- */
let store = structuredClone(V2_DEFAULT);

function isV2(obj){ return obj && obj.version===2 && Array.isArray(obj.courses) && Array.isArray(obj.rounds); }

function migrateLegacyToV2(legacy){
  // legacy: {courses:[], rounds:[]} from phase 1
  const v2 = structuredClone(V2_DEFAULT);
  v2.courses = legacy.courses ?? [];
  v2.rounds = (legacy.rounds ?? []).map(r => ({
    ...r,
    // ensure detail fields exist (optional)
    adjustedGross: r.adjustedGross ?? null,
    holeResults: (r.holeResults ?? []).map(hr => ({
      holeNumber: hr.holeNumber,
      score: hr.score ?? 0,
      putts: hr.putts ?? null,
      penalties: hr.penalties ?? null,
      fairwayHit: hr.fairwayHit ?? null,
      gir: hr.gir ?? null,
      firstPuttBucket: hr.firstPuttBucket ?? "",
      holeNotes: hr.holeNotes ?? ""
    }))
  }));
  return v2;
}

async function loadStore(){
  // Prefer IDB
  const fromIdb = await idbGet(KV_KEY);
  if (isV2(fromIdb)) return fromIdb;

  // Try migrate from legacy localStorage
  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw){
    try{
      const legacy = JSON.parse(legacyRaw);
      if (legacy?.courses && legacy?.rounds){
        const migrated = migrateLegacyToV2(legacy);
        await idbSet(KV_KEY, migrated);
        return migrated;
      }
    }catch{}
  }

  // No data — seed default
  await idbSet(KV_KEY, structuredClone(V2_DEFAULT));
  return structuredClone(V2_DEFAULT);
}

async function saveStore(){
  await idbSet(KV_KEY, store);
}

/* ---------------- Seed example if empty ---------------- */
function seedIfEmpty(){
  if (store.courses.length>0) return;
  const courseId=uid("course");
  const teeId=uid("tee");
  const holes = Array.from({length:18},(_,i)=>({
    holeNumber:i+1,
    par:[4,4,3,4,5,4,3,4,5,4,4,3,4,5,4,3,4,5][i] ?? 4,
    yardage: 350 + (i%5)*20,
    strokeIndex:i+1
  }));
  store.courses.push({
    courseId,
    name:"Example Course (edit me)",
    location:"—",
    tees:[{
      teeId,
      teeName:"White",
      courseRating:71.2,
      slopeRating:128,
      parTotal:holes.reduce((a,h)=>a+Number(h.par||0),0),
      holes
    }]
  });
}

/* ---------------- Views ---------------- */
const views=["portal","addRound","courses","putting","mistakes","courseView","archetypes","raw"];

function setView(view){
  views.forEach(v=>{
    $(`#view-${v}`).classList.toggle("active", v===view);
    $(`.tab[data-view="${v}"]`).classList.toggle("active", v===view);
  });
  $("#subtitle").textContent = ({
    portal:"Portal",
    addRound:"Add round",
    courses:"Courses",
    putting:"Putting",
    mistakes:"Mistakes",
    courseView:"Course view",
    archetypes:"Archetypes",
    raw:"Raw data"
  })[view] ?? "Portal";

  // Only show filter bar on analysis views (not portal/add/courses)
  const showFilter = ["putting","mistakes","courseView","archetypes"].includes(view);
  $("#filterbar").style.display = showFilter ? "block" : "none";

  if (showFilter) renderAnalysis();
}

$$(".tab").forEach(btn=>btn.addEventListener("click", ()=>setView(btn.dataset.view)));

/* ---------------- Gate ---------------- */
function isUnlocked(){ return localStorage.getItem(UNLOCK_KEY)==="1"; }
function lockApp(){
  localStorage.removeItem(UNLOCK_KEY);
  $("#gate").classList.remove("hidden");
  $("#gatePassword").value="";
  $("#gateMsg").textContent="";
}
async function unlockAttempt(pw){
  if (!PASSWORD_SHA256_HEX || PASSWORD_SHA256_HEX==="REPLACE_ME_WITH_YOUR_SHA256_HEX"){
    $("#gateMsg").textContent="Set PASSWORD_SHA256_HEX in main.js first.";
    return false;
  }
  const hex=await sha256Hex(pw);
  if (hex===PASSWORD_SHA256_HEX){
    localStorage.setItem(UNLOCK_KEY,"1");
    $("#gate").classList.add("hidden");
    return true;
  }
  return false;
}
$("#gateForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  $("#gateMsg").textContent="";
  const ok = await unlockAttempt($("#gatePassword").value||"");
  if(!ok) $("#gateMsg").textContent="Nope. Try again.";
  else await boot();
});
$("#btnLock").addEventListener("click", lockApp);
if (isUnlocked()) $("#gate").classList.add("hidden");

/* ---------------- Lookup helpers ---------------- */
function getCourse(courseId){ return store.courses.find(c=>c.courseId===courseId) ?? null; }
function getTee(courseId, teeId){ return getCourse(courseId)?.tees?.find(t=>t.teeId===teeId) ?? null; }
function courseLabel(courseId){ return getCourse(courseId)?.name ?? "—"; }
function teeLabel(courseId, teeId){ return getTee(courseId, teeId)?.teeName ?? "—"; }

function holesForRound(round){
  const tee=getTee(round.courseId, round.teeId);
  if(!tee) return [];
  const start=Number(round.startHole||1);
  const format=Number(round.format||18);
  const ordered = start===10 ? [...tee.holes.slice(9), ...tee.holes.slice(0,9)] : [...tee.holes];
  return ordered.slice(0, format);
}
function parForPlayedHoles(round){ return holesForRound(round).reduce((a,h)=>a+Number(h.par||0),0); }
function grossForRound(round){ return (round.holeResults??[]).reduce((a,r)=>a+Number(r.score||0),0); }
function puttsForRound(round){
  const vals=(round.holeResults??[]).map(r=>Number(r.putts||0)).filter(v=>v>0);
  return vals.length ? vals.reduce((a,v)=>a+v,0) : null;
}
function pensForRound(round){
  const vals=(round.holeResults??[]).map(r=>Number(r.penalties||0)).filter(v=>v>0);
  return vals.length ? vals.reduce((a,v)=>a+v,0) : 0;
}
function toParForRound(round){
  const gross=grossForRound(round);
  return gross - parForPlayedHoles(round);
}
function normalizeTo18(value, format){
  const f=Number(format||18);
  if (f===18) return value;
  if (f===9) return value*2;
  return value;
}

/* ---------------- Handicap scaffolding ---------------- */
function scoreDifferential(round){
  const tee=getTee(round.courseId, round.teeId);
  if(!tee) return null;

  const cr = Number(tee.courseRating ?? NaN);
  const slope = Number(tee.slopeRating ?? NaN);
  if (!Number.isFinite(cr) || !Number.isFinite(slope) || slope<=0) return null;

  const gross = grossForRound(round);
  const adj = Number(round.adjustedGross ?? NaN);
  const adjustedGross = Number.isFinite(adj) ? adj : gross;

  const pcc = 0; // placeholder
  const diff = (adjustedGross - cr - pcc) * 113 / slope;

  if (Number(round.format) === 9) {
    return { value: diff, partial: true };
  }
  if (Number(round.format) === 18) {
    return { value: diff, partial: false };
  }
  return null;
}

/* ---------------- Metrics ---------------- */
function blowupCount(round){
  const holes=holesForRound(round);
  const res=round.holeResults??[];
  let count=0;
  for(let i=0;i<Math.min(holes.length,res.length);i++){
    const par=Number(holes[i]?.par||0);
    const score=Number(res[i]?.score||0);
    if (score>=par+2) count++;
  }
  return count;
}

function roundVolatility(round){
  const holes=holesForRound(round);
  const res=round.holeResults??[];
  const diffs=[];
  for(let i=0;i<Math.min(holes.length,res.length);i++){
    diffs.push(Number(res[i]?.score||0)-Number(holes[i]?.par||0));
  }
  if(diffs.length<2) return 0;
  const mean=diffs.reduce((a,x)=>a+x,0)/diffs.length;
  const varr=diffs.reduce((a,x)=>a+(x-mean)**2,0)/(diffs.length-1);
  return Math.sqrt(varr);
}

function scoringByParType(rounds){
  const buckets={3:[],4:[],5:[]};
  for(const r of rounds){
    const holes=holesForRound(r);
    const res=r.holeResults??[];
    for(let i=0;i<Math.min(holes.length,res.length);i++){
      const par=Number(holes[i].par||0);
      const score=Number(res[i].score||0);
      if([3,4,5].includes(par) && score) buckets[par].push(score-par);
    }
  }
  const avg=(arr)=>arr.length ? arr.reduce((a,x)=>a+x,0)/arr.length : null;
  return {p3:avg(buckets[3]),p4:avg(buckets[4]),p5:avg(buckets[5])};
}

function scoringBySIBucket(rounds){
  const b={hard:[],mid:[],easy:[]};
  for(const r of rounds){
    const holes=holesForRound(r);
    const res=r.holeResults??[];
    for(let i=0;i<Math.min(holes.length,res.length);i++){
      const si=Number(holes[i].strokeIndex||0);
      const par=Number(holes[i].par||0);
      const score=Number(res[i].score||0);
      if(!si || !score) continue;
      const d=score-par;
      if(si<=6) b.hard.push(d);
      else if(si<=12) b.mid.push(d);
      else b.easy.push(d);
    }
  }
  const avg=(arr)=>arr.length ? arr.reduce((a,x)=>a+x,0)/arr.length : null;
  return {hard:avg(b.hard),mid:avg(b.mid),easy:avg(b.easy)};
}

/* ---------------- Insights + targets + goals ---------------- */
function insightEngine(rounds){
  if(rounds.length<3) return ["Log a few more rounds and I’ll start spotting patterns."];

  const sorted=[...rounds].sort((a,b)=>new Date(a.date)-new Date(b.date));
  const last10=sorted.slice(-10);
  const prev10=sorted.slice(-20,-10);

  const avgToPar=(arr)=>arr.length ? arr.map(r=>normalizeTo18(toParForRound(r), r.format)).reduce((a,x)=>a+x,0)/arr.length : null;
  const aLast=avgToPar(last10);
  const aPrev=avgToPar(prev10);

  const msgs=[];
  if(aLast!=null && aPrev!=null){
    const delta = aPrev - aLast; // positive = improved
    msgs.push(`Last 10 rounds vs previous 10: ${delta>=0?`improved by ~${delta.toFixed(1)}`:`worse by ~${Math.abs(delta).toFixed(1)}`} strokes (18-normalized).`);
  } else if (aLast!=null){
    msgs.push(`Last 10 rounds average: ${aLast>0?`+${aLast.toFixed(1)}`:aLast.toFixed(1)} to par (18-normalized).`);
  }

  // Blow-ups on hard holes?
  const si=scoringBySIBucket(last10);
  if(si.hard!=null && si.easy!=null){
    const gap=si.hard - si.easy;
    if(gap>0.6) msgs.push("You leak more strokes on SI 1–6 than easy holes — play the hard holes like bogey holes.");
  }

  // Fatigue pattern: compare first half vs second half scoring
  const fatigue = fatiguePattern(last10);
  if(fatigue) msgs.push(fatigue);

  // Penalties signal (if present)
  const pens = last10.map(pensForRound).filter(v=>v!=null);
  if(pens.length){
    const ap = pens.reduce((a,x)=>a+x,0)/pens.length;
    if(ap>=2) msgs.push("Penalties are a real lever right now. Removing just 1 penalty per round is basically free strokes gained.");
  }

  return msgs.slice(0,4);
}

function fatiguePattern(rounds){
  // Use hole score vs par; first half vs second half of holes played
  const diffs=[];
  for(const r of rounds){
    const holes=holesForRound(r);
    const res=r.holeResults??[];
    const per=[];
    for(let i=0;i<Math.min(holes.length,res.length);i++){
      per.push(Number(res[i]?.score||0)-Number(holes[i]?.par||0));
    }
    if(per.length<6) continue;
    const half=Math.floor(per.length/2);
    const a1=per.slice(0,half).reduce((a,x)=>a+x,0)/half;
    const a2=per.slice(half).reduce((a,x)=>a+x,0)/(per.length-half);
    diffs.push(a2-a1);
  }
  if(!diffs.length) return null;
  const avg = diffs.reduce((a,x)=>a+x,0)/diffs.length;
  if (avg>0.4) return "Second-half scoring is worse (fatigue/tilt pattern). Try a reset routine on holes 6/12: water, breathe, boring tee shot.";
  if (avg<-0.4) return "You tend to finish stronger. Nice — keep the momentum mindset early.";
  return null;
}

function nextRoundTargets(rounds){
  if(!rounds.length){
    return [
      "Log your next round hole-by-hole (scores only is fine).",
      "Keep the ball in play — boring golf is underrated.",
      "Pick one thing: commit to conservative targets on SI 1–6 holes."
    ];
  }
  const lastN=rounds.slice(-6);
  const avgBlow=lastN.reduce((a,r)=>a+blowupCount(r),0)/lastN.length;
  const avgVol=lastN.reduce((a,r)=>a+roundVolatility(r),0)/lastN.length;
  const si=scoringBySIBucket(lastN);
  const targets=[];

  if(avgBlow>=3) targets.push("Cut doubles+ first: when you’re cooked, punch out and take the bogey.");
  else targets.push("Protect momentum: bogey is fine — doubles are the enemy.");

  if(avgVol>=1.2) targets.push("Stabilise: pick 3 tee shots to play safer lines (or less club) and stick to it.");
  else targets.push("You’re steady — push one low-risk edge (club up on par 3s, or smarter layups).");

  if(si.hard!=null && si.easy!=null && (si.hard-si.easy)>0.6) targets.push("Hard holes tax you: aim centre-green, accept bogey, avoid hero shots.");
  else targets.push("On tough holes: swing at 80–90% and commit to a safe target.");

  return targets.slice(0,3);
}

function ensureGoal(rounds){
  const g=store.goals;
  if(!g?.active) return;

  // baseline = average blowups over last window when goal is created
  if(g.baselineBlowups==null){
    const last=rounds.slice(-g.windowRounds);
    if(last.length>=3){
      g.baselineBlowups = last.reduce((a,r)=>a+blowupCount(r),0)/last.length;
      g.createdAt = todayISODate();
    }
  }
}

function goalProgress(rounds){
  const g=store.goals;
  if(!g?.active || g.baselineBlowups==null) return {pct:null,title:"—",sub:"—"};

  const window=g.windowRounds;
  const recent=rounds.slice(-window);
  if(recent.length<3) return {pct:null,title:"Need more rounds",sub:"Log a few more to track this goal."};

  const current=recent.reduce((a,r)=>a+blowupCount(r),0)/recent.length;
  const target = g.baselineBlowups * (1 - g.reductionPct/100);

  // pct = progress toward target
  const denom = (g.baselineBlowups - target) || 1;
  const pct = clamp(((g.baselineBlowups - current) / denom) * 100, 0, 100);

  return {
    pct,
    title: `Reduce doubles+ by ${g.reductionPct}%`,
    sub: `Baseline ${g.baselineBlowups.toFixed(1)} → target ${target.toFixed(1)}. Current ${current.toFixed(1)}.`
  };
}

/* ---------------- Filters ---------------- */
function renderFilterOptions(){
  const courses = store.courses.map(c=>({value:c.courseId,label:c.name}));
  const optCourses = [{value:"all",label:"All"}].concat(courses);
  $("#fCourse").innerHTML = optCourses.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join("");
  $("#fCourse").value = $("#fCourse").value || "all";
  syncFilterTees();
}

function syncFilterTees(){
  const courseId = $("#fCourse").value;
  let tees = [];
  if (courseId==="all"){
    // all tees
    tees = store.courses.flatMap(c=>c.tees.map(t=>({courseId:c.courseId, teeId:t.teeId, label:`${c.name} — ${t.teeName}`})));
    $("#fTee").innerHTML = `<option value="all">All</option>` +
      tees.map(t=>`<option value="${escapeAttr(`${t.courseId}::${t.teeId}`)}">${escapeHtml(t.label)}</option>`).join("");
    $("#fTee").value = "all";
  } else {
    const c=getCourse(courseId);
    const opts=[{value:"all",label:"All"}].concat((c?.tees??[]).map(t=>({value:t.teeId,label:t.teeName})));
    $("#fTee").innerHTML = opts.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join("");
    $("#fTee").value = $("#fTee").value || "all";
  }
}

function applyFilters(rounds){
  const fFrom=$("#fFrom").value;
  const fTo=$("#fTo").value;
  const fCourse=$("#fCourse").value;
  const fTee=$("#fTee").value;
  const fType=$("#fType").value;
  const fFormat=$("#fFormat").value;

  return rounds.filter(r=>{
    if (fFrom && r.date < fFrom) return false;
    if (fTo && r.date > fTo) return false;

    if (fType!=="all" && r.roundType!==fType) return false;
    if (fFormat!=="all" && String(r.format)!==String(fFormat)) return false;

    if (fCourse!=="all" && r.courseId!==fCourse) return false;

    if (fCourse==="all"){
      if (fTee!=="all"){
        const [cid,tid]=String(fTee).split("::");
        if (r.courseId!==cid || r.teeId!==tid) return false;
      }
    } else {
      if (fTee!=="all" && r.teeId!==fTee) return false;
    }

    return true;
  });
}

$("#fCourse").addEventListener("change", ()=>{ syncFilterTees(); renderAnalysis(); });
$("#fTee").addEventListener("change", renderAnalysis);
$("#fFrom").addEventListener("change", renderAnalysis);
$("#fTo").addEventListener("change", renderAnalysis);
$("#fType").addEventListener("change", renderAnalysis);
$("#fFormat").addEventListener("change", renderAnalysis);
$("#btnClearFilters").addEventListener("click", ()=>{
  $("#fFrom").value=""; $("#fTo").value="";
  $("#fCourse").value="all"; syncFilterTees();
  $("#fType").value="all"; $("#fFormat").value="all";
  renderAnalysis();
});

/* ---------------- Charts ---------------- */
let chartTrend, chartByPar, chartBySI;
let chartPuttsTrend, chartPensTrend, chartPensVsBlowups, chartArcheSI, chartArcheYds;

function destroyCharts(){
  [chartTrend,chartByPar,chartBySI,chartPuttsTrend,chartPensTrend,chartPensVsBlowups,chartArcheSI,chartArcheYds].forEach(c=>c?.destroy?.());
  chartTrend=chartByPar=chartBySI=chartPuttsTrend=chartPensTrend=chartPensVsBlowups=chartArcheSI=chartArcheYds=null;
}

function renderPortalCharts(rounds){
  destroyCharts();

  const sorted=[...rounds].sort((a,b)=>new Date(a.date)-new Date(b.date));
  const labels=sorted.map(r=>r.date);
  const toPar=sorted.map(r=>normalizeTo18(toParForRound(r), r.format));

  chartTrend=new Chart($("#chartTrend"),{
    type:"line",
    data:{labels,datasets:[{label:"To par (18-normalized)",data:toPar,tension:0.3}]},
    options:{
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{
          afterBody:(items)=>{
            const idx=items?.[0]?.dataIndex;
            const r=sorted[idx];
            if(!r) return "";
            const raw=toParForRound(r);
            return r.format===9 ? `Raw 9-hole to-par: ${raw>=0?"+":""}${raw}` : `Raw 18-hole to-par: ${raw>=0?"+":""}${raw}`;
          }
        }}
      },
      scales:{ y:{ticks:{callback:(v)=> (v>0?`+${v}`:`${v}`)}}}
    }
  });

  const byPar=scoringByParType(sorted);
  chartByPar=new Chart($("#chartByPar"),{
    type:"bar",
    data:{labels:["Par 3","Par 4","Par 5"],datasets:[{label:"Avg vs par",data:[byPar.p3,byPar.p4,byPar.p5].map(v=>v??0)}]},
    options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:(v)=> (v>0?`+${v}`:`${v}`)}}}}
  });

  const bySI=scoringBySIBucket(sorted);
  chartBySI=new Chart($("#chartBySI"),{
    type:"bar",
    data:{labels:["SI 1–6","SI 7–12","SI 13–18"],datasets:[{label:"Avg vs par",data:[bySI.hard,bySI.mid,bySI.easy].map(v=>v??0)}]},
    options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:(v)=> (v>0?`+${v}`:`${v}`)}}}}
  });
}

/* ---------------- Portal render ---------------- */
function renderPortal(){
  const rounds=[...store.rounds].sort((a,b)=>new Date(a.date)-new Date(b.date));

  $("#chipRounds").textContent=`${rounds.length} round${rounds.length===1?"":"s"}`;

  // handicap display
  const h = store.playerProfile?.handicapIndex;
  $("#chipHcp").textContent = `Handicap: ${h==null || h==="" ? "—" : Number(h).toFixed(1)}`;

  if(!rounds.length){
    $("#chipBest").textContent="Best: —";
    $("#chipAvg").textContent="Avg to par: —";
    $("#kpiBlowups").textContent="—";
    $("#kpiVolatility").textContent="—";
    $("#targets").innerHTML=`<li>Add a course, then log your first round.</li>`;
    $("#insights").textContent="";
    renderPortalCharts([]);
    return;
  }

  ensureGoal(rounds);

  const toPars=rounds.map(r=>normalizeTo18(toParForRound(r), r.format));
  const best=Math.min(...toPars);
  const avg=toPars.reduce((a,x)=>a+x,0)/toPars.length;

  $("#chipBest").textContent=`Best: ${best>0?`+${best}`:`${best}`}`;
  $("#chipAvg").textContent=`Avg to par: ${avg>0?`+${avg.toFixed(1)}`:`${avg.toFixed(1)}`}`;

  const avgBlow=rounds.reduce((a,r)=>a+blowupCount(r),0)/rounds.length;
  const avgVol=rounds.reduce((a,r)=>a+roundVolatility(r),0)/rounds.length;
  $("#kpiBlowups").textContent=avgBlow.toFixed(1);
  $("#kpiVolatility").textContent=avgVol.toFixed(2);

  const targets=nextRoundTargets(rounds);
  $("#targets").innerHTML=targets.map(t=>`<li>${escapeHtml(t)}</li>`).join("");

  const insights=insightEngine(rounds);
  $("#insights").innerHTML = `<strong>Insights:</strong><br/>` + insights.map(x=>`• ${escapeHtml(x)}`).join("<br/>");

  const gp = goalProgress(rounds);
  $("#goalTitle").textContent = gp.title;
  $("#goalSub").textContent = gp.sub;
  $("#goalPct").textContent = gp.pct==null ? "—" : `${Math.round(gp.pct)}%`;
  const ring = document.querySelector(".goal-ring");
  ring.style.setProperty("--pct", `${gp.pct==null?0:gp.pct}%`);

  renderPortalCharts(rounds);
}

/* ---------------- Add round (detail mode table) ---------------- */
function setSelectOptions(selectEl, options, value){
  selectEl.innerHTML=options.map(o=>`<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join("");
  if(value!=null) selectEl.value=value;
}

function renderCourseSelects(){
  const opts=store.courses.map(c=>({value:c.courseId,label:c.name}));
  if(!opts.length) opts.push({value:"",label:"No courses yet — create one"});
  setSelectOptions($("#courseSelect"), opts, opts[0]?.value ?? "");
  setSelectOptions($("#courseList"), opts, opts[0]?.value ?? "");
  renderFilterOptions();
  syncTeeSelects();
}

function syncTeeSelects(){
  const courseId=$("#courseSelect").value || store.courses[0]?.courseId;
  const c=getCourse(courseId);
  const teeOpts=(c?.tees??[]).map(t=>({value:t.teeId,label:t.teeName}));
  if(!teeOpts.length) teeOpts.push({value:"",label:"No tees — add in Courses"});
  setSelectOptions($("#teeSelect"), teeOpts, teeOpts[0]?.value ?? "");
  buildScoreTablePreview();
}

function scoreTableHeader(detail){
  if(!detail){
    return `
      <tr>
        <th>Hole</th><th>Par</th><th>SI</th><th>Yds</th><th>Your score</th>
      </tr>`;
  }
  return `
    <tr>
      <th>Hole</th><th>Par</th><th>SI</th><th>Yds</th>
      <th>Score</th><th>Putts</th><th>Pen</th>
      <th>FIR</th><th>GIR</th>
      <th>1st putt</th>
      <th>Notes</th>
    </tr>`;
}

function buildScoreTablePreview(){
  const courseId=$("#courseSelect").value;
  const teeId=$("#teeSelect").value;
  const format=Number($("#roundFormat").value||18);
  const startHole=Number($("#startHole").value||1);
  const detail=$("#detailMode").checked;

  const tee=getTee(courseId, teeId);
  const tbody=$("#scoreTable tbody");
  $("#scoreHead").innerHTML = scoreTableHeader(detail);
  tbody.innerHTML="";

  if(!tee){
    $("#sumGross").textContent="—";
    $("#sumToPar").textContent="—";
    $("#sumPutts").textContent="—";
    $("#sumPens").textContent="—";
    tbody.innerHTML=`<tr><td colspan="12" class="muted">Select a course + tee to enter scores.</td></tr>`;
    return;
  }

  const ordered = startHole===10 ? [...tee.holes.slice(9), ...tee.holes.slice(0,9)] : [...tee.holes];
  const holes = ordered.slice(0, format);

  for(const h of holes){
    const tr=document.createElement("tr");

    if(!detail){
      tr.innerHTML=`
        <td>${h.holeNumber}</td>
        <td>${escapeHtml(String(h.par??""))}</td>
        <td>${escapeHtml(String(h.strokeIndex??""))}</td>
        <td>${escapeHtml(String(h.yardage??""))}</td>
        <td><input class="scoreInput" type="number" min="1" max="20" step="1" placeholder="—" /></td>
      `;
    } else {
      tr.innerHTML=`
        <td>${h.holeNumber}</td>
        <td>${escapeHtml(String(h.par??""))}</td>
        <td>${escapeHtml(String(h.strokeIndex??""))}</td>
        <td>${escapeHtml(String(h.yardage??""))}</td>

        <td><input class="scoreInput" type="number" min="1" max="20" step="1" placeholder="—" /></td>
        <td><input class="puttsInput" type="number" min="0" max="6" step="1" placeholder="—" /></td>
        <td><input class="pensInput" type="number" min="0" max="5" step="1" placeholder="—" /></td>

        <td>
          <select class="firInput">
            <option value=""></option>
            <option value="true">Y</option>
            <option value="false">N</option>
          </select>
        </td>
        <td>
          <select class="girInput">
            <option value=""></option>
            <option value="true">Y</option>
            <option value="false">N</option>
          </select>
        </td>

        <td>
          <select class="bucketInput">
            <option value=""></option>
            <option value="0-3">0–3</option>
            <option value="4-6">4–6</option>
            <option value="7-10">7–10</option>
            <option value="11-20">11–20</option>
            <option value="20+">20+</option>
          </select>
        </td>

        <td><input class="holeNoteInput" type="text" placeholder="—" /></td>
      `;
    }

    tbody.appendChild(tr);
  }

  const inputs = [...tbody.querySelectorAll("input,select")];
  inputs.forEach(el=>el.addEventListener("input", updateScoreSummary));
  updateScoreSummary();
}

function updateScoreSummary(){
  const courseId=$("#courseSelect").value;
  const teeId=$("#teeSelect").value;
  const format=Number($("#roundFormat").value||18);
  const startHole=Number($("#startHole").value||1);
  const tee=getTee(courseId, teeId);
  if(!tee) return;

  const ordered=startHole===10 ? [...tee.holes.slice(9), ...tee.holes.slice(0,9)] : [...tee.holes];
  const holes=ordered.slice(0, format);

  const scores=$$(".scoreInput");
  const putts=$$(".puttsInput");
  const pens=$$(".pensInput");

  let gross=0, par=0, p=0, pen=0;
  for(let i=0;i<holes.length;i++){
    const s=Number(scores[i]?.value||0);
    if(s>0) gross+=s;
    par+=Number(holes[i].par||0);

    const pt=Number(putts[i]?.value||0);
    if(pt>0) p+=pt;

    const pn=Number(pens[i]?.value||0);
    if(pn>0) pen+=pn;
  }

  $("#sumGross").textContent = gross ? String(gross) : "—";
  const tp = gross ? gross-par : null;
  $("#sumToPar").textContent = tp==null ? "—" : (tp>0?`+${tp}`:`${tp}`);

  $("#sumPutts").textContent = p ? String(p) : "—";
  $("#sumPens").textContent = pen ? String(pen) : "—";
}

$("#courseSelect").addEventListener("change", syncTeeSelects);
$("#teeSelect").addEventListener("change", buildScoreTablePreview);
$("#roundFormat").addEventListener("change", buildScoreTablePreview);
$("#startHole").addEventListener("change", buildScoreTablePreview);
$("#detailMode").addEventListener("change", buildScoreTablePreview);

$("#roundDate").value=todayISODate();

$("#roundForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  $("#roundMsg").textContent="";

  const courseId=$("#courseSelect").value;
  const teeId=$("#teeSelect").value;
  const course=getCourse(courseId);
  const tee=getTee(courseId, teeId);
  if(!course || !tee){
    $("#roundMsg").textContent="Pick a course + tee first (or create one in Courses).";
    return;
  }

  const format=Number($("#roundFormat").value||18);
  const startHole=Number($("#startHole").value||1);
  const detail=$("#detailMode").checked;

  const rows=[...$("#scoreTable tbody").querySelectorAll("tr")];

  const holeResults = rows.map((tr, idx)=> {
    const score = clamp(Number(tr.querySelector(".scoreInput")?.value || 0), 0, 30);

    if(!detail){
      return {
        holeNumber: idx+1,
        score,
        putts: null,
        penalties: null,
        fairwayHit: null,
        gir: null,
        firstPuttBucket: "",
        holeNotes: ""
      };
    }

    const putts = tr.querySelector(".puttsInput")?.value;
    const pens = tr.querySelector(".pensInput")?.value;

    const fir = tr.querySelector(".firInput")?.value;
    const gir = tr.querySelector(".girInput")?.value;

    return {
      holeNumber: idx+1,
      score,
      putts: putts==="" ? null : clamp(Number(putts),0,6),
      penalties: pens==="" ? null : clamp(Number(pens),0,5),
      fairwayHit: fir==="" ? null : (fir==="true"),
      gir: gir==="" ? null : (gir==="true"),
      firstPuttBucket: tr.querySelector(".bucketInput")?.value || "",
      holeNotes: (tr.querySelector(".holeNoteInput")?.value || "").trim()
    };
  });

  const anyScore = holeResults.some(r=>r.score>0);
  if(!anyScore){
    $("#roundMsg").textContent="Enter at least one hole score.";
    return;
  }

  const adjustedRaw=$("#adjustedGross").value.trim();
  const adjustedGross = adjustedRaw==="" ? null : clamp(Number(adjustedRaw), 1, 999);

  const round={
    roundId:uid("round"),
    date:$("#roundDate").value,
    roundType:$("#roundType").value,
    format,
    startHole,
    courseId,
    teeId,
    ruleset:{strictRules:true},
    notes:($("#roundNotes").value||"").trim(),
    adjustedGross,
    holeResults
  };

  store.rounds.push(round);
  await saveStore();

  // reset
  $("#roundNotes").value="";
  $("#adjustedGross").value="";
  rows.forEach(tr=>{
    tr.querySelectorAll("input").forEach(i=>i.value="");
    tr.querySelectorAll("select").forEach(s=>s.value="");
  });

  $("#roundMsg").textContent="Saved ✅";
  await renderAll();
  setView("portal");
});

$("#btnNewCourseQuick").addEventListener("click", ()=>{ setView("courses"); startNewCourse(); });

/* ---------------- Courses editor + profile ---------------- */
function buildHolesEditor(tbody, holes){
  tbody.innerHTML="";
  for(let i=0;i<18;i++){
    const h=holes[i] ?? {holeNumber:i+1, par:"", yardage:"", strokeIndex:i+1};
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td>${i+1}</td>
      <td><input class="holePar" type="number" min="3" max="6" step="1" value="${escapeAttr(h.par ?? "")}" /></td>
      <td><input class="holeYds" type="number" min="50" max="700" step="1" value="${escapeAttr(h.yardage ?? "")}" /></td>
      <td><input class="holeSI" type="number" min="1" max="18" step="1" value="${escapeAttr(h.strokeIndex ?? (i+1))}" /></td>
    `;
    tbody.appendChild(tr);
  }
}

let editingCourseId=null;
let editingTeeId=null;

function startNewCourse(){
  editingCourseId=null;
  editingTeeId=null;
  $("#courseEditorTitle").textContent="Course editor (new)";
  $("#courseName").value="";
  $("#courseLocation").value="";
  $("#teeName").value="White";
  $("#courseRating").value="";
  $("#slopeRating").value="";
  $("#courseMsg").textContent="";

  const holes=Array.from({length:18},(_,i)=>({holeNumber:i+1, par:"", yardage:"", strokeIndex:i+1}));
  buildHolesEditor($("#holesTable tbody"), holes);
}

function loadCourseIntoEditor(courseId){
  const c=getCourse(courseId);
  if(!c) return;
  const t=c.tees?.[0];
  if(!t) return;
  editingCourseId=c.courseId;
  editingTeeId=t.teeId;
  $("#courseEditorTitle").textContent="Course editor (editing)";
  $("#courseName").value=c.name ?? "";
  $("#courseLocation").value=c.location ?? "";
  $("#teeName").value=t.teeName ?? "White";
  $("#courseRating").value=t.courseRating ?? "";
  $("#slopeRating").value=t.slopeRating ?? "";
  $("#courseMsg").textContent="";
  buildHolesEditor($("#holesTable tbody"), t.holes ?? []);
}

$("#btnNewCourse").addEventListener("click", startNewCourse);

$("#btnEditCourse").addEventListener("click", ()=>{
  const id=$("#courseList").value;
  if(!id) return;
  loadCourseIntoEditor(id);
});

$("#btnDeleteCourse").addEventListener("click", async ()=>{
  const id=$("#courseList").value;
  if(!id) return;
  store.courses=store.courses.filter(c=>c.courseId!==id);
  store.rounds=store.rounds.filter(r=>r.courseId!==id);
  await saveStore();
  editingCourseId=null; editingTeeId=null;
  await renderAll();
  startNewCourse();
});

$("#btnAutofill").addEventListener("click", ()=>{
  const pars=[4,4,3,4,5,4,3,4,5,4,4,3,4,5,4,3,4,5];
  [...$("#holesTable tbody").querySelectorAll("tr")].forEach((tr,i)=>{
    tr.querySelector(".holePar").value=pars[i];
    tr.querySelector(".holeYds").value=330+(i%6)*25;
    tr.querySelector(".holeSI").value=i+1;
  });
});

$("#courseForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  $("#courseMsg").textContent="";

  const name=$("#courseName").value.trim();
  const location=$("#courseLocation").value.trim();
  const teeName=$("#teeName").value.trim() || "White";
  const courseRating = $("#courseRating").value ? Number($("#courseRating").value) : null;
  const slopeRating = $("#slopeRating").value ? Number($("#slopeRating").value) : null;

  const rows=[...$("#holesTable tbody").querySelectorAll("tr")];
  const holes=rows.map((tr,i)=>({
    holeNumber:i+1,
    par:Number(tr.querySelector(".holePar").value||0),
    yardage:Number(tr.querySelector(".holeYds").value||0),
    strokeIndex:Number(tr.querySelector(".holeSI").value|| (i+1))
  }));

  const parTotal=holes.reduce((a,h)=>a+(Number(h.par)||0),0);
  const hasPars=holes.every(h=>[3,4,5].includes(h.par));
  const hasSI=holes.every(h=>h.strokeIndex>=1 && h.strokeIndex<=18);

  if(!name){ $("#courseMsg").textContent="Course name is required."; return; }
  if(!hasPars){ $("#courseMsg").textContent="Every hole needs Par 3/4/5."; return; }
  if(!hasSI){ $("#courseMsg").textContent="Every hole needs stroke index 1–18."; return; }

  if(editingCourseId){
    const c=getCourse(editingCourseId);
    if(!c) return;
    c.name=name; c.location=location;
    if(!c.tees?.length) c.tees=[];
    let t=c.tees.find(x=>x.teeId===editingTeeId) || c.tees[0];
    if(!t){ t={teeId:uid("tee")}; c.tees.push(t); }
    t.teeName=teeName;
    t.courseRating=courseRating;
    t.slopeRating=slopeRating;
    t.holes=holes;
    t.parTotal=parTotal;
  } else {
    const courseId=uid("course");
    const teeId=uid("tee");
    store.courses.push({
      courseId,
      name,
      location,
      tees:[{teeId, teeName, courseRating, slopeRating, parTotal, holes}]
    });
    editingCourseId=courseId;
    editingTeeId=teeId;
  }

  await saveStore();
  $("#courseMsg").textContent="Saved ✅";
  await renderAll();
});

$("#btnSaveProfile").addEventListener("click", async ()=>{
  store.playerProfile.homeCountryRuleset = $("#ruleset").value;
  const v=$("#hcpIndex").value.trim();
  store.playerProfile.handicapIndex = v==="" ? null : Number(v);
  await saveStore();
  $("#profileMsg").textContent="Saved ✅";
  setTimeout(()=>$("#profileMsg").textContent="", 1200);
  renderPortal();
});

/* ---------------- Raw table ---------------- */
function renderRawTable(){
  const tbody=$("#roundsTable tbody");
  tbody.innerHTML="";

  const rounds=[...store.rounds].sort((a,b)=>new Date(b.date)-new Date(a.date));
  if(!rounds.length){
    tbody.innerHTML=`<tr><td colspan="8" class="muted">No rounds yet.</td></tr>`;
    return;
  }

  for(const r of rounds){
    const gross=grossForRound(r);
    const toPar=toParForRound(r);
    const d=scoreDifferential(r);
    const diffTxt = d==null ? "—" : `${d.value.toFixed(1)}${d.partial?" (9)":" "}`;
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td>${escapeHtml(r.date||"—")}</td>
      <td>${escapeHtml(r.roundType||"—")}</td>
      <td>${escapeHtml(courseLabel(r.courseId))}</td>
      <td>${escapeHtml(teeLabel(r.courseId, r.teeId))}</td>
      <td>${escapeHtml(String(r.format||"—"))}</td>
      <td>${gross||"—"}</td>
      <td>${gross ? (toPar>0?`+${toPar}`:`${toPar}`) : "—"}</td>
      <td>${escapeHtml(diffTxt)}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------- Analysis render ---------------- */
function renderAnalysis(){
  const all=[...store.rounds].sort((a,b)=>new Date(a.date)-new Date(b.date));
  const rounds=applyFilters(all);

  renderPutting(rounds);
  renderMistakes(rounds);
  renderCourseView(rounds);
  renderArchetypes(rounds);
}

function renderPutting(rounds){
  // Putts trend per round (avg putts/hole) for rounds where putts exist
  const xs=[], ys=[];
  for(const r of rounds){
    const holes = holesForRound(r).length || Number(r.format||18);
    const p = puttsForRound(r);
    if (p==null) continue;
    xs.push(r.date);
    ys.push(p / holes);
  }

  chartPuttsTrend?.destroy?.();
  chartPuttsTrend = new Chart($("#chartPuttsTrend"),{
    type:"line",
    data:{labels:xs,datasets:[{label:"Putts per hole",data:ys,tension:0.3}]},
    options:{plugins:{legend:{display:false}}}
  });

  // 3-putts rate
  let three=0, holesCount=0, puttsSum=0, puttHoles=0;
  for(const r of rounds){
    const holes=holesForRound(r);
    const res=r.holeResults??[];
    for(let i=0;i<Math.min(holes.length,res.length);i++){
      const p=Number(res[i].putts||0);
      if(p>0){ puttsSum+=p; puttHoles++; holesCount++; if(p>=3) three++; }
    }
  }

  $("#kpi3Putts").textContent = puttHoles ? (three / (rounds.length||1)).toFixed(1) : "—";
  $("#kpiPuttsHole").textContent = puttHoles ? (puttsSum / puttHoles).toFixed(2) : "—";
}

function renderMistakes(rounds){
  // Penalties trend per round
  const xs=[], ys=[], blow=[];
  for(const r of rounds){
    xs.push(r.date);
    ys.push(pensForRound(r));
    blow.push(blowupCount(r));
  }

  chartPensTrend?.destroy?.();
  chartPensTrend=new Chart($("#chartPensTrend"),{
    type:"line",
    data:{labels:xs,datasets:[{label:"Penalties per round",data:ys,tension:0.3}]},
    options:{plugins:{legend:{display:false}}}
  });

  chartPensVsBlowups?.destroy?.();
  chartPensVsBlowups=new Chart($("#chartPensVsBlowups"),{
    type:"scatter",
    data:{datasets:[{label:"Rounds",data:ys.map((p,i)=>({x:p,y:blow[i]}))}]},
    options:{
      plugins:{legend:{display:false}},
      scales:{
        x:{title:{display:true,text:"Penalties"}},
        y:{title:{display:true,text:"Blow-up holes (dbl+)"}}}
    }
  });
}

function renderCourseView(rounds){
  const tbody=$("#courseTable tbody");
  tbody.innerHTML="";

  const map=new Map();
  for(const r of rounds){
    const key=`${r.courseId}::${r.teeId}`;
    const arr=map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }

  const rows=[...map.entries()].map(([key, arr])=>{
    const [cid,tid]=key.split("::");
    const vals=arr.map(r=>normalizeTo18(toParForRound(r), r.format));
    const avg=vals.reduce((a,x)=>a+x,0)/vals.length;
    const best=Math.min(...vals);
    return {course:courseLabel(cid), tee:teeLabel(cid,tid), rounds:arr.length, avg, best};
  }).sort((a,b)=>a.avg-b.avg);

  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="5" class="muted">No data for current filters.</td></tr>`;
    return;
  }

  for(const r of rows){
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td>${escapeHtml(r.course)}</td>
      <td>${escapeHtml(r.tee)}</td>
      <td>${r.rounds}</td>
      <td>${r.avg>0?`+${r.avg.toFixed(1)}`:r.avg.toFixed(1)}</td>
      <td>${r.best>0?`+${r.best}`:r.best}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderArchetypes(rounds){
  const bySI=scoringBySIBucket(rounds);
  chartArcheSI?.destroy?.();
  chartArcheSI=new Chart($("#chartArcheSI"),{
    type:"bar",
    data:{labels:["SI 1–6","SI 7–12","SI 13–18"],datasets:[{label:"Avg vs par",data:[bySI.hard,bySI.mid,bySI.easy].map(v=>v??0)}]},
    options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:(v)=> (v>0?`+${v}`:`${v}`)}}}}
  });

  // Par-4 yardage buckets: 300-350, 351-400, 401-450, 451+
  const buckets=[
    {label:"300–350",min:300,max:350,vals:[]},
    {label:"351–400",min:351,max:400,vals:[]},
    {label:"401–450",min:401,max:450,vals:[]},
    {label:"451+",min:451,max:999,vals:[]}
  ];

  for(const r of rounds){
    const holes=holesForRound(r);
    const res=r.holeResults??[];
    for(let i=0;i<Math.min(holes.length,res.length);i++){
      const h=holes[i];
      if(Number(h.par)!==4) continue;
      const y=Number(h.yardage||0);
      const d=Number(res[i].score||0) - Number(h.par||0);
      const b=buckets.find(b=>y>=b.min && y<=b.max);
      if(b && Number.isFinite(d)) b.vals.push(d);
    }
  }

  const avgs=buckets.map(b=> b.vals.length ? b.vals.reduce((a,x)=>a+x,0)/b.vals.length : 0);

  chartArcheYds?.destroy?.();
  chartArcheYds=new Chart($("#chartArcheYds"),{
    type:"bar",
    data:{labels:buckets.map(b=>b.label),datasets:[{label:"Avg vs par",data:avgs}]},
    options:{plugins:{legend:{display:false}},scales:{y:{ticks:{callback:(v)=> (v>0?`+${v}`:`${v}`)}}}}
  });
}

/* ---------------- Export JSON + CSV ---------------- */
$("#btnExport").addEventListener("click", async ()=>{
  const payload=JSON.stringify(store, null, 2);
  downloadText(payload, `golf-tracker-export-${todayISODate()}.json`, "application/json");
});

$("#btnExportCSV").addEventListener("click", ()=>{
  const csv = exportCSVLong(store);
  downloadText(csv, `golf-tracker-export-${todayISODate()}.csv`, "text/csv");
});

function downloadText(text, filename, mime){
  const blob=new Blob([text],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=filename;
  document.body.appendChild(a);
  a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportCSVLong(data){
  const header = [
    "date","roundType","courseName","teeName","format","startHole","courseRating","slopeRating",
    "holeNumber","score","putts","penalties","fairwayHit","gir","firstPuttBucket","holeNotes","roundNotes"
  ].join(",");

  const lines=[header];

  for(const r of data.rounds){
    const c=getCourse(r.courseId);
    const t=getTee(r.courseId, r.teeId);
    const courseName = c?.name ?? "";
    const teeName = t?.teeName ?? "";
    const cr = t?.courseRating ?? "";
    const slope = t?.slopeRating ?? "";

    const rn = r.notes ?? "";
    const hr = r.holeResults ?? [];

    for(let i=0;i<hr.length;i++){
      const h=hr[i];
      lines.push([
        r.date,
        r.roundType,
        csvEsc(courseName),
        csvEsc(teeName),
        r.format,
        r.startHole,
        cr,
        slope,
        i+1,
        h.score ?? "",
        h.putts ?? "",
        h.penalties ?? "",
        h.fairwayHit==null ? "" : (h.fairwayHit ? "true":"false"),
        h.gir==null ? "" : (h.gir ? "true":"false"),
        csvEsc(h.firstPuttBucket ?? ""),
        csvEsc(h.holeNotes ?? ""),
        csvEsc(rn)
      ].join(","));
    }
  }

  return lines.join("\n");
}

function csvEsc(v){
  const s=String(v??"");
  if(/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

/* ---------------- Import JSON + CSV ---------------- */
$("#btnImport").addEventListener("click", ()=>{
  $("#importMsg").textContent="";
  $("#importText").value="";
  $("#importType").value="json";
  $("#importDialog").showModal();
});

$("#importType").addEventListener("change", ()=>{
  $("#importMsg").textContent="";
});

$("#btnDoImport").addEventListener("click", async (e)=>{
  e.preventDefault();
  $("#importMsg").textContent="";

  const type=$("#importType").value;
  const txt=$("#importText").value.trim();

  try{
    if(type==="json"){
      const data=JSON.parse(txt);
      if(!isV2(data)) throw new Error("Invalid JSON structure (expected version 2 store).");
      store=data;
      await saveStore();
    } else {
      const parsed = importCSVLong(txt);
      store = mergeImported(parsed);
      await saveStore();
    }

    $("#importMsg").textContent="Imported ✅";
    setTimeout(()=>$("#importDialog").close(), 450);
    await renderAll();
  } catch(err){
    $("#importMsg").textContent=`Import failed: ${err.message}`;
  }
});

function importCSVLong(text){
  const rows=parseCSV(text);
  if(rows.length<2) throw new Error("CSV is empty.");

  const header=rows[0].map(h=>String(h).trim());
  const needed = ["date","roundType","courseName","teeName","format","startHole","courseRating","slopeRating","holeNumber","score","putts","penalties","fairwayHit","gir","firstPuttBucket","holeNotes","roundNotes"];
  for(const k of needed){
    if(!header.includes(k)) throw new Error(`Missing header: ${k}`);
  }

  const idx=(name)=>header.indexOf(name);

  const out=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(!r || r.length===0) continue;
    out.push({
      date: String(r[idx("date")]||"").trim(),
      roundType: String(r[idx("roundType")]||"").trim(),
      courseName: String(r[idx("courseName")]||"").trim(),
      teeName: String(r[idx("teeName")]||"").trim(),
      format: Number(r[idx("format")]||18),
      startHole: Number(r[idx("startHole")]||1),
      courseRating: r[idx("courseRating")]=== "" ? null : Number(r[idx("courseRating")]),
      slopeRating: r[idx("slopeRating")]=== "" ? null : Number(r[idx("slopeRating")]),
      holeNumber: Number(r[idx("holeNumber")]||1),
      score: Number(r[idx("score")]||0),
      putts: r[idx("putts")]=== "" ? null : Number(r[idx("putts")]),
      penalties: r[idx("penalties")]=== "" ? null : Number(r[idx("penalties")]),
      fairwayHit: parseBoolNullable(r[idx("fairwayHit")]),
      gir: parseBoolNullable(r[idx("gir")]),
      firstPuttBucket: String(r[idx("firstPuttBucket")]||"").trim(),
      holeNotes: String(r[idx("holeNotes")]||"").trim(),
      roundNotes: String(r[idx("roundNotes")]||"").trim()
    });
  }
  return out;
}

function parseBoolNullable(v){
  const s=String(v??"").trim().toLowerCase();
  if(!s) return null;
  if(s==="true" || s==="y" || s==="yes") return true;
  if(s==="false" || s==="n" || s==="no") return false;
  return null;
}

function mergeImported(rows){
  // Build fresh store, then merge into it (course matching by name+tee)
  const s=structuredClone(V2_DEFAULT);
  s.playerProfile = store.playerProfile ?? V2_DEFAULT.playerProfile;
  s.goals = store.goals ?? V2_DEFAULT.goals;

  // group by round key: date + courseName + teeName + format + startHole + roundType
  const map=new Map();
  for(const r of rows){
    const key=[r.date,r.roundType,r.courseName,r.teeName,r.format,r.startHole].join("|");
    const arr=map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }

  for(const [key, arr] of map.entries()){
    const sample=arr[0];

    // course match or create
    let course = s.courses.find(c=>c.name===sample.courseName);
    if(!course){
      course={courseId:uid("course"), name:sample.courseName || "Imported Course", location:"", tees:[]};
      s.courses.push(course);
    }

    let tee = course.tees.find(t=>t.teeName===sample.teeName);
    if(!tee){
      // holes unknown from CSV long; create placeholder holes (par defaults 4, SI 1..18, yardage 0)
      const holes=Array.from({length:18},(_,i)=>({holeNumber:i+1, par:4, yardage:0, strokeIndex:i+1}));
      tee={
        teeId:uid("tee"),
        teeName: sample.teeName || "Tee",
        courseRating: sample.courseRating,
        slopeRating: sample.slopeRating,
        holes,
        parTotal: holes.reduce((a,h)=>a+Number(h.par||0),0)
      };
      course.tees.push(tee);
    } else {
      // update rating/slope if blank and import has value
      if(tee.courseRating==null && sample.courseRating!=null) tee.courseRating=sample.courseRating;
      if(tee.slopeRating==null && sample.slopeRating!=null) tee.slopeRating=sample.slopeRating;
    }

    // build holeResults in holeNumber order
    arr.sort((a,b)=>a.holeNumber-b.holeNumber);
    const holeResults = arr.map((h, idx)=>({
      holeNumber: idx+1,
      score: h.score ?? 0,
      putts: h.putts ?? null,
      penalties: h.penalties ?? null,
      fairwayHit: h.fairwayHit,
      gir: h.gir,
      firstPuttBucket: h.firstPuttBucket ?? "",
      holeNotes: h.holeNotes ?? ""
    }));

    const round={
      roundId:uid("round"),
      date: sample.date,
      roundType: sample.roundType || "course",
      format: sample.format || 18,
      startHole: sample.startHole || 1,
      courseId: course.courseId,
      teeId: tee.teeId,
      ruleset:{strictRules:true},
      notes: sample.roundNotes || "",
      adjustedGross: null,
      holeResults
    };

    s.rounds.push(round);
  }

  return s;
}

/* Minimal CSV parser (handles quotes) */
function parseCSV(text){
  const rows=[];
  let row=[], cur="", inQuotes=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    const next=text[i+1];

    if(inQuotes){
      if(ch === '"' && next === '"'){ cur+='"'; i++; continue; }
      if(ch === '"'){ inQuotes=false; continue; }
      cur+=ch; continue;
    }

    if(ch === '"'){ inQuotes=true; continue; }
    if(ch === ","){ row.push(cur); cur=""; continue; }
    if(ch === "\n"){
      row.push(cur); rows.push(row);
      row=[]; cur=""; continue;
    }
    if(ch === "\r"){ continue; }
    cur+=ch;
  }
  row.push(cur);
  rows.push(row);
  return rows.filter(r=>r.some(x=>String(x).trim()!==""));
}

/* ---------------- Boot + render all ---------------- */
async function renderAll(){
  renderCourseSelects();

  // profile
  $("#ruleset").value = store.playerProfile?.homeCountryRuleset ?? "WHS_UK";
  $("#hcpIndex").value = store.playerProfile?.handicapIndex ?? "";

  renderPortal();
  renderRawTable();
  buildScoreTablePreview();
}

async function boot(){
  store = await loadStore();
  seedIfEmpty();
  await saveStore();
  await renderAll();
  setView("portal");
  startNewCourse();
}

/* ---------------- Init ---------------- */
(async ()=>{
  if(isUnlocked()){
    await boot();
  }
})();

/* ---------------- Tiny escaping helpers ---------------- */
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function escapeAttr(str){ return escapeHtml(str).replace(/"/g,"&quot;"); }
