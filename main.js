// main.js
/**
 * Phase 1 MVP (static GitHub Pages):
 * - UI password gate (deterrent, not real security)
 * - Course cache (course -> tee -> 18 holes: par/yardage/SI)
 * - Add round (9 or 18, start 1 or 10), hole-by-hole scores
 * - Portal: trend + consistency + deterministic targets + basic breakdowns
 * - Export/Import JSON
 *
 * SET YOUR PASSWORD:
 * 1) Pick a password string.
 * 2) In the browser console, run:
 *    (async () => {
 *      const enc = new TextEncoder().encode("YOUR_PASSWORD");
 *      const buf = await crypto.subtle.digest("SHA-256", enc);
 *      console.log([...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""));
 *    })();
 * 3) Replace PASSWORD_SHA256_HEX below with the printed hex.
 */

const PASSWORD_SHA256_HEX = "REPLACE_ME_WITH_YOUR_SHA256_HEX";
const STORAGE_KEY = "golfTracker.v1";
const UNLOCK_KEY = "golfTracker.unlocked.v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** -----------------------------
 *  Data store (localStorage JSON)
 *  ---------------------------- */
function loadStore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { courses: [], rounds: [] };
  try {
    const data = JSON.parse(raw);
    if (!data?.courses || !data?.rounds) throw new Error("Invalid store");
    return data;
  } catch {
    return { courses: [], rounds: [] };
  }
}

function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

let store = loadStore();

/** -----------------------------
 *  Seed example (only if empty)
 *  ---------------------------- */
function seedIfEmpty() {
  if (store.courses.length > 0) return;

  const courseId = uid("course");
  const teeId = uid("tee");
  const holes = Array.from({ length: 18 }, (_, i) => ({
    holeNumber: i + 1,
    par: [4,4,3,4,5,4,3,4,5,4,4,3,4,5,4,3,4,5][i] ?? 4,
    yardage: 350 + (i % 5) * 20,
    strokeIndex: i + 1
  }));

  store.courses.push({
    courseId,
    name: "Example Course (edit me)",
    location: "—",
    tees: [{
      teeId,
      teeName: "White",
      courseRating: 71.2,
      slopeRating: 128,
      parTotal: holes.reduce((a, h) => a + Number(h.par || 0), 0),
      holes
    }]
  });

  saveStore(store);
}
seedIfEmpty();

/** -----------------------------
 *  Views / routing
 *  ---------------------------- */
const views = ["portal", "addRound", "courses", "raw"];

function setView(view) {
  views.forEach(v => {
    $(`#view-${v}`).classList.toggle("active", v === view);
    $(`.tab[data-view="${v}"]`).classList.toggle("active", v === view);
  });
  $("#subtitle").textContent = ({
    portal: "Portal",
    addRound: "Add round",
    courses: "Courses",
    raw: "Raw data"
  })[view] ?? "Portal";
}

$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

/** -----------------------------
 *  Gate
 *  ---------------------------- */
function isUnlocked() {
  return localStorage.getItem(UNLOCK_KEY) === "1";
}

function lockApp() {
  localStorage.removeItem(UNLOCK_KEY);
  $("#gate").classList.remove("hidden");
  $("#gatePassword").value = "";
  $("#gateMsg").textContent = "";
}

async function unlockAttempt(pw) {
  if (!PASSWORD_SHA256_HEX || PASSWORD_SHA256_HEX === "REPLACE_ME_WITH_YOUR_SHA256_HEX") {
    $("#gateMsg").textContent = "Set PASSWORD_SHA256_HEX in main.js first.";
    return false;
  }
  const hex = await sha256Hex(pw);
  if (hex === PASSWORD_SHA256_HEX) {
    localStorage.setItem(UNLOCK_KEY, "1");
    $("#gate").classList.add("hidden");
    return true;
  }
  return false;
}

$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#gateMsg").textContent = "";
  const pw = $("#gatePassword").value || "";
  const ok = await unlockAttempt(pw);
  if (!ok) $("#gateMsg").textContent = "Nope. Try again.";
  else renderAll();
});

