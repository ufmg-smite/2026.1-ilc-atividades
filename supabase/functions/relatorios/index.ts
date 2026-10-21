// ============================================================
//  Edge Function: relatorios — a student's own corrected exams ("Minhas correções")
//
//  Independent of the quiz backend (`submit`): deploying or changing this
//  function never affects a running quiz. Deploy with "Verify JWT" OFF, like
//  the others (the page sends no Supabase session; the check below is the gate).
//
//    { action:"report", matricula, code }
//      -> { ok, nome, exams:[ { runId, title, notaBase, points, maxPoints, grade,
//             medianGrade, questions:[ { numero, titulo, score|null, max, median, delta, grader, typed,
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
      `&kind=in.(accept,override,reopen)&select=item_id,kind,score&order=created_at.asc&limit=5000`));
  }
  const dec: Record<string, number> = {};
  for (const e of evs) { if (e.kind === "reopen") delete dec[e.item_id]; else dec[e.item_id] = Number(e.score); }
  const byType: Record<string, number[]> = {}, byStudent: Record<string, { pts: number; n: number; graded: number }> = {};
  for (const it of items) {
    const st = (byStudent[it.student_key] ||= { pts: 0, n: 0, graded: 0 });
    st.n++;
    if (it.id in dec) {
      st.graded++; st.pts += dec[it.id];
      (byType[qtype(it.question_id)] ||= []).push(dec[it.id]);
    }
  }
  const grades = Object.values(byStudent).filter((s) => s.graded === s.n && s.n > 0)
    .map((s) => Math.min(100, Math.round((s.pts / base) * 100)));
  const byTypeMed: Record<string, number | null> = {};
  for (const [t, xs] of Object.entries(byType)) byTypeMed[t] = median(xs);
  return { medianGrade: median(grades), byType: byTypeMed };
}

// ---------- one exam, for one verified student ----------
async function buildExam(run: any, studentKey: string) {
  const items = await rows(`correction_items?run_id=eq.${encodeURIComponent(run.run_id)}` +
    `&student_key=eq.${encodeURIComponent(studentKey)}&select=id,question_id,image_paths,typed_answer`);
  if (!items.length) return null;
  const qids = items.map((i) => i.question_id);
  const [evs, crit, rq, staff] = await Promise.all([
    rows(`correction_events?item_id=in.${inList(items.map((i) => i.id))}&kind=in.(accept,override,reopen)` +
      `&select=item_id,kind,score,criteria,rubric,actor_email,created_at&order=created_at.asc`),
    rows(`correction_criteria?run_id=eq.${encodeURIComponent(run.run_id)}&question_id=in.${inList(qids)}` +
      `&active=eq.true&select=question_id,key,label,detail,points,position`),
    rows(`report_questions?run_id=eq.${encodeURIComponent(run.run_id)}&question_id=in.${inList(qids)}` +
      `&select=question_id,numero,titulo,gabarito_html`),
    rows(`staff?select=email,name`),
  ]);
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
  const questions = items.map((it) => {
    const d = dec[it.id];
    const meta = qmeta[it.question_id] || {};
    // The CURRENT barème (labels, points, max) with the grader's ticks. A grade
    // given under an earlier barème keeps its frozen score; its ticks map by key.
    const qcrit = crit.filter((c) => c.question_id === it.question_id)
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    const criteria = qcrit.map((c) => ({
      label: c.label ?? c.key, detail: c.detail ?? "",
      pts: Number(c.points), met: !!(d?.criteria?.[c.key]?.met),
    }));
    const max = criteria.reduce((s, c) => s + c.pts, 0);
    const sumMet = criteria.reduce((s, c) => s + (c.met ? c.pts : 0), 0);
    const score = d ? Number(d.score) : null;
    if (score === null) allGraded = false; else { points += score; maxPoints += max; }
    const gab = String(meta.gabarito_html || "").replace(assetRe, (_m, p) => url[p] || "");
    return {
      numero: meta.numero ?? 0, titulo: meta.titulo ?? it.question_id,
      score, max, delta: score === null ? 0 : Math.round((score - sumMet) * 100) / 100,
      median: stats ? (stats.byType[qtype(it.question_id)] ?? null) : null,
      grader: d ? (staffName[String(d.actor_email).toLowerCase()] || "") : "",
      criteria, scans: (it.image_paths || []).map((p: string) => url[p]).filter(Boolean),
      typed: it.typed_answer || "",            // quizzes: the typed part of the answer
      gabaritoHtml: gab,
    };
  }).sort((a, b) => a.numero - b.numero);

  const grade = allGraded && base > 0 ? Math.min(100, Math.round((points / base) * 100)) : null;
  return { runId: run.run_id, title: run.title, notaBase: base, points, maxPoints, grade,
           medianGrade: stats ? stats.medianGrade : null, questions };
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
