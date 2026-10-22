// ============================================================
//  Edge Function: relatorios — a student's own corrected exams ("Minhas correções")
//
//  Independent of the quiz backend (`submit`): deploying or changing this
//  function never affects a running quiz. Deploy with "Verify JWT" OFF, like
//  the others (the page sends no Supabase session; the check below is the gate).
//
//    { action:"report", matricula, code }
//      -> { ok, nome, exams:[ { runId, title, notaBase, points, maxPoints, grade,
//             kind, medianGrade, questions:[ { numero, titulo, score|null, max, missing, median, delta,
//                           grader, typed, enunciado,
//                           criteria:[{label,detail,pts,met}], scans:[url],
//                           gabaritoHtml } ] } ] }
//
//  Identity comes ONLY from matrícula + personal code (salted PBKDF2 hash in
//  student_access); everything returned is looked up from that verified
//  matrícula — nothing the page sends selects whose data is read. Failed
//  attempts are throttled per IP. Scans are short-lived signed URLs to the
//  images already in the private `answers` bucket (no copies, no PDFs).
//  Tables: supabase/student_reports.sql, supabase/report_access.sql (+ the
//  existing correction_* tables). Successful accesses are logged (matrícula + time).
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "answers";
const FAIL_MAX_IP = 100;       // failed attempts per IP (high: a campus NAT is shared by a whole class;
                               // with ~8e14 possible codes, guessing stays hopeless)...
const FAIL_WINDOW_SEC = 900;   // ...per 15 minutes
const URL_TTL_SEC = 3600;      // scan links: 1 hour (the page loads them at once)
const DUMMY_SALT = "00000000000000000000000000000000";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}
function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
async function rows(path: string): Promise<any[]> {
  const r = await db(path);
  if (!r.ok) throw new Error(`db ${r.status}: ${path.split("?")[0]}`);
  return await r.json();
}
const inList = (xs: (string | number)[]) => `(${xs.map((x) => `"${String(x).replace(/"/g, "")}"`).join(",")})`;

// ---------- rate limiting (shared rate_limit table, failures only) ----------
function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
async function failCount(bucket: string): Promise<number> {
  const since = new Date(Date.now() - FAIL_WINDOW_SEC * 1000).toISOString();
  const r = await db(`rate_limit?bucket=eq.${encodeURIComponent(bucket)}&created_at=gte.${encodeURIComponent(since)}&select=id`,
    { headers: { Prefer: "count=exact", Range: "0-0" } });
  return parseInt(r.headers.get("content-range")?.split("/")[1] ?? "0", 10) || 0;
}
async function failHit(bucket: string): Promise<void> {
  await db(`rate_limit`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ bucket }) });
}

// ---------- code check ----------
const normMatricula = (m: unknown) => (typeof m === "string" ? m : "").replace(/\D/g, "").slice(0, 20);
const normCode = (c: unknown) => (typeof c === "string" ? c : "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substring(2 * i, 2 * i + 2), 16);
  return out;
}
async function pbkdf2Hex(code: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- signing (one batch call) ----------
async function signAll(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!paths.length) return out;
  const r = await fetch(`${SUPA_URL}/storage/v1/object/sign/${BUCKET}`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: URL_TTL_SEC, paths }),
  });
  for (const s of (r.ok ? await r.json() : [])) {
    const u = s.signedURL || s.signedUrl;
    if (u) out[s.path] = `${SUPA_URL}/storage/v1${u}`;
  }
  return out;
}

// ---------- class context: medians over every graded booklet of the run ----------
// (aggregate numbers only — no other student's data leaves this function)
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b), m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const qtype = (qid: string) => qid.replace(/^v\d+_/, "");   // shared across versions
async function classStats(runId: string, base: number) {
  const items = await rows(`correction_items?run_id=eq.${encodeURIComponent(runId)}&select=id,question_id,student_key&limit=5000`);
  const evs: any[] = [];
  for (let i = 0; i < items.length; i += 150) {   // keep the URL short
    evs.push(...await rows(`correction_events?item_id=in.${inList(items.slice(i, i + 150).map((x) => x.id))}` +
      `&kind=in.(accept,override,reopen)&select=item_id,kind,score,criteria&order=created_at.asc&limit=5000`));
  }
  const dec: Record<string, number> = {}, decCrit: Record<string, any> = {};
  for (const e of evs) {
    if (e.kind === "reopen") { delete dec[e.item_id]; delete decCrit[e.item_id]; }
    else { dec[e.item_id] = Number(e.score); decCrit[e.item_id] = e.criteria || {}; }
  }
  // share of graded answers meeting each criterion: { question_id: { key: [met, n] } }
  const critRate: Record<string, Record<string, [number, number]>> = {};
  const byType: Record<string, number[]> = {}, byStudent: Record<string, { pts: number; n: number; graded: number }> = {};
  for (const it of items) {
    const st = (byStudent[it.student_key] ||= { pts: 0, n: 0, graded: 0 });
    st.n++;
    if (it.id in dec) {
      st.graded++; st.pts += dec[it.id];
      const qr = (critRate[it.question_id] ||= {});
      for (const [k, v] of Object.entries(decCrit[it.id] as Record<string, any>)) {
        const r = (qr[k] ||= [0, 0]); r[1]++; if (v && v.met) r[0]++;
      }
      (byType[qtype(it.question_id)] ||= []).push(dec[it.id]);
    }
  }
  const grades = Object.values(byStudent).filter((s) => s.graded === s.n && s.n > 0)
    .map((s) => Math.min(100, Math.round((s.pts / base) * 100)));
  const byTypeMed: Record<string, number | null> = {};
  for (const [t, xs] of Object.entries(byType)) byTypeMed[t] = median(xs);
  return { medianGrade: median(grades), byType: byTypeMed, critRate };
}