$("#btnLock").addEventListener("click", lockApp);

if (isUnlocked()) $("#gate").classList.add("hidden");

/** -----------------------------
 *  Helpers: course/tee lookup
 *  ---------------------------- */
function getCourse(courseId) {
  return store.courses.find(c => c.courseId === courseId) ?? null;
}
function getTee(courseId, teeId) {
  const c = getCourse(courseId);
  return c?.tees?.find(t => t.teeId === teeId) ?? null;
}
function courseLabel(courseId) {
  return getCourse(courseId)?.name ?? "—";
}
function teeLabel(courseId, teeId) {
  return getTee(courseId, teeId)?.teeName ?? "—";
}

function holesForRound(round) {
  const tee = getTee(round.courseId, round.teeId);
  if (!tee) return [];
  const start = Number(round.startHole || 1);
  const format = Number(round.format || 18);
  const ordered = start === 10
    ? [...tee.holes.slice(9), ...tee.holes.slice(0, 9)]
    : [...tee.holes];
  return ordered.slice(0, format);
}

function parForPlayedHoles(round) {
  const holes = holesForRound(round);
  return holes.reduce((a, h) => a + Number(h.par || 0), 0);
}

function grossForRound(round) {
  const arr = round.holeResults ?? [];
  return arr.reduce((a, r) => a + Number(r.score || 0), 0);
}

function toParForRound(round) {
  const gross = grossForRound(round);
  const par = parForPlayedHoles(round);
  return gross - par;
}

function normalizeTo18(value, format) {
  const f = Number(format || 18);
  if (f === 18) return value;
  if (f === 9) return value * 2;
  return value;
}

/** -----------------------------
 *  Portal metrics
 *  ---------------------------- */
function blowupCount(round) {
  const holes = holesForRound(round);
  const results = round.holeResults ?? [];
  let count = 0;
  for (let i = 0; i < Math.min(holes.length, results.length); i++) {
    const par = Number(holes[i]?.par || 0);
    const score = Number(results[i]?.score || 0);
    if (score >= par + 2) count++;
  }
  return count;
}

// Std dev of (score - par) per hole for a round, then averaged across rounds
function roundVolatility(round) {
  const holes = holesForRound(round);
  const results = round.holeResults ?? [];
  const diffs = [];
  for (let i = 0; i < Math.min(holes.length, results.length); i++) {
    const par = Number(holes[i]?.par || 0);
    const score = Number(results[i]?.score || 0);
    diffs.push(score - par);
  }
  if (diffs.length < 2) return 0;
  const mean = diffs.reduce((a, x) => a + x, 0) / diffs.length;
  const varr = diffs.reduce((a, x) => a + (x - mean) ** 2, 0) / (diffs.length - 1);
  return Math.sqrt(varr);
}

function scoringByParType(rounds) {
  const buckets = { 3: [], 4: [], 5: [] }; // list of score-par diffs
  for (const r of rounds) {
    const holes = holesForRound(r);
    const res = r.holeResults ?? [];
    for (let i = 0; i < Math.min(holes.length, res.length); i++) {
      const par = Number(holes[i].par || 0);
      const score = Number(res[i].score || 0);
      if ([3,4,5].includes(par) && score) buckets[par].push(score - par);
    }
  }
  const avg = (arr) => arr.length ? (arr.reduce((a,x)=>a+x,0)/arr.length) : null;
  return { p3: avg(buckets[3]), p4: avg(buckets[4]), p5: avg(buckets[5]) };
}

function scoringBySIBucket(rounds) {
  const buckets = { hard: [], mid: [], easy: [] }; // diffs
  for (const r of rounds) {
    const holes = holesForRound(r);
    const res = r.holeResults ?? [];
    for (let i = 0; i < Math.min(holes.length, res.length); i++) {
      const si = Number(holes[i].strokeIndex || 0);
      const par = Number(holes[i].par || 0);
      const score = Number(res[i].score || 0);
      if (!si || !score) continue;
      const diff = score - par;
      if (si >= 1 && si <= 6) buckets.hard.push(diff);
      else if (si >= 7 && si <= 12) buckets.mid.push(diff);
      else buckets.easy.push(diff);
    }
  }
  const avg = (arr) => arr.length ? (arr.reduce((a,x)=>a+x,0)/arr.length) : null;
  return { hard: avg(buckets.hard), mid: avg(buckets.mid), easy: avg(buckets.easy) };
}

