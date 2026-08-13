// ============================================================
//  Edge Function: quiz backend (single endpoint, routes on `action`)
//
//  STUDENT actions (no access code — open while a quiz is open):
//    { action:"load" }                      -> the quiz currently OPEN
//    { action:"submit", quizId, studentName, studentEmail, questionId, answer }
//
//  TEACHER actions (need ADMIN_CODE):
//    { action:"listQuizzes", adminCode }
//    { action:"getQuiz",     adminCode, quizId }
//    { action:"saveQuiz",    adminCode, quizId, title, description, questions:[{id,prompt}] }
//    { action:"open",        adminCode, quizId, durationMinutes? }   // closes all others
//    { action:"close",       adminCode, quizId }
//    { action:"status",      adminCode, quizId }
//
//  Questions live in the `quizzes` table, so they can be edited from the
//  admin panel without touching the page. Each quiz is its own row, so
//  the whole semester's history is preserved. Only ONE quiz is open at a
//  time; the student page asks for "the open quiz" and needs no quiz id.
//
//  Secrets (Edge Functions -> Secrets): ADMIN_CODE, GEMINI_API_KEY (optional GEMINI_MODEL).
//  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "answers"; // private Storage bucket for photo answers
const ADMIN_ACTIONS = new Set([
  "open", "close", "status", "listQuizzes", "getQuiz", "saveQuiz", "renameQuiz",
  "setArchived", "analyze", "listImages", "purgeImages",
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

function windowState(quiz: any): { isOpen: boolean; endsAt: string | null } {
  if (!quiz.opened_at || quiz.force_closed) return { isOpen: false, endsAt: null };
  const ends = new Date(quiz.opened_at).getTime() + quiz.duration_minutes * 60000;
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

  // ================= TEACHER =================
  if (ADMIN_ACTIONS.has(action)) {
    const ip = clientIp(req);
    if (await rateCount(`admin:${ip}`, ADMIN_WINDOW_SEC) >= ADMIN_MAX_FAILS) {
      return json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, 429);
    }
    if (p.adminCode !== Deno.env.get("ADMIN_CODE")) {
      await rateHit(`admin:${ip}`); // count only failures toward the lockout
      return json({ error: "Invalid admin code" }, 403);
    }

    if (action === "listQuizzes") {
      const filter = p.includeArchived === true ? "" : "&archived=eq.false";
      const res = await db(
        `quizzes?select=id,title,opened_at,duration_minutes,force_closed,archived&order=id${filter}`,
      );
      if (!res.ok) return json({ error: "Could not list quizzes" }, 500);
      const rows = await res.json();
      const quizzes = rows.map((q: any) => {
        const w = windowState(q);
        return {
          id: q.id, title: q.title, isOpen: w.isOpen,
          openedAt: q.opened_at, endsAt: w.endsAt,
          durationMinutes: q.duration_minutes, forceClosed: q.force_closed,
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
        },
      }, 200);
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
        : 20;
      const existing = await getQuiz(quizId);
      const body = { title, description: description ?? null, questions, duration_minutes: dur };
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

    if (action === "listImages") {
      const res = await db(
        `answer_images?quiz_id=eq.${encodeURIComponent(p.quizId)}` +
        `&select=id,question_id,student_name,student_email,path,created_at&order=question_id,created_at`,
      );
      if (!res.ok) return json({ error: "Falha ao listar imagens" }, 500);
      const rows = await res.json();
      const images: any[] = [];
      for (const row of rows) {
        const s = await storage(`object/sign/${BUCKET}/${row.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiresIn: 3600 }),
        });
        let url: string | null = null;
        if (s.ok) { const d = await s.json(); url = `${SUPA_URL}/storage/v1${d.signedURL}`; }
        images.push({
          id: row.id, questionId: row.question_id, studentName: row.student_name,
          studentEmail: row.student_email, url, createdAt: row.created_at,
        });
      }
      return json({ ok: true, images }, 200);
    }

    if (action === "purgeImages") {
      const res = await db(
        `answer_images?quiz_id=eq.${encodeURIComponent(p.quizId)}&select=path`,
      );
      const rows = res.ok ? await res.json() : [];
      let deleted = 0;
      if (rows.length) {
        await storage(`object/${BUCKET}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: rows.map((r: any) => r.path) }),
        });
        await db(`answer_images?quiz_id=eq.${encodeURIComponent(p.quizId)}`, {
          method: "DELETE", headers: { Prefer: "return=minimal" },
        });
        deleted = rows.length;
      }
      return json({ ok: true, deleted }, 200);
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
      const endsAt = new Date(new Date(nowIso).getTime() + dur * 60000).toISOString();
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
    return json({
      ok: true,
      quiz: {
        id: quiz.id, title: quiz.title, description: quiz.description,
        questions: quiz.questions, endsAt: w.endsAt,
      },
    }, 200);
  }

  if (action === "submit" || action === undefined) {
    const { quizId, studentName, studentEmail, questionId, answer } = p;
    if (!quizId || !studentName || !studentEmail || !questionId || typeof answer !== "string") {
      return json({ error: "Missing fields" }, 400);
    }
    if (studentName.length > 120 || studentEmail.length > 160 || answer.length > 10000) {
      return json({ error: "Field too long" }, 400);
    }
    const quiz = await getQuiz(quizId);
    if (!quiz) return json({ error: "Quiz not found" }, 404);
    const w = windowState(quiz);
    if (!w.isOpen) return json({ error: "closed", message: "O tempo do quiz terminou." }, 423);

    // anti-spam: throttle FREQUENCY per student (email), not per IP and not a
    // total cap — so classmates sharing one campus IP never throttle each other,
    // and a student can still resubmit freely; this only blocks rapid-fire floods.
    const bucket = `sub:${quizId}:${studentEmail.toLowerCase()}`;
    if (await rateCount(bucket, SUB_WINDOW_SEC) >= SUB_MAX_PER_WINDOW) {
      return json({ error: "Você está enviando rápido demais. Aguarde alguns segundos." }, 429);
    }
    await rateHit(bucket);

    const r = await db(`submissions`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        quiz_id: quizId, student_name: studentName, student_email: studentEmail,
        question_id: questionId, answer,
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
    if (!windowState(quiz).isOpen) {
      return json({ error: "closed", message: "O tempo do quiz terminou." }, 423);
    }

    // throttle image uploads per student, and cap per question
    const bucket = `img:${quizId}:${studentEmail.toLowerCase()}`;
    if (await rateCount(bucket, 300) >= 40) {
      return json({ error: "Muitas imagens em pouco tempo. Aguarde um momento." }, 429);
    }
    await rateHit(bucket);
    if (await imageCount(quizId, questionId, studentEmail) >= 12) {
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

  if (action === "deleteImage") {
    const { id, studentEmail } = p;
    if (!id || !studentEmail) return json({ error: "Missing fields" }, 400);
    const res = await db(
      `answer_images?id=eq.${encodeURIComponent(id)}` +
      `&student_email=eq.${encodeURIComponent(studentEmail)}&select=path`,
    );
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) return json({ error: "Imagem não encontrada" }, 404);
    await storage(`object/${BUCKET}/${rows[0].path}`, { method: "DELETE" });
    await db(`answer_images?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    return json({ ok: true }, 200);
  }

  return json({ error: "Unknown action" }, 400);
});
