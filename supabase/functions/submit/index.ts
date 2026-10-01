// ============================================================
//  Edge Function: quiz backend (single endpoint, routes on `action`)
//
//  STUDENT actions (no access code — open while a quiz is open):
//    { action:"load" }                      -> the quiz currently OPEN
//    { action:"submit", quizId, studentName, studentEmail, questionId, answer }
//
//  STAFF actions (need a Google session; email must be in the `staff` allowlist):
//  (all carry Authorization: Bearer <supabase session token>)
//    { action:"listQuizzes" }
//    { action:"getQuiz",  quizId }
//    { action:"saveQuiz", quizId, title, description, questions:[{id,prompt}] }
//    { action:"open",     quizId, durationMinutes? }   // closes all others
//    { action:"close",    quizId }
//    { action:"status",   quizId }
//
//  Questions live in the `quizzes` table, so they can be edited from the
//  admin panel without touching the page. Each quiz is its own row, so
//  the whole semester's history is preserved. Only ONE quiz is open at a
//  time; the student page asks for "the open quiz" and needs no quiz id.
//
//  Secrets (Edge Functions -> Secrets): GEMINI_API_KEY (optional GEMINI_MODEL).
//  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400", // cache preflight so a background/keepalive flush isn't blocked
};

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "answers"; // private Storage bucket for photo answers
const ADMIN_ACTIONS = new Set([
  "open", "close", "status", "listQuizzes", "getQuiz", "saveQuiz", "renameQuiz",
  "setArchived", "analyze", "getAnswers", "generateCorrection",
  "lockRoster", "lockOverride",
]);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function getQuiz(quizId: string) {
  const res = await db(`quizzes?id=eq.${encodeURIComponent(quizId)}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ?? null;
}

// Per-question timing: a question may carry its own `durationMinutes` (stored in
// the questions JSON); blank/absent = use the quiz's global duration_minutes. All
// questions share the same opened_at, so a question's deadline is simply
// opened_at + (perQ ?? global). This lets e.g. a "challenge" run longer than the rest.
function qDurationMinutes(quiz: any, qid: string): number {
  const qs = Array.isArray(quiz.questions) ? quiz.questions : [];
  const q = qs.find((x: any) => x && x.id === qid);
  const d = q ? Number(q.durationMinutes) : NaN;
  return Number.isFinite(d) && d > 0 ? d : quiz.duration_minutes;
}
// The quiz stays "open" (loadable) while ANY question is still open: its overall
// end is opened_at + the LONGEST per-question duration (never below the global).
function maxDurationMinutes(quiz: any): number {
  const qs = Array.isArray(quiz.questions) ? quiz.questions : [];
  let m = quiz.duration_minutes;
  for (const q of qs) {
    const d = q ? Number(q.durationMinutes) : NaN;
    if (Number.isFinite(d) && d > 0 && d > m) m = d;
  }
  return m;
}
// Is a specific question still accepting submissions? (also the global gate: a
// question with no own clock closes exactly when the global window ends.)
function questionOpen(quiz: any, qid: string): boolean {
  if (!quiz.opened_at || quiz.force_closed) return false;
  const ends = new Date(quiz.opened_at).getTime() + qDurationMinutes(quiz, qid) * 60000;
  return Date.now() < ends;
}

function windowState(quiz: any): { isOpen: boolean; endsAt: string | null } {
  if (!quiz.opened_at || quiz.force_closed) return { isOpen: false, endsAt: null };
  const ends = new Date(quiz.opened_at).getTime() + maxDurationMinutes(quiz) * 60000;
  return { isOpen: Date.now() < ends, endsAt: new Date(ends).toISOString() };
}

async function getOpenQuiz() {
  const res = await db(
    `quizzes?force_closed=eq.false&opened_at=not.is.null&order=opened_at.desc&select=*`,
  );
  if (!res.ok) return null;
  const rows = await res.json();
  for (const q of rows) if (windowState(q).isOpen) return q;
  return null;
}

// ============================================================
//  In-class commitment ("entrega em aula") — optional two-phase mode.
//  A quiz may set `in_class_minutes` (M, with 0 < M < global duration). Then:
//   • Phase 1 (first M minutes): the whole quiz is visible and editable.
//   • At M: ONE question the student picked (the "questão da aula") freezes.
//       - default = the first question they gave a non-empty answer to;
//       - re-selectable until M (last choice wins; it only picks WHICH question
//         locks, never when — the lock happens at M).
//   • Phase 2 (M .. global end): if the chosen question is NON-EMPTY, it is
//     frozen and the REST stays editable to the end; if it is EMPTY, the whole
//     quiz is closed for that student.
//   • The teacher can reopen a student's ACCESS (phase-2 access) and/or their
//     frozen QUESTION, independently (lock_overrides, append-only, last wins).
//  State lives in two tables: lock_choices (the pick) and lock_overrides.
// ============================================================
const LOCK_GRACE_MIN = 0.5; // 30s grace past M to absorb the boundary flush
function inClassMinutes(quiz: any): number {
  const m = Number(quiz.in_class_minutes);
  return Number.isFinite(m) && m > 0 ? Math.floor(m) : 0;
}
function lockFeatureActive(quiz: any): boolean {
  const m = inClassMinutes(quiz);
  return m > 0 && m < maxDurationMinutes(quiz) && !!quiz.opened_at && !quiz.force_closed;
}
function minutesSinceOpen(quiz: any): number {
  return (Date.now() - new Date(quiz.opened_at).getTime()) / 60000;
}
function answerNonEmpty(s: any): boolean {
  return !!s && ((typeof s.answer === "string" && s.answer.trim() !== "") ||
    (Array.isArray(s.image_ids) && s.image_ids.length > 0));
}
async function studentSubs(quizId: string, email: string): Promise<any[]> {
  const res = await db(
    `submissions?quiz_id=eq.${encodeURIComponent(quizId)}` +
    `&student_email=eq.${encodeURIComponent(email)}` +
    `&select=question_id,answer,image_ids,created_at&order=created_at`,
  );
  return res.ok ? await res.json() : [];
}
// First question (chronologically) the student gave a non-empty answer to.
function defaultLockQ(subs: any[]): string | null {
  for (const s of subs) if (answerNonEmpty(s)) return s.question_id;
  return null;
}
function latestByQ(subs: any[]): Record<string, any> {
  const m: Record<string, any> = {};
  for (const s of subs) m[s.question_id] = s; // asc order -> last wins
  return m;
}
async function lockChoice(quizId: string, email: string): Promise<string | null> {
  const res = await db(
    `lock_choices?quiz_id=eq.${encodeURIComponent(quizId)}` +
    `&student_email=eq.${encodeURIComponent(email)}` +
    `&order=created_at.desc&limit=1&select=question_id`,
  );
  const rows = res.ok ? await res.json() : [];
  return rows[0]?.question_id ?? null;
}
async function lockOverridesFor(
  quizId: string, email: string,
): Promise<{ access: boolean; question: boolean }> {
  const res = await db(
    `lock_overrides?quiz_id=eq.${encodeURIComponent(quizId)}` +
    `&student_email=eq.${encodeURIComponent(email.toLowerCase())}` +
    `&order=created_at.desc&select=kind,granted`,
  );
  const rows = res.ok ? await res.json() : [];
  const latest: Record<string, boolean> = {};
  for (const r of rows) if (!(r.kind in latest)) latest[r.kind] = r.granted === true;
  return { access: latest.access === true, question: latest.question === true };
}
// Full per-student lock status (chosen/default question, gate, teacher overrides).
async function lockStatus(quiz: any, email: string) {
  const subs = await studentSubs(quiz.id, email);
  const choice = await lockChoice(quiz.id, email);
  const lockQ = choice ?? defaultLockQ(subs);
  const latest = latestByQ(subs);
  const gateMet = !!lockQ && answerNonEmpty(latest[lockQ]);
  const ov = await lockOverridesFor(quiz.id, email);
  return { lockQ, isDefault: !choice, gateMet, access: ov.access, question: ov.question };
}
// Decide whether a submission to `qid` by `email` is accepted right now. Folds
// the global/per-question deadline together with the two-phase lock rules.
async function acceptSubmission(
  quiz: any, qid: string, email: string,
): Promise<{ open: boolean; scope?: string; message?: string }> {
  if (!questionOpen(quiz, qid)) {
    const scope = windowState(quiz).isOpen ? "question" : "quiz";
    return { open: false, scope,
      message: scope === "quiz" ? "O tempo do quiz terminou." : "O tempo desta questão terminou." };
  }
  if (!lockFeatureActive(quiz)) return { open: true };
  // A short grace past M keeps an in-flight boundary flush (the page auto-saves
  // the chosen question exactly at M) from being lost to clock skew / latency.
  // The page freezes its UI at M regardless, so students never edit in the grace.
  if (minutesSinceOpen(quiz) <= inClassMinutes(quiz) + LOCK_GRACE_MIN) return { open: true }; // phase 1
  const st = await lockStatus(quiz, email);                                   // phase 2
  if (!(st.gateMet || st.access)) {
    return { open: false, scope: "quiz",
      message: "A etapa em aula não foi concluída — o quiz está fechado para você." };
  }
  if (qid === st.lockQ && !st.question) {
    return { open: false, scope: "question",
      message: "Esta questão já foi entregue definitivamente." };
  }
  return { open: true };
}

async function submissionCount(quizId: string): Promise<string> {
  const c = await db(
    `submissions?quiz_id=eq.${encodeURIComponent(quizId)}&select=id`,
    { headers: { Prefer: "count=exact", Range: "0-0" } },
  );
  return c.headers.get("content-range")?.split("/")[1] ?? "?";
}

async function imageCount(quizId: string, questionId: string, email: string): Promise<number> {
  const c = await db(
    `answer_images?quiz_id=eq.${encodeURIComponent(quizId)}` +
    `&question_id=eq.${encodeURIComponent(questionId)}` +
    `&student_email=eq.${encodeURIComponent(email)}&select=id`,
    { headers: { Prefer: "count=exact", Range: "0-0" } },
  );
  return parseInt(c.headers.get("content-range")?.split("/")[1] ?? "0", 10) || 0;
}

// ---------- Supabase Storage (photo answers) ----------
function storage(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPA_URL}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      ...(init.headers || {}),
    },
  });
}

// ---------- lightweight rate limiting (DB-backed) ----------
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || "unknown";
}

async function rateCount(bucket: string, windowSec: number): Promise<number> {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const res = await db(
    `rate_limit?bucket=eq.${encodeURIComponent(bucket)}&created_at=gte.${encodeURIComponent(since)}&select=id`,
    { headers: { Prefer: "count=exact", Range: "0-0" } },
  );
  return parseInt(res.headers.get("content-range")?.split("/")[1] ?? "0", 10) || 0;
}

async function rateHit(bucket: string): Promise<void> {
  await db(`rate_limit`, {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ bucket }),
  });
  // keep the table small: drop this bucket's rows older than 1 hour
  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
  await db(
    `rate_limit?bucket=eq.${encodeURIComponent(bucket)}&created_at=lt.${encodeURIComponent(cutoff)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );
}

// Tunables
const ADMIN_MAX_FAILS = 8;      // wrong admin codes allowed...
const ADMIN_WINDOW_SEC = 600;   // ...per 10 minutes, per IP
// Submission throttle is per STUDENT (email) and limits FREQUENCY only — not the
// total number of attempts (students may resubmit as often as they like, last wins).
// Per-student (not per-IP) means a whole class behind one campus IP is never
// collectively throttled; it only stops one student's script from rapid-firing.
const SUB_MAX_PER_WINDOW = 20;  // submissions...
const SUB_WINDOW_SEC = 30;      // ...per 30 seconds, per student

// ---------- staff auth (Supabase Auth session + allowlist) ----------
// Verify a Supabase user access token (from Google login) against Supabase
// itself (signature + expiry) and return the verified lowercase email. We
// never trust the browser's claim of who it is.
async function verifiedEmail(req: Request): Promise<string | null> {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${m[1]}` },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  const email = (u?.email || "").toLowerCase().trim();
  return email || null;
}

async function staffRole(email: string): Promise<string | null> {
  const res = await db(`staff?email=eq.${encodeURIComponent(email)}&select=role`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0]?.role ?? null;
}

// { email, role } for an authenticated + allowlisted caller; { denied:true }
// for a valid Google login that is NOT on the allowlist; null for no/invalid
// session.
async function authStaff(
  req: Request,
): Promise<{ email: string; role: string } | { denied: true } | null> {
  const email = await verifiedEmail(req);
  if (!email) return null;                    // no valid Google session
  const role = await staffRole(email);
  return role ? { email, role } : { denied: true };
}

// Every staff member in the `staff` allowlist (teacher or monitor) may perform
// all admin actions; the role is kept for reference/audit only.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let p: Record<string, any>;
  try {
    p = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = p.action;

  // ================= STAFF (teachers + monitors) =================
  if (ADMIN_ACTIONS.has(action) || action === "whoami") {
    const ip = clientIp(req);
    if (await rateCount(`admin:${ip}`, ADMIN_WINDOW_SEC) >= ADMIN_MAX_FAILS) {
      return json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, 429);
    }
    const who = await authStaff(req);
    if (!who) {
      await rateHit(`admin:${ip}`); // count only failed auth toward the lockout
      return json({ error: "unauthenticated", message: "Faça login com a sua conta Google." }, 403);
    }
    if ("denied" in who) {
      // valid Google login, just not on the allowlist — not a brute-force attempt
      return json({ error: "sem_acesso", message: "Este e-mail não tem acesso." }, 403);
    }
    if (action === "whoami") {
      return json({ ok: true, email: who.email, role: who.role }, 200);
    }

    if (action === "listQuizzes") {
      const filter = p.includeArchived === true ? "" : "&archived=eq.false";
      const res = await db(
        `quizzes?select=id,title,opened_at,duration_minutes,in_class_minutes,force_closed,archived,questions&order=id${filter}`,
      );
      if (!res.ok) return json({ error: "Could not list quizzes" }, 500);
      const rows = await res.json();
      const quizzes = rows.map((q: any) => {
        const w = windowState(q);
        return {
          id: q.id, title: q.title, isOpen: w.isOpen,
          openedAt: q.opened_at, endsAt: w.endsAt,
          durationMinutes: q.duration_minutes, forceClosed: q.force_closed,
          inClassMinutes: inClassMinutes(q) || null,
          archived: q.archived === true,
        };
      });
      return json({ ok: true, quizzes }, 200);
    }

    if (action === "getQuiz") {
      const quiz = await getQuiz(p.quizId);
      if (!quiz) return json({ error: "Quiz not found" }, 404);
      return json({
        ok: true,
        quiz: {
          id: quiz.id, title: quiz.title, description: quiz.description,
          questions: quiz.questions, durationMinutes: quiz.duration_minutes,
          inClassMinutes: quiz.in_class_minutes ?? null,
        },
      }, 200);
    }

    // Full answer export (text + photo signed URLs). Staff are always Google-
    // authenticated (verified identity + allowlist) before reaching here.
    if (action === "getAnswers") {
      const quizId = p.quizId;
      if (!quizId) return json({ error: "quizId obrigatório" }, 400);

      const sres = await db(
        `submissions?quiz_id=eq.${encodeURIComponent(quizId)}` +
        `&select=student_name,student_email,question_id,answer,image_ids,created_at&order=created_at`,
      );
      if (!sres.ok) return json({ error: "Falha ao ler respostas" }, 500);
      const submissions = await sres.json();

      const ires = await db(
        `answer_images?quiz_id=eq.${encodeURIComponent(quizId)}&select=id,path`,
      );
      const imgRows = ires.ok ? await ires.json() : [];
      let images: any[] = [];
      if (imgRows.length) {
        // one batch call to sign every photo URL (valid 15 min); the browser
        // fetches the bytes directly from Storage and zips them.
        const paths = imgRows.map((r: any) => r.path);
        const sign = await storage(`object/sign/${BUCKET}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiresIn: 900, paths }),
        });
        const signed = sign.ok ? await sign.json() : [];
        const byPath: Record<string, string> = {};
        for (const s of signed) {
          const u = s.signedURL || s.signedUrl;
          if (u) byPath[s.path] = u;
        }
        images = imgRows.map((r: any) => ({
          id: r.id,
          url: byPath[r.path] ? `${SUPA_URL}/storage/v1${byPath[r.path]}` : null,
        }));
      }
      return json({ ok: true, quizId, submissions, images }, 200);
    }

    // LLM-drafted correction (gabarito) — text answers only, like analyze.
    // Returns structured JSON per question; the browser renders/edits it and
    // prints the PDF. Google-only (reads student answers).
    if (action === "generateCorrection") {
      const quiz = await getQuiz(p.quizId);
      if (!quiz) return json({ error: "Quiz not found" }, 404);

      const res = await db(
        `submissions?quiz_id=eq.${encodeURIComponent(p.quizId)}` +
        `&select=student_email,student_name,question_id,answer,created_at&order=created_at`,
      );
      if (!res.ok) return json({ error: "Falha ao ler respostas" }, 500);
      const rows = await res.json();
      const latest: Record<string, Record<string, string>> = {};
      for (const r of rows) {
        const w2 = ((r.student_email || r.student_name || "anon") as string).toLowerCase();
        (latest[w2] ??= {})[r.question_id] = r.answer;
      }
      const byQ: Record<string, string[]> = {};
      for (const w2 in latest) for (const qid in latest[w2]) (byQ[qid] ??= []).push(latest[w2][qid]);
      const studentCount = Object.keys(latest).length;

      const orderedQ: string[] = (quiz.questions || []).map((q: any) => q.id);
      const qmap: Record<string, string> = {};
      for (const q of (quiz.questions || [])) qmap[q.id] = q.prompt;

      const BASE =
        "Você é um assistente pedagógico do curso DCC638 (Introdução à Lógica Computacional), " +
        "em português formal. Gere uma CORREÇÃO (gabarito comentado) voltada aos ALUNOS. Para CADA " +
        "questão produza: (1) \"solucao\": a resposta curta e CORRETA (concisa; mostre passos só " +
        "quando essenciais); (2) \"nota_tipo\": \"erro\" se houver um erro claro e recorrente nas " +
        "respostas, senão \"dica\"; (3) \"nota\": um bloco CURTO com a MENSAGEM PEDAGÓGICA PRINCIPAL " +
        "da questão — o que o aluno deve LEMBRAR dela. A nota NÃO é análise estatística: NÃO diga " +
        "quantos alunos acertaram ou erraram; foque no conceito (ou no erro conceitual) de forma " +
        "clara e concisa. Escreva os símbolos matemáticos em UNICODE (∀ ∃ ¬ ∧ ∨ → ↔ ≡ ⊕ ∈ ≥ ≤ ≠), " +
        "NUNCA LaTeX nem cifrões. Use \"demonstração/demonstrar\", nunca \"prova/provar\". Seja conciso.";

      let prompt = BASE + "\n";
      if (typeof p.instructions === "string" && p.instructions.trim()) {
        prompt += `\nInstruções adicionais do professor (siga-as):\n${p.instructions.trim().slice(0, 4000)}\n`;
      }
      if (Array.isArray(p.previous) && p.previous.length) {
        prompt += "\nVersão anterior (refine conforme as instruções; mantenha o que estiver bom):\n" +
          JSON.stringify(p.previous).slice(0, 12000) + "\n";
      }
      prompt += "\nQuestões e respostas dos alunos:\n";
      for (const qid of orderedQ) {
        prompt += `\n### ${qid}\nEnunciado:\n${qmap[qid]}\n`;
        const answers = byQ[qid] || [];
        prompt += `Respostas (${answers.length}):\n`;
        for (const a of answers.slice(0, 150)) prompt += `- ${String(a).replace(/\s+/g, " ").slice(0, 700)}\n`;
      }

      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      if (!geminiKey) return json({ error: "GEMINI_API_KEY não configurada" }, 500);
      const model = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
      const schema = {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                solucao: { type: "string" },
                nota_tipo: { type: "string", enum: ["dica", "erro"] },
                nota: { type: "string" },
              },
              required: ["id", "solucao", "nota_tipo", "nota"],
            },
          },
        },
        required: ["questions"],
      };
      const gres = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3, maxOutputTokens: 4096,
              responseMimeType: "application/json", responseSchema: schema,
            },
          }),
        },
      );
      if (!gres.ok) {
        const detail = (await gres.text()).slice(0, 300);
        return json({ error: "Falha ao gerar correção (LLM)", detail }, 502);
      }
      const gdata = await gres.json();
      const rawText = (gdata?.candidates?.[0]?.content?.parts || []).map((pt: any) => pt.text || "").join("").trim();
      let parsed: any = null;
      try { parsed = JSON.parse(rawText); } catch { /* leave null */ }
      const byId: Record<string, any> = {};
      for (const q of (parsed?.questions || [])) if (q && q.id) byId[q.id] = q;

      const questions = orderedQ.map((qid) => ({
        id: qid,
        enunciado: qmap[qid] || "",
        solucao: byId[qid]?.solucao || "",
        nota_tipo: byId[qid]?.nota_tipo === "erro" ? "erro" : "dica",
        nota: byId[qid]?.nota || "",
      }));
      return json({ ok: true, title: quiz.title, questions, students: studentCount }, 200);
    }

    if (action === "saveQuiz") {
      const { quizId, title, description, questions } = p;
      if (!quizId || !/^[a-z0-9-]{1,60}$/.test(quizId)) {
        return json({ error: "ID inválido (use letras minúsculas, números e hífens)" }, 400);
      }
      if (!title || String(title).length > 200) return json({ error: "Título obrigatório" }, 400);
      if (!Array.isArray(questions) || questions.length === 0) {
        return json({ error: "Adicione pelo menos uma questão" }, 400);
      }
      for (const q of questions) {
        if (!q || typeof q.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(q.id) ||
            typeof q.prompt !== "string") {
          return json({ error: "Questão inválida (id/prompt)" }, 400);
        }
        if (q.prompt.length > 8000) return json({ error: "Enunciado muito longo" }, 400);
      }
      if (new Set(questions.map((q: any) => q.id)).size !== questions.length) {
        return json({ error: "IDs de questão duplicados" }, 400);
      }

      const dur = Number.isFinite(p.durationMinutes) && p.durationMinutes > 0
        ? Math.min(Math.floor(p.durationMinutes), 600)
        : 30;
      // Optional in-class window (minutes). Must be below the global duration to
      // mean anything; null = feature off (ordinary single-phase quiz).
      const icmRaw = Number(p.inClassMinutes);
      const inClass = Number.isFinite(icmRaw) && icmRaw > 0
        ? Math.min(Math.floor(icmRaw), dur) : null;
      // `originalId` is the id the editor was opened with (null for a new quiz).
      // Guard only when the client sent it, so an older cached page (which omits
      // the field) can still edit during the deploy window.
      const hasOrig = Object.prototype.hasOwnProperty.call(p, "originalId");
      const originalId = typeof p.originalId === "string" ? p.originalId : null;
      const existing = await getQuiz(quizId);
      // Only an edit of THIS same quiz (originalId === quizId) may overwrite an
      // existing row. A new quiz (or an edit re-typed to a different existing id)
      // must not silently clobber another quiz that shares the id.
      if (hasOrig && existing && originalId !== quizId) {
        return json({ error: "id_exists",
          message: `Já existe um quiz com o id "${quizId}". Escolha outro id (ou edite o quiz existente).` }, 409);
      }
      // Store a clean questions array: id + prompt, plus an OPTIONAL per-question
      // durationMinutes (clamped) when set — absent means "use the global clock".
      const cleanQuestions = questions.map((q: any) => {
        const out: any = { id: q.id, prompt: q.prompt };
        const d = Number(q.durationMinutes);
        if (Number.isFinite(d) && d > 0) out.durationMinutes = Math.min(Math.floor(d), 600);
        return out;
      });
      const body = { title, description: description ?? null, questions: cleanQuestions,
        duration_minutes: dur, in_class_minutes: inClass };
      let r: Response;
      if (existing) {
        // snapshot the CURRENT content before overwriting — nothing is ever lost
        await db(`quiz_history`, {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            quiz_id: existing.id, title: existing.title,
            description: existing.description, questions: existing.questions,
          }),
        });
        r = await db(`quizzes?id=eq.${encodeURIComponent(quizId)}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body),
        });
      } else {
        r = await db(`quizzes`, {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ id: quizId, ...body }),
        });
      }
      if (!r.ok) return json({ error: "Falha ao salvar" }, 500);
      return json({ ok: true, created: !existing }, 200);
    }

    if (action === "renameQuiz") {
      const { oldId, newId } = p;
      if (!newId || !/^[a-z0-9-]{1,60}$/.test(newId)) {
        return json({ error: "Novo ID inválido (letras minúsculas, números e hífens)" }, 400);
      }
      if (oldId === newId) return json({ ok: true }, 200);
      if (!(await getQuiz(oldId))) return json({ error: "Quiz de origem não encontrado" }, 404);
      if (await getQuiz(newId)) return json({ error: "Já existe um quiz com esse ID" }, 409);
      // migrate the answers first, then the quiz row, so nothing is orphaned
      const s = await db(`submissions?quiz_id=eq.${encodeURIComponent(oldId)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ quiz_id: newId }),
      });
      if (!s.ok) return json({ error: "Falha ao migrar respostas" }, 500);
      const r = await db(`quizzes?id=eq.${encodeURIComponent(oldId)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ id: newId }),
      });
      if (!r.ok) return json({ error: "Falha ao renomear (respostas já migradas)" }, 500);
      return json({ ok: true }, 200);
    }

    if (action === "setArchived") {
      if (typeof p.archived !== "boolean") return json({ error: "archived deve ser booleano" }, 400);
      if (!(await getQuiz(p.quizId))) return json({ error: "Quiz not found" }, 404);
      const r = await db(`quizzes?id=eq.${encodeURIComponent(p.quizId)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ archived: p.archived }),
      });
      if (!r.ok) return json({ error: "Falha ao arquivar" }, 500);
      return json({ ok: true }, 200);
    }

    // Who is on the in-class-commitment list, their chosen question, whether their
    // gate is met, and any teacher overrides — for the admin "Entrega em aula" panel.
    if (action === "lockRoster") {
      const quiz = await getQuiz(p.quizId);
      if (!quiz) return json({ error: "Quiz not found" }, 404);
      const sres = await db(
        `submissions?quiz_id=eq.${encodeURIComponent(p.quizId)}` +
        `&select=student_name,student_email,question_id,answer,image_ids,created_at&order=created_at`,
      );
      const subs = sres.ok ? await sres.json() : [];
      const byStu: Record<string, any[]> = {}; const names: Record<string, string> = {};
      for (const s of subs) {
        const e = (s.student_email || "").toLowerCase();
        (byStu[e] ??= []).push(s);
        if (s.student_name) names[e] = s.student_name;
      }
      const cres = await db(
        `lock_choices?quiz_id=eq.${encodeURIComponent(p.quizId)}&order=created_at.desc&select=student_email,question_id`,
      );
      const choice: Record<string, string> = {};
      for (const r of (cres.ok ? await cres.json() : [])) {
        const e = (r.student_email || "").toLowerCase();
        if (!(e in choice)) choice[e] = r.question_id;
      }
      const ores = await db(
        `lock_overrides?quiz_id=eq.${encodeURIComponent(p.quizId)}&order=created_at.desc&select=student_email,kind,granted`,
      );
      const ov: Record<string, Record<string, boolean>> = {};
      for (const r of (ores.ok ? await ores.json() : [])) {
        const e = (r.student_email || "").toLowerCase();
        (ov[e] ??= {});
        if (!(r.kind in ov[e])) ov[e][r.kind] = r.granted === true;
      }
      const roster = Object.keys(byStu).map((e) => {
        const list = byStu[e];
        const latest = latestByQ(list);
        const lockQ = choice[e] ?? defaultLockQ(list);
        const gateMet = !!lockQ && answerNonEmpty(latest[lockQ]);
        return {
          email: e, name: names[e] || "", lockQuestionId: lockQ,
          isDefault: !(e in choice), gateMet,
          accessOverride: ov[e]?.access === true,
          questionOverride: ov[e]?.question === true,
        };
      }).sort((a, b) => {
        const na = (a.name || a.email).toLowerCase(), nb = (b.name || b.email).toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
      return json({ ok: true, inClassMinutes: inClassMinutes(quiz),
        active: lockFeatureActive(quiz), roster }, 200);
    }

    // Reopen a student's phase-2 ACCESS or their frozen QUESTION (append-only; the
    // latest row per (student,kind) wins). Two independent switches, as the teacher
    // asked — reopening access never un-freezes the committed question, and vice versa.
    if (action === "lockOverride") {
      const { quizId, studentEmail, kind } = p;
      if (!quizId || !studentEmail || (kind !== "access" && kind !== "question")) {
        return json({ error: "Parâmetros inválidos" }, 400);
      }
      if (!(await getQuiz(quizId))) return json({ error: "Quiz not found" }, 404);
      const r = await db(`lock_overrides`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          quiz_id: quizId, student_email: String(studentEmail).toLowerCase(),
          kind, granted: p.granted !== false, actor_email: who.email,
        }),
      });
      if (!r.ok) return json({ error: "Falha ao registrar" }, 500);
      return json({ ok: true }, 200);
    }

    if (action === "analyze") {
      const quiz = await getQuiz(p.quizId);
      if (!quiz) return json({ error: "Quiz not found" }, 404);

      const res = await db(
        `submissions?quiz_id=eq.${encodeURIComponent(p.quizId)}` +
        `&select=student_email,student_name,question_id,answer,created_at&order=created_at`,
      );
      if (!res.ok) return json({ error: "Falha ao ler respostas" }, 500);
      const rows = await res.json();

      // Keep only the latest answer per student per question, then DROP identity
      // entirely — the LLM sees anonymous answers grouped by question, nothing else.
      const latest: Record<string, Record<string, string>> = {};
      for (const r of rows) {
        const who = ((r.student_email || r.student_name || "anon") as string).toLowerCase();
        (latest[who] ??= {})[r.question_id] = r.answer; // ordered oldest->newest, last wins
      }
      const byQ: Record<string, string[]> = {};
      for (const who in latest) {
        for (const qid in latest[who]) (byQ[qid] ??= []).push(latest[who][qid]);
      }
      const studentCount = Object.keys(latest).length;
      const questionCount = Object.keys(byQ).length;
      if (questionCount === 0) {
        return json({ ok: true, summary: "Nenhuma resposta ainda.", students: 0, questions: 0 }, 200);
      }

      const qmap: Record<string, string> = {};
      for (const q of (quiz.questions || [])) qmap[q.id] = q.prompt;

      let prompt =
        "Você é um assistente pedagógico. A seguir estão respostas ANÔNIMAS de alunos a uma " +
        `atividade (\"${quiz.title}\"). Para cada questão, identifique de forma concisa e em ` +
        "português, em Markdown: (1) os erros ou equívocos mais comuns, (2) o nível geral de " +
        "compreensão, (3) o que o professor deveria revisar em aula. Organize por questão.\n" +
        "FORMATO: use Markdown simples e escreva os símbolos matemáticos diretamente em Unicode " +
        "(∀, ∃, ¬, ∧, ∨, →, ↔, ∈, ≥, ≤, ≠, ², ₙ). NÃO use LaTeX, NÃO use cifrões ($) nem \\\\comandos.\n";
      for (const qid of Object.keys(byQ).sort()) {
        prompt += `\n## ${qid}\n`;
        if (qmap[qid]) prompt += `Enunciado:\n${qmap[qid]}\n\n`;
        prompt += `Respostas dos alunos (${byQ[qid].length}):\n`;
        for (const a of byQ[qid]) prompt += `- ${String(a).replace(/\s+/g, " ").slice(0, 1500)}\n`;
      }

      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      if (!geminiKey) return json({ error: "GEMINI_API_KEY não configurada" }, 500);
      // Overridable via a GEMINI_MODEL secret, so a future Google model change
      // is a secret edit, not a code change.
      const model = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
      const gres = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
          }),
        },
      );
      if (!gres.ok) {
        const detail = (await gres.text()).slice(0, 300);
        return json({ error: "Falha na análise (LLM)", detail }, 502);
      }
      const gdata = await gres.json();
      const summary = (gdata?.candidates?.[0]?.content?.parts || [])
        .map((pt: any) => pt.text || "").join("").trim();
      if (!summary) return json({ error: "A análise não retornou conteúdo" }, 502);

      // Only the summary + counts go back to the browser — never the raw answers.
      return json({ ok: true, summary, students: studentCount, questions: questionCount }, 200);
    }

    // open / close / status operate on a specific quiz
    const quiz = await getQuiz(p.quizId);
    if (!quiz) return json({ error: "Quiz not found" }, 404);

    if (action === "open") {
      // enforce a single active quiz: close every other one first
      await db(`quizzes?id=neq.${encodeURIComponent(p.quizId)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ force_closed: true }),
      });
      const dur = Number.isFinite(p.durationMinutes) ? p.durationMinutes : quiz.duration_minutes;
      const nowIso = new Date().toISOString();
      const r = await db(`quizzes?id=eq.${encodeURIComponent(p.quizId)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ opened_at: nowIso, force_closed: false, duration_minutes: dur }),
      });
      if (!r.ok) return json({ error: "Could not open" }, 500);
      // Overall end = opened_at + the longest clock (a per-question one may exceed the global).
      const maxDur = maxDurationMinutes({ questions: quiz.questions, duration_minutes: dur });
      const endsAt = new Date(new Date(nowIso).getTime() + maxDur * 60000).toISOString();
      return json({ ok: true, endsAt }, 200);
    }

    if (action === "close") {
      const r = await db(`quizzes?id=eq.${encodeURIComponent(p.quizId)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ force_closed: true }),
      });
      if (!r.ok) return json({ error: "Could not close" }, 500);
      return json({ ok: true }, 200);
    }

    // status
    const w = windowState(quiz);
    return json({
      ok: true,
      status: {
        isOpen: w.isOpen, openedAt: quiz.opened_at, endsAt: w.endsAt,
        forceClosed: quiz.force_closed, durationMinutes: quiz.duration_minutes,
        submissions: await submissionCount(p.quizId),
      },
    }, 200);
  }

  // ================= STUDENT =================
  // No access code: anyone can load the open quiz and submit while it's open.
  // Timing (teacher opens/closes) + the per-student rate limit are the controls.

  if (action === "load") {
    // No quizId needed: hand out whichever quiz is currently open.
    const quiz = p.quizId ? await getQuiz(p.quizId) : await getOpenQuiz();
    if (!quiz) return json({ error: "not_open", message: "Nenhum quiz aberto no momento." }, 423);
    const w = windowState(quiz);
    if (!w.isOpen) return json({ error: "not_open", message: "O quiz não está aberto no momento." }, 423);
    // Give each question its own absolute deadline so the page can show a rolling
    // clock and lock questions individually; endsAt (top level) is the last to close.
    const openedMs = new Date(quiz.opened_at).getTime();
    const questions = (Array.isArray(quiz.questions) ? quiz.questions : []).map((q: any) => ({
      ...q,
      endsAt: new Date(openedMs + qDurationMinutes(quiz, q.id) * 60000).toISOString(),
    }));
    return json({
      ok: true,
      quiz: {
        id: quiz.id, title: quiz.title, description: quiz.description,
        questions, endsAt: w.endsAt, openedAt: quiz.opened_at,
        inClassMinutes: lockFeatureActive(quiz) ? inClassMinutes(quiz) : null, // only in two-phase mode
        serverNow: new Date().toISOString(), // client uses this to correct a skewed device clock
      },
    }, 200);
  }

  // Per-student in-class-commitment status (the page polls this to show which
  // question is "da aula", whether the gate is met, and after M to freeze/open).
  if (action === "lockState") {
    const quiz = p.quizId ? await getQuiz(p.quizId) : await getOpenQuiz();
    const email = typeof p.studentEmail === "string" ? p.studentEmail : "";
    if (!quiz || !email) return json({ error: "bad_request" }, 400);
    if (!lockFeatureActive(quiz)) return json({ ok: true, active: false }, 200);
    const M = inClassMinutes(quiz);
    const openedMs = new Date(quiz.opened_at).getTime();
    const st = await lockStatus(quiz, email);
    return json({
      ok: true, active: true, inClassMinutes: M,
      phase1EndsAt: new Date(openedMs + M * 60000).toISOString(),
      lockQuestionId: st.lockQ, isDefault: st.isDefault,
      lockQuestionEmpty: !st.gateMet, gateMet: st.gateMet,
      phase: minutesSinceOpen(quiz) <= M ? 1 : 2,
      accessOverride: st.access, questionOverride: st.question,
      endsAt: windowState(quiz).endsAt,
      serverNow: new Date().toISOString(),
    }, 200);
  }

  // Pick WHICH question becomes the "questão da aula" (the one that freezes at M).
  // Allowed only in phase 1; last pick wins. Picking does NOT lock anything now.
  if (action === "chooseLock") {
    const { quizId, studentEmail, questionId } = p;
    if (!quizId || !studentEmail || !questionId) return json({ error: "Missing fields" }, 400);
    const quiz = await getQuiz(quizId);
    if (!quiz) return json({ error: "Quiz not found" }, 404);
    if (!lockFeatureActive(quiz)) return json({ error: "not_applicable" }, 400);
    if (minutesSinceOpen(quiz) > inClassMinutes(quiz)) {
      return json({ error: "closed", scope: "lock",
        message: "O período de escolha da questão da aula terminou." }, 423);
    }
    if (!(Array.isArray(quiz.questions) && quiz.questions.some((q: any) => q && q.id === questionId))) {
      return json({ error: "Questão inválida" }, 400);
    }
    const bucket = `lock:${quizId}:${studentEmail.toLowerCase()}`;
    if (await rateCount(bucket, 30) >= 30) {
      return json({ error: "Aguarde alguns segundos." }, 429);
    }
    await rateHit(bucket);
    const r = await db(`lock_choices`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ quiz_id: quizId, student_email: studentEmail, question_id: questionId }),
    });
    if (!r.ok) return json({ error: "Falha ao registrar escolha" }, 500);
    return json({ ok: true }, 200);
  }

  if (action === "submit" || action === undefined) {
    const { quizId, studentName, studentEmail, questionId, answer, imageIds } = p;
    if (!quizId || !studentName || !studentEmail || !questionId || typeof answer !== "string") {
      return json({ error: "Missing fields" }, 400);
    }
    if (studentName.length > 120 || studentEmail.length > 160 || answer.length > 10000) {
      return json({ error: "Field too long" }, 400);
    }
    const quiz = await getQuiz(quizId);
    if (!quiz) return json({ error: "Quiz not found" }, 404);
    // scope="quiz" when the whole quiz is closed (force-closed, past the last
    // deadline, or the in-class gate was missed) so the page locks everything;
    // "question" when only this one ended / was committed "da aula".
    const acc = await acceptSubmission(quiz, questionId, studentEmail);
    if (!acc.open) return json({ error: "closed", scope: acc.scope, message: acc.message }, 423);

    // anti-spam: throttle FREQUENCY per student (email), not per IP and not a
    // total cap — so classmates sharing one campus IP never throttle each other,
    // and a student can still resubmit freely; this only blocks rapid-fire floods.
    const bucket = `sub:${quizId}:${studentEmail.toLowerCase()}`;
    if (await rateCount(bucket, SUB_WINDOW_SEC) >= SUB_MAX_PER_WINDOW) {
      return json({ error: "Você está enviando rápido demais. Aguarde alguns segundos." }, 429);
    }
    await rateHit(bucket);

    // Confirmed photos: keep only image ids that belong to THIS student + question
    // (students can only attach their own uploads; nothing here deletes anything).
    let validIds: number[] = [];
    if (Array.isArray(imageIds) && imageIds.length) {
      const idList = imageIds.filter((x: any) => Number.isInteger(x)).slice(0, 30);
      if (idList.length) {
        const chk = await db(
          `answer_images?quiz_id=eq.${encodeURIComponent(quizId)}` +
          `&question_id=eq.${encodeURIComponent(questionId)}` +
          `&student_email=eq.${encodeURIComponent(studentEmail)}` +
          `&id=in.(${idList.join(",")})&select=id`,
        );
        if (chk.ok) validIds = (await chk.json()).map((x: any) => x.id);
      }
    }

    const r = await db(`submissions`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        quiz_id: quizId, student_name: studentName, student_email: studentEmail,
        question_id: questionId, answer, image_ids: validIds,
      }),
    });
    if (!r.ok) return json({ error: "Could not save answer" }, 500);
    return json({ ok: true }, 200);
  }

  if (action === "uploadImage") {
    const { quizId, studentName, studentEmail, questionId, imageBase64, mimeType } = p;
    if (!quizId || !studentName || !studentEmail || !questionId || typeof imageBase64 !== "string") {
      return json({ error: "Missing fields" }, 400);
    }
    const allowed = ["image/webp", "image/jpeg", "image/png"];
    if (!allowed.includes(mimeType)) return json({ error: "Tipo de imagem inválido" }, 400);

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
    } catch {
      return json({ error: "Imagem inválida" }, 400);
    }
    if (bytes.length > 1_500_000) return json({ error: "Imagem muito grande" }, 413);

    const quiz = await getQuiz(quizId);
    if (!quiz) return json({ error: "Quiz not found" }, 404);
    const acc = await acceptSubmission(quiz, questionId, studentEmail);
    if (!acc.open) return json({ error: "closed", scope: acc.scope, message: acc.message }, 423);

    // throttle image uploads per student, and cap per question
    const bucket = `img:${quizId}:${studentEmail.toLowerCase()}`;
    if (await rateCount(bucket, 300) >= 40) {
      return json({ error: "Muitas imagens em pouco tempo. Aguarde um momento." }, 429);
    }
    await rateHit(bucket);
    if (await imageCount(quizId, questionId, studentEmail) >= 30) {
      return json({ error: "Limite de imagens por questão atingido." }, 429);
    }

    const ext = mimeType === "image/webp" ? "webp" : (mimeType === "image/png" ? "png" : "jpg");
    const emailSan = studentEmail.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const path = `${quizId}/${questionId}/${emailSan}/${crypto.randomUUID()}.${ext}`;

    const up = await storage(`object/${BUCKET}/${path}`, {
      method: "POST", headers: { "Content-Type": mimeType }, body: bytes,
    });
    if (!up.ok) return json({ error: "Falha ao enviar imagem" }, 500);

    const r = await db(`answer_images`, {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        quiz_id: quizId, question_id: questionId, student_name: studentName,
        student_email: studentEmail, path,
      }),
    });
    if (!r.ok) return json({ error: "Falha ao registrar imagem" }, 500);
    const rows = await r.json();
    return json({ ok: true, id: rows[0]?.id }, 200);
  }

  return json({ error: "Unknown action" }, 400);
});