function nextRoundTargets(rounds) {
  if (!rounds.length) {
    return [
      "Log your next round hole-by-hole (scores only is fine).",
      "Aim for stress-free golf: avoid hero shots and keep the ball in play.",
      "Pick one thing: club up on par 3s, or take less than driver on tight holes."
    ];
  }

  const lastN = rounds.slice(-6);
  const avgBlowups = lastN.reduce((a,r)=>a+blowupCount(r),0)/lastN.length;
  const avgVol = lastN.reduce((a,r)=>a+roundVolatility(r),0)/lastN.length;

  // SI bucket clue: if hard holes are much worse, suggest conservative play
  const si = scoringBySIBucket(lastN);
  const targets = [];

  if (avgBlowups >= 3) {
    targets.push("Cut doubles+ first: if you’re in trouble, take the boring punch-out instead of the miracle shot.");
  } else {
    targets.push("Protect momentum: treat bogey as a save, not a failure. No tilt swings.");
  }

  if (avgVol >= 1.2) {
    targets.push("Stabilise your round: pick conservative lines off the tee on 3–4 holes you usually blow up.");
  } else {
    targets.push("You’re getting steadier—push one low-risk edge (better club choice on par 3s, or smarter layups).");
  }

  if (si.hard != null && si.easy != null && (si.hard - si.easy) > 0.6) {
    targets.push("Hard holes tax you: play them as ‘bogey holes’—keep it in play, aim centre-green, accept the 5.");
  } else {
    targets.push("On tough holes: commit to a safe target and swing at 80–90%. Clean contact beats brute force.");
  }

  return targets.slice(0, 3);
}

/** -----------------------------
 *  Charts
 *  ---------------------------- */
let chartTrend, chartByPar, chartBySI;

function destroyCharts() {
  [chartTrend, chartByPar, chartBySI].forEach(ch => ch?.destroy?.());
  chartTrend = chartByPar = chartBySI = null;
}

function renderCharts() {
  destroyCharts();

  const rounds = [...store.rounds].sort((a,b)=> new Date(a.date) - new Date(b.date));
  const labels = rounds.map(r => r.date);
  const toPar = rounds.map(r => {
    const v = toParForRound(r);
    const n = normalizeTo18(v, r.format);
    return n;
  });

  const ctxTrend = $("#chartTrend");
  chartTrend = new Chart(ctxTrend, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "To par (18-normalized)",
        data: toPar,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const idx = items?.[0]?.dataIndex;
              const r = rounds[idx];
              if (!r) return "";
              const raw = toParForRound(r);
              return r.format === 9
                ? `Raw 9-hole to-par: ${raw >= 0 ? "+" : ""}${raw}`
                : `Raw 18-hole to-par: ${raw >= 0 ? "+" : ""}${raw}`;
            }
          }
        }
      },
      scales: {
        y: { ticks: { callback: (v)=> (v>0?`+${v}`: `${v}`) } }
      }
    }
  });

  const byPar = scoringByParType(rounds);
  chartByPar = new Chart($("#chartByPar"), {
    type: "bar",
    data: {
      labels: ["Par 3", "Par 4", "Par 5"],
      datasets: [{
        label: "Avg vs par",
        data: [byPar.p3, byPar.p4, byPar.p5].map(v => v ?? 0)
      }]
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => {
          const v = ctx.raw;
          if (v == null) return "—";
          return `Avg vs par: ${v > 0 ? "+" : ""}${v.toFixed(2)}`;
        }}}
      },
      scales: {
        y: { ticks: { callback: (v)=> (v>0?`+${v}`: `${v}`) } }
      }
    }
  });

  const bySI = scoringBySIBucket(rounds);
  chartBySI = new Chart($("#chartBySI"), {
    type: "bar",
    data: {
      labels: ["SI 1–6", "SI 7–12", "SI 13–18"],
      datasets: [{
        label: "Avg vs par",
        data: [bySI.hard, bySI.mid, bySI.easy].map(v => v ?? 0)
      }]
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => {
          const v = ctx.raw;
          return `Avg vs par: ${v > 0 ? "+" : ""}${Number(v).toFixed(2)}`;
        }}}
      },
      scales: {
        y: { ticks: { callback: (v)=> (v>0?`+${v}`: `${v}`) } }
      }
    }
  });
}