// ---------- one exam or activity, for one verified student ----------
// Exams: the student's own booklet questions (their version). Activities (quizzes,
// correction_runs.source = quiz id): ALL questions of the quiz, with the statement,
// and the ones the student did not answer shown as 0 / "não respondida".
const headingTitle = (prompt: string) => {
  const m = String(prompt || "").match(/^\s*#+\s*(?:\d+\s*[.)]\s*)?(.+?)\s*$/m);
  return m ? m[1].replace(/[*_`$]/g, "").trim() : "";
};
async function buildExam(run: any, studentKey: string) {
  const rid = encodeURIComponent(run.run_id);
  const items = await rows(`correction_items?run_id=eq.${rid}` +
    `&student_key=eq.${encodeURIComponent(studentKey)}&select=id,question_id,image_paths,typed_answer`);
  if (!items.length) return null;
  const [evs, crit, rq, cq, cr, staff] = await Promise.all([
    rows(`correction_events?item_id=in.${inList(items.map((i) => i.id))}&kind=in.(accept,override,reopen)` +
      `&select=item_id,kind,score,criteria,rubric,actor_email,created_at&order=created_at.asc`),
    rows(`correction_criteria?run_id=eq.${rid}&active=eq.true&select=question_id,key,label,detail,points,position`),
    rows(`report_questions?run_id=eq.${rid}&select=question_id,numero,titulo,gabarito_html,feedback`),
    rows(`correction_questions?run_id=eq.${rid}&select=question_id,prompt,position&order=position.asc`),
    rows(`correction_runs?id=eq.${rid}&select=source`),
    rows(`staff?select=email,name`),
  ]);
  const isQuiz = !!(cr[0] && cr[0].source);
  // current decision per item: latest accept/override not followed by a reopen
  const dec: Record<string, any> = {};
  for (const e of evs) {
    if (e.kind === "reopen") delete dec[e.item_id];
    else dec[e.item_id] = e;
  }
  const staffName: Record<string, string> = {};
  for (const s of staff) staffName[String(s.email).toLowerCase()] = s.name || "";
  const qmeta: Record<string, any> = {};
  for (const q of rq) qmeta[q.question_id] = q;
  const cqmeta: Record<string, any> = {};
  for (const q of cq) cqmeta[q.question_id] = q;
  const itemOf: Record<string, any> = {};
  for (const it of items) itemOf[it.question_id] = it;
  // which questions to show: exam = the booklet's; activity = every question of the quiz
  const qids: string[] = isQuiz ? cq.map((q) => q.question_id) : items.map((i) => i.question_id);

  // sign scans + gabarito assets in one call
  const assetRe = /\{\{asset:([A-Za-z0-9_\-./]+)\}\}/g;
  const paths = new Set<string>();
  for (const it of items) for (const p of (it.image_paths || [])) paths.add(p);
  for (const q of rq) for (const m of String(q.gabarito_html || "").matchAll(assetRe)) {
    if (m[1].startsWith("relatorios/")) paths.add(m[1]);   // only report assets, never other objects
  }
  const base = Number(run.nota_base) || 0;
  const [url, stats] = await Promise.all([signAll([...paths]), base > 0 ? classStats(run.run_id, base) : null]);

  let points = 0, maxPoints = 0, allGraded = true;
  const questions = qids.map((qid) => {
    const it = itemOf[qid];
    const d = it ? dec[it.id] : null;
    const meta = qmeta[qid] || {};
    const cqm = cqmeta[qid] || {};
    // The CURRENT barème (labels, points, max) with the grader's ticks. A grade
    // given under an earlier barème keeps its frozen score; its ticks map by key.
    const qcrit = crit.filter((c) => c.question_id === qid)
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    const criteria = qcrit.map((c) => ({
      key: c.key, label: c.label ?? c.key, detail: c.detail ?? "",
      pts: Number(c.points), met: !!(d?.criteria?.[c.key]?.met),
    }));
    const max = criteria.reduce((s, c) => s + c.pts, 0);
    const sumMet = criteria.reduce((s, c) => s + (c.met ? c.pts : 0), 0);
    const missing = !it;                                   // activity question not answered
    const score = missing ? 0 : (d ? Number(d.score) : null);
    if (score === null) allGraded = false; else { points += score; maxPoints += max; }
    const gab = String(meta.gabarito_html || "").replace(assetRe, (_m, p) => url[p] || "");
    return {
      qid,                                                 // internal (skills table), removed below
      numero: meta.numero ?? ((cqm.position ?? 0) + 1),
      titulo: meta.titulo ?? (headingTitle(cqm.prompt) || qid),
      score, max, missing, delta: (score === null || missing) ? 0 : Math.round((score - sumMet) * 100) / 100,
      median: stats ? (stats.byType[qtype(qid)] ?? null) : null,
      grader: d ? (staffName[String(d.actor_email).toLowerCase()] || "") : "",
      criteria, scans: ((it && it.image_paths) || []).map((p: string) => url[p]).filter(Boolean),
      typed: (it && it.typed_answer) || "",                // quizzes: the typed part of the answer
      enunciado: isQuiz ? (cqm.prompt || "") : "",          // quizzes: the statement (no scan carries it)
      gabaritoHtml: gab,
      feedback: meta.feedback || null,                     // skills + homework exercises (activities)
      // exercises for the skills NOT fully met in this question (all of them if unanswered)
      praticar: mergeEx(((meta.feedback && meta.feedback.skills) || [])
        .filter((k: any) => missing || k.crit.some((key: string) => criteria.some((c) => c.key === key && !c.met)))
        .map((k: any) => k.ex)),
    };
  }).sort((a, b) => a.numero - b.numero);

  const grade = allGraded && base > 0 ? Math.min(100, Math.round((points / base) * 100)) : null;
  const summary = grade !== null && questions.some((q) => q.feedback) ? skillTable(questions, stats ? stats.critRate : {}) : null;
  for (const q of questions) { delete (q as any).feedback; delete (q as any).qid; }
  return { runId: run.run_id, title: run.title, kind: isQuiz ? "atividade" : "prova", notaBase: base,
           points, maxPoints, grade, medianGrade: stats ? stats.medianGrade : null, questions, summary };
}

// ---------- skills table (activities) ----------
// Deterministic: report_questions.feedback (checked by the teacher) groups each
// question's criteria into skills, each with homework exercises [["06",[2,3]], ...].
// A skill shared by several questions is pooled; c6 ("Justificativa clara", on every
// question) is pooled across the answered questions as its own skill. Every skill is
// listed with the points the student got on it, best first (share of points met;
// ties: more points first, then question order; skills with no data — only in
// unanswered questions — last). `alem`: the activity's extension exercises (shown to
// the strongest students). `start`: 2 skills to begin with, each with its first
// exercise — the missed ones (under 90%) most of the class got right (class share of
// the skill's points met), completed with skills of unanswered questions the same way.
// Two different exercises (the second skill moves to its next one if needed).
// The page shows it, with the list folded, when the grade is below 50.
type Ex = [string, number[]][];
function mergeEx(lists: Ex[]): Ex {
  const by = new Map<string, Set<number>>();
  for (const l of lists) for (const [lista, ns] of (l || [])) {
    const set = by.get(lista) || new Set<number>(); by.set(lista, set);
    for (const n of ns) set.add(n);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([l, set]) => [l, [...set].sort((a, b) => a - b)] as [string, number[]]);
}
const C6_NAME = "Justificativas claras";
const C6_TIP = "Comece dizendo o que vai demonstrar e justifique cada passo.";
function skillTable(questions: any[], critRate: Record<string, Record<string, [number, number]>>) {
  type Sk = { id: string; nome: string; earned: number; possible: number; ex: Ex[]; order: number;
              cNum?: number; cDen?: number };
  const skills = new Map<string, Sk>();
  const c6: Sk = { id: "c6", nome: C6_NAME, earned: 0, possible: 0, ex: [], order: 1e6 };
  let order = 0;
  const alem: Ex[] = [];
  for (const q of questions) {
    const fb = q.feedback;
    if (!fb) continue;
    if (fb.alem) alem.push(fb.alem);
    const byKey: Record<string, any> = {};
    for (const c of q.criteria) byKey[c.key] = c;
    for (const sk of fb.skills || []) {
      const cur: Sk = skills.get(sk.id) || { id: sk.id, nome: sk.nome, earned: 0, possible: 0, ex: [] as Ex[], order: order++ };
      for (const k of sk.crit) {
        const c = byKey[k]; if (!c) continue;
        if (!q.missing) { cur.possible += c.pts; if (c.met) cur.earned += c.pts; }
        const r = critRate[q.qid]?.[k];
        if (r && r[1]) { cur.cNum = (cur.cNum || 0) + c.pts * r[0] / r[1]; cur.cDen = (cur.cDen || 0) + c.pts; }
      }
      cur.ex.push(sk.ex); skills.set(sk.id, cur);
    }
    const k6 = byKey["c6"];
    if (k6 && !q.missing) { c6.possible += k6.pts; if (k6.met) c6.earned += k6.pts; }
  }
  const all = [...skills.values(), ...(c6.possible ? [c6] : [])];
  const ratio = (s: Sk) => s.possible ? s.earned / s.possible : -1;
  const list = all.sort((a, b) => ratio(b) - ratio(a) || b.possible - a.possible || a.order - b.order).map((s) => ({
    nome: s.nome, earned: s.earned, possible: s.possible,          // possible 0 = not answered
    ex: s.id === "c6" ? [] : mergeEx(s.ex), dica: s.id === "c6" ? C6_TIP : undefined,
  }));
  const classRate = (s: Sk) => s.cDen ? s.cNum! / s.cDen : 0;
  const byRate = (a: Sk, b: Sk) => classRate(b) - classRate(a) || a.order - b.order;
  const cand = all.filter((s) => s.id !== "c6");
  const start = [
    ...cand.filter((s) => s.possible > 0 && s.earned < 0.9 * s.possible).sort(byRate),
    ...cand.filter((s) => s.possible === 0).sort(byRate),
  ].slice(0, 2);
  const used = new Set<string>();
  const startOut = start.map((s) => {
    const opts = mergeEx(s.ex).flatMap(([l, ns]) => ns.map((n) => [l, n] as [string, number]));
    const pick = opts.find(([l, n]) => !used.has(`${l}-${n}`)) || opts[0];
    used.add(`${pick[0]}-${pick[1]}`);
    return { nome: s.nome, ex: [[pick[0], [pick[1]]]] as Ex };
  });
  return { skills: list, alem: mergeEx(alem), start: startOut };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let p: Record<string, any>;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!p || p.action !== "report") return json({ error: "Unknown action" }, 400);

  try {
    const mat = normMatricula(p.matricula), code = normCode(p.code);
    if (!mat || !code) return json({ error: "missing", message: "Informe a matrícula e o código." }, 400);
    const ip = clientIp(req);
    if (await failCount(`relat:ip:${ip}`) >= FAIL_MAX_IP) {
      return json({ error: "throttled", message: "Muitas tentativas. Aguarde 15 minutos e tente de novo." }, 429);
    }
    const acc = (await rows(`student_access?matricula=eq.${encodeURIComponent(mat)}&active=eq.true` +
      `&select=matricula,nome,code_salt,code_hash,iterations,preview`))[0];
    // same work for unknown matrículas, so timing never reveals which exist
    const h = await pbkdf2Hex(code, acc ? acc.code_salt : DUMMY_SALT, acc ? acc.iterations : 100000);
    if (!acc || !sameHex(h, acc.code_hash)) {
      await failHit(`relat:ip:${ip}`);
      return json({ error: "denied", message: "Matrícula ou código incorretos." }, 403);
    }

    // access log (supabase/report_access.sql): matrícula + time only; test accounts
    // are not counted, and a failed write never blocks the student's correction
    // (awaited: the runtime may stop the worker once the response is sent)
    if (!acc.preview) {
      try {
        const r = await db(`report_access`, { method: "POST", headers: { Prefer: "return=minimal" },
                                              body: JSON.stringify({ matricula: acc.matricula }) });
        if (!r.ok) console.error("report_access", r.status);
      } catch (e) { console.error("report_access", e); }
    }

    // everything below is keyed on the VERIFIED matrícula only
    const links = await rows(`report_students?matricula=eq.${encodeURIComponent(acc.matricula)}&select=run_id,student_key`);
    const exams: any[] = [];
    if (links.length) {
      const runs = await rows(`report_runs?run_id=in.${inList(links.map((l) => l.run_id))}` +
        `&select=run_id,title,nota_base,published,created_at&order=created_at.asc`);
      for (const run of runs) {
        if (!run.published && !acc.preview) continue;
        const link = links.find((l) => l.run_id === run.run_id);
        const ex = link ? await buildExam(run, link.student_key) : null;
        if (ex) exams.push(ex);
      }
    }
    return json({ ok: true, nome: acc.nome, exams }, 200);
  } catch (e) {
    console.error(e);
    return json({ error: "server", message: "Erro no servidor. Tente de novo em instantes." }, 500);
  }
});