/** -----------------------------
 *  Portal render
 *  ---------------------------- */
function renderPortal() {
  const rounds = [...store.rounds].sort((a,b)=> new Date(a.date) - new Date(b.date));
  $("#chipRounds").textContent = `${rounds.length} round${rounds.length===1?"":"s"}`;

  if (!rounds.length) {
    $("#chipBest").textContent = "Best: —";
    $("#chipAvg").textContent = "Avg to par: —";
    $("#kpiBlowups").textContent = "—";
    $("#kpiVolatility").textContent = "—";
    $("#targets").innerHTML = `<li>Add a course, then log your first round.</li>`;
    destroyCharts();
    return;
  }

  const toPars = rounds.map(r => normalizeTo18(toParForRound(r), r.format));
  const best = Math.min(...toPars);
  const avg = toPars.reduce((a,x)=>a+x,0)/toPars.length;

  $("#chipBest").textContent = `Best: ${best>0?`+${best}`: `${best}`}`;
  $("#chipAvg").textContent = `Avg to par: ${avg>0?`+${avg.toFixed(1)}`: `${avg.toFixed(1)}`}`;

  const avgBlowups = rounds.reduce((a,r)=>a+blowupCount(r),0)/rounds.length;
  const avgVol = rounds.reduce((a,r)=>a+roundVolatility(r),0)/rounds.length;

  $("#kpiBlowups").textContent = avgBlowups.toFixed(1);
  $("#kpiVolatility").textContent = avgVol.toFixed(2);

  const targets = nextRoundTargets(rounds);
  $("#targets").innerHTML = targets.map(t => `<li>${escapeHtml(t)}</li>`).join("");

  renderCharts();
}

/** -----------------------------
 *  Add Round render + logic
 *  ---------------------------- */
function setSelectOptions(selectEl, options, value) {
  selectEl.innerHTML = options.map(o => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join("");
  if (value != null) selectEl.value = value;
}

function renderCourseSelects() {
  const courseOptions = store.courses.map(c => ({ value: c.courseId, label: c.name }));
  if (!courseOptions.length) courseOptions.push({ value: "", label: "No courses yet — create one" });

  setSelectOptions($("#courseSelect"), courseOptions, courseOptions[0]?.value ?? "");
  setSelectOptions($("#courseList"), courseOptions, courseOptions[0]?.value ?? "");

  syncTeeSelects();
}

function syncTeeSelects() {
  const courseId = $("#courseSelect").value || store.courses[0]?.courseId;
  const c = getCourse(courseId);
  const teeOptions = (c?.tees ?? []).map(t => ({ value: t.teeId, label: t.teeName }));
  if (!teeOptions.length) teeOptions.push({ value: "", label: "No tees — add in Courses" });
  setSelectOptions($("#teeSelect"), teeOptions, teeOptions[0]?.value ?? "");
  buildScoreTablePreview();
}

function buildScoreTablePreview() {
  const courseId = $("#courseSelect").value;
  const teeId = $("#teeSelect").value;
  const format = Number($("#roundFormat").value || 18);
  const startHole = Number($("#startHole").value || 1);

  const tee = getTee(courseId, teeId);
  const tbody = $("#scoreTable tbody");
  tbody.innerHTML = "";

  if (!tee) {
    $("#sumGross").textContent = "—";
    $("#sumToPar").textContent = "—";
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Select a course + tee to enter scores.</td></tr>`;
    return;
  }

  const ordered = startHole === 10 ? [...tee.holes.slice(9), ...tee.holes.slice(0, 9)] : [...tee.holes];
  const holes = ordered.slice(0, format);

  for (const h of holes) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${h.holeNumber}</td>
      <td>${escapeHtml(String(h.par ?? ""))}</td>
      <td>${escapeHtml(String(h.strokeIndex ?? ""))}</td>
      <td>${escapeHtml(String(h.yardage ?? ""))}</td>
      <td>
        <input class="scoreInput" type="number" min="1" max="20" step="1" data-hole="${h.holeNumber}" placeholder="—" />
      </td>
    `;
    tbody.appendChild(tr);
  }

  $$(".scoreInput").forEach(inp => inp.addEventListener("input", updateScoreSummary));
  updateScoreSummary();
}

function updateScoreSummary() {
  const courseId = $("#courseSelect").value;
  const teeId = $("#teeSelect").value;
  const format = Number($("#roundFormat").value || 18);
  const startHole = Number($("#startHole").value || 1);
  const tee = getTee(courseId, teeId);
  if (!tee) return;

  const ordered = startHole === 10 ? [...tee.holes.slice(9), ...tee.holes.slice(0, 9)] : [...tee.holes];
  const holes = ordered.slice(0, format);

  let gross = 0;
  let par = 0;

  const inputs = $$(".scoreInput");
  for (let i = 0; i < holes.length; i++) {
    const score = Number(inputs[i]?.value || 0);
    if (score > 0) gross += score;
    par += Number(holes[i].par || 0);
  }

  $("#sumGross").textContent = gross ? String(gross) : "—";
  const toPar = gross ? (gross - par) : null;
  $("#sumToPar").textContent = (toPar == null) ? "—" : (toPar > 0 ? `+${toPar}` : `${toPar}`);
}

$("#courseSelect").addEventListener("change", syncTeeSelects);
$("#teeSelect").addEventListener("change", buildScoreTablePreview);
$("#roundFormat").addEventListener("change", buildScoreTablePreview);
$("#startHole").addEventListener("change", buildScoreTablePreview);

$("#roundDate").value = todayISODate();

$("#roundForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("#roundMsg").textContent = "";

  const courseId = $("#courseSelect").value;
  const teeId = $("#teeSelect").value;
  const course = getCourse(courseId);
  const tee = getTee(courseId, teeId);
  if (!course || !tee) {
    $("#roundMsg").textContent = "Pick a course + tee first (or create one in Courses).";
    return;
  }

  const format = Number($("#roundFormat").value || 18);
  const startHole = Number($("#startHole").value || 1);

  const scoreInputs = $$(".scoreInput");
  const holeResults = scoreInputs.map((inp, idx) => ({
    holeNumber: idx + 1, // relative order; we use tee ordering to map par/SI/yds
    score: clamp(Number(inp.value || 0), 0, 30)
  }));

  // Ensure user entered at least one score
  const anyScore = holeResults.some(r => r.score > 0);
  if (!anyScore) {
    $("#roundMsg").textContent = "Enter at least one hole score.";
    return;
  }

  const round = {
    roundId: uid("round"),
    date: $("#roundDate").value,
    roundType: $("#roundType").value,
    format,
    startHole,
    courseId,
    teeId,
    ruleset: { strictRules: true },
    notes: $("#roundNotes").value?.trim() ?? "",
    holeResults
  };

  store.rounds.push(round);
  saveStore(store);

  // reset inputs
  scoreInputs.forEach(inp => inp.value = "");
  $("#roundNotes").value = "";
  $("#roundMsg").textContent = "Saved ✅";

  renderAll();
  setView("portal");
});

/** Quick new course */
$("#btnNewCourseQuick").addEventListener("click", () => {
  setView("courses");
  startNewCourse();
});

/** -----------------------------
 *  Courses editor
 *  ---------------------------- */
function buildHolesEditor(tableBodyEl, holes) {
  tableBodyEl.innerHTML = "";
  for (let i = 0; i < 18; i++) {
    const h = holes[i] ?? { holeNumber: i+1, par: "", yardage: "", strokeIndex: i+1 };
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i+1}</td>
      <td><input class="holePar" type="number" min="3" max="6" step="1" value="${escapeAttr(h.par ?? "")}" /></td>
      <td><input class="holeYds" type="number" min="50" max="700" step="1" value="${escapeAttr(h.yardage ?? "")}" /></td>
      <td><input class="holeSI" type="number" min="1" max="18" step="1" value="${escapeAttr(h.strokeIndex ?? (i+1))}" /></td>
    `;
    tableBodyEl.appendChild(tr);
  }
}

let editingCourseId = null;
let editingTeeId = null;

function startNewCourse() {
  editingCourseId = null;
  editingTeeId = null;
  $("#courseEditorTitle").textContent = "Course editor (new)";
  $("#courseName").value = "";
  $("#courseLocation").value = "";
  $("#teeName").value = "White";
  $("#courseRating").value = "";
  $("#slopeRating").value = "";
  $("#courseMsg").textContent = "";

  const defaultHoles = Array.from({length:18}, (_,i)=>({
    holeNumber:i+1, par:"", yardage:"", strokeIndex:i+1
  }));
  buildHolesEditor($("#holesTable tbody"), defaultHoles);
}

function loadCourseIntoEditor(courseId) {
  const c = getCourse(courseId);
  if (!c) return;
  const t = c.tees?.[0];
  if (!t) return;

  editingCourseId = c.courseId;
  editingTeeId = t.teeId;

  $("#courseEditorTitle").textContent = `Course editor (editing)`;
  $("#courseName").value = c.name ?? "";
  $("#courseLocation").value = c.location ?? "";
  $("#teeName").value = t.teeName ?? "White";
  $("#courseRating").value = t.courseRating ?? "";
  $("#slopeRating").value = t.slopeRating ?? "";
  $("#courseMsg").textContent = "";

  buildHolesEditor($("#holesTable tbody"), t.holes ?? []);
}

$("#btnNewCourse").addEventListener("click", startNewCourse);

$("#btnEditCourse").addEventListener("click", () => {
  const id = $("#courseList").value;
  if (!id) return;
  loadCourseIntoEditor(id);
});

$("#btnDeleteCourse").addEventListener("click", () => {
  const id = $("#courseList").value;
  if (!id) return;
  // Also delete rounds that reference it (orphan cleanup)
  store.courses = store.courses.filter(c => c.courseId !== id);
  store.rounds = store.rounds.filter(r => r.courseId !== id);
  saveStore(store);
  editingCourseId = null;
  editingTeeId = null;
  renderAll();
  startNewCourse();
});

$("#btnAutofill").addEventListener("click", () => {
  // reasonable-ish defaults so you can overwrite quickly
  const pars = [4,4,3,4,5,4,3,4,5,4,4,3,4,5,4,3,4,5];
  const tbody = $("#holesTable tbody");
  [...tbody.querySelectorAll("tr")].forEach((tr, i) => {
    tr.querySelector(".holePar").value = pars[i];
    tr.querySelector(".holeYds").value = 330 + (i%6)*25;
    tr.querySelector(".holeSI").value = i+1;
  });
});

$("#courseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("#courseMsg").textContent = "";

  const name = $("#courseName").value.trim();
  const location = $("#courseLocation").value.trim();
  const teeName = $("#teeName").value.trim() || "White";
  const courseRating = $("#courseRating").value ? Number($("#courseRating").value) : null;
  const slopeRating = $("#slopeRating").value ? Number($("#slopeRating").value) : null;

  const tbody = $("#holesTable tbody");
  const rows = [...tbody.querySelectorAll("tr")];

  const holes = rows.map((tr, i) => ({
    holeNumber: i + 1,
    par: Number(tr.querySelector(".holePar").value || 0),
    yardage: Number(tr.querySelector(".holeYds").value || 0),
    strokeIndex: Number(tr.querySelector(".holeSI").value || (i + 1))
  }));

  // basic validation
  const parTotal = holes.reduce((a,h)=>a + (Number(h.par)||0),0);
  const hasPars = holes.every(h => [3,4,5].includes(h.par));
  const hasSI = holes.every(h => h.strokeIndex >= 1 && h.strokeIndex <= 18);
  if (!name) {
    $("#courseMsg").textContent = "Course name is required.";
    return;
  }
  if (!hasPars) {
    $("#courseMsg").textContent = "Every hole needs a Par of 3/4/5.";
    return;
  }
  if (!hasSI) {
    $("#courseMsg").textContent = "Every hole needs a stroke index between 1 and 18.";
    return;
  }

  if (editingCourseId) {
    const c = getCourse(editingCourseId);
    if (!c) return;

    c.name = name;
    c.location = location;

    // Phase 1: keep one tee for simplicity (you can extend later)
    if (!c.tees?.length) c.tees = [];
    let t = c.tees.find(x => x.teeId === editingTeeId) || c.tees[0];
    if (!t) {
      t = { teeId: uid("tee") };
      c.tees.push(t);
    }
    t.teeName = teeName;
    t.courseRating = courseRating;
    t.slopeRating = slopeRating;
    t.holes = holes;
    t.parTotal = parTotal;

  } else {
    const courseId = uid("course");
    const teeId = uid("tee");
    store.courses.push({
      courseId,
      name,
      location,
      tees: [{
        teeId,
        teeName,
        courseRating,
        slopeRating,
        parTotal,
        holes
      }]
    });
    editingCourseId = courseId;
    editingTeeId = teeId;
  }

  saveStore(store);
  $("#courseMsg").textContent = "Saved ✅";
  renderAll();
});

/** -----------------------------
 *  Raw data table
 *  ---------------------------- */
function renderRawTable() {
  const tbody = $("#roundsTable tbody");
  tbody.innerHTML = "";

  const rounds = [...store.rounds].sort((a,b)=> new Date(b.date) - new Date(a.date));
  if (!rounds.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No rounds yet.</td></tr>`;
    return;
  }

  for (const r of rounds) {
    const gross = grossForRound(r);
    const toPar = toParForRound(r);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.date || "—")}</td>
      <td>${escapeHtml(r.roundType || "—")}</td>
      <td>${escapeHtml(courseLabel(r.courseId))}</td>
      <td>${escapeHtml(teeLabel(r.courseId, r.teeId))}</td>
      <td>${escapeHtml(String(r.format || "—"))}</td>
      <td>${gross || "—"}</td>
      <td>${gross ? (toPar>0?`+${toPar}`:`${toPar}`) : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

/** -----------------------------
 *  Export / Import
 *  ---------------------------- */
$("#btnExport").addEventListener("click", () => {
  const payload = JSON.stringify(store, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `golf-tracker-export-${todayISODate()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$("#btnImport").addEventListener("click", () => {
  $("#importMsg").textContent = "";
  $("#importText").value = "";
  $("#importDialog").showModal();
});

$("#btnDoImport").addEventListener("click", (e) => {
  e.preventDefault(); // keep dialog open if error
  $("#importMsg").textContent = "";

  try {
    const txt = $("#importText").value.trim();
    const data = JSON.parse(txt);
    if (!Array.isArray(data?.courses) || !Array.isArray(data?.rounds)) {
      throw new Error("Invalid JSON structure");
    }
    // minimal sanity: courses must have courseId, rounds must have roundId
    store = { courses: data.courses, rounds: data.rounds };
    saveStore(store);
    $("#importMsg").textContent = "Imported ✅";
    setTimeout(() => $("#importDialog").close(), 450);
    renderAll();
  } catch (err) {
    $("#importMsg").textContent = `Import failed: ${err.message}`;
  }
});

/** -----------------------------
 *  Render all
 *  ---------------------------- */
function renderAll() {
  store = loadStore();

  renderCourseSelects();
  renderPortal();
  renderRawTable();

  // Keep score entry aligned to current selects
  buildScoreTablePreview();
}

function init() {
  renderAll();
  setView("portal");
  startNewCourse(); // editor ready
}
if (isUnlocked()) init();

/** -----------------------------
 *  Tiny escaping helpers
 *  ---------------------------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
