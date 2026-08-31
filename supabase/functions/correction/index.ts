// ============================================================
//  Edge Function: correction backend (single endpoint, routes on `action`)
//
//  Reviewing handwritten answers: the local pipeline transcribes and grades
//  the scans offline, pushes the result here, and this function serves the
//  review queue to correcao.html and records every human decision.
//
//  ALL actions are staff-only (Google session + `staff` allowlist), because
//  every one of them touches student work. Deploy with "Verify JWT" OFF, like
//  the quiz function: the gate is the allowlist check below, not the platform's
//  JWT check (which would also break the CORS preflight).
//    { action:"whoami" }
//    { action:"listRuns" }
//    { action:"saveRun",        runId, title, scaleTotal?, archived? }   [teacher]
//    { action:"importFromQuiz", runId, title, quizId }                   [teacher]
//    { action:"getRubric",      runId }
//    { action:"saveRubric",     runId, questionId, question?, criteria } [teacher]
//    { action:"proposeRubric",  runId, questionId }                      [teacher]
//    { action:"queue",          runId, questionId, order? }
//    { action:"commit",         itemId, score, justification, criteria, kind }
//    { action:"regrade",        itemId, transcription? }
//    { action:"exportRows",     runId }
//
//  THE ONE RULE THAT SHAPES EVERYTHING: the grading model never emits a score.
//  It reports which barème criteria an answer satisfies; points live in the
//  database. Re-weighting the barème is therefore arithmetic, not inference —
//  instant, free, and applied to every answer still pending. Answers a human
//  has already decided keep their committed score forever.
//
//  Secrets (Edge Functions -> Secrets): GEMINI_API_KEY (optional GEMINI_MODEL).
//  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "answers"; // same private bucket the quiz platform uses

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

function storage(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPA_URL}/storage/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, ...(init.headers || {}) },
  });
}

const enc = encodeURIComponent;
async function rows(path: string): Promise<any[]> {
  const res = await db(path);
  if (!res.ok) return [];
  return (await res.json().catch(() => [])) as any[];
}

// ---------- staff auth (identical model to the quiz function) ----------
async function verifiedEmail(req: Request): Promise<string | null> {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${m[1]}` },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return ((u?.email || "").toLowerCase().trim()) || null;
}

async function authStaff(
  req: Request,
): Promise<{ email: string; role: string } | { denied: true } | null> {
  const email = await verifiedEmail(req);
  if (!email) return null;
  const r = await rows(`staff?email=eq.${enc(email)}&select=role`);
  const role = r[0]?.role ?? null;
  return role ? { email, role } : { denied: true };
}

// Teachers may change state (barème, imports); monitors may grade and read.
const TEACHER_ACTIONS = new Set(["saveRun", "importFromQuiz", "saveRubric", "proposeRubric"]);

// ---------- rate limiting (same DB-backed scheme as the quiz function) ----------
// This endpoint runs with "Verify JWT" off, so it is publicly reachable and does
// its own auth. Only FAILED auth counts toward the lockout: a grader clicking
// through 160 answers must never be throttled.
const ADMIN_MAX_FAILS = 8;
const ADMIN_WINDOW_SEC = 600;

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

async function rateCount(bucket: string, windowSec: number): Promise<number> {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const res = await db(
    `rate_limit?bucket=eq.${enc(bucket)}&created_at=gte.${enc(since)}&select=id`,
    { headers: { Prefer: "count=exact", Range: "0-0" } },
  );
  return parseInt(res.headers.get("content-range")?.split("/")[1] ?? "0", 10) || 0;
}

async function rateHit(bucket: string): Promise<void> {
  await db(`rate_limit`, {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ bucket }),
  });
  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
  await db(`rate_limit?bucket=eq.${enc(bucket)}&created_at=lt.${enc(cutoff)}`,
           { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

// ---------- pricing: verdicts x points -> a score ----------
// The single place a score is ever computed. `verdicts` is what the model (or
// the reviewer) said about each criterion; `defs` is the current barème.
function priceProposal(verdicts: any, defs: any[]): { score: number; max: number; breakdown: any[] } {
  let score = 0, max = 0;
  const breakdown: any[] = [];
  for (const d of defs) {
    const pts = Number(d.points) || 0;
    max += pts;
    const v = verdicts?.[d.key];
    const met = v?.met === true;
    if (met) score += pts;
    breakdown.push({ key: d.key, label: d.label, points: pts, met, note: v?.note || "" });
  }
  return { score: Math.round(score * 100) / 100, max: Math.round(max * 100) / 100, breakdown };
}

// ---------- Gemini (interactive re-grading only; the bulk pass runs locally) ----------
async function gemini(prompt: string, schema: any): Promise<any | { error: string; detail?: string }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { error: "GEMINI_API_KEY não configurada" };
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2, maxOutputTokens: 4096,
          responseMimeType: "application/json", responseSchema: schema,
        },
      }),
    },
  );
  if (!res.ok) return { error: "Falha no LLM", detail: (await res.text()).slice(0, 300) };
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
  try { return JSON.parse(text); } catch { return { error: "Resposta do LLM ilegível" }; }
}

// Shared preamble: the grading contract. Kept identical to the local pipeline's
// prompt (pipeline/prompts.py) so a re-grade never disagrees with the batch
// pass for reasons of wording.
function gradingPrompt(q: any, defs: any[], answer: string): string {
  return [
    "Você corrige provas de DCC638 (Introdução à Lógica Computacional), em português.",
    "Avalie a resposta de UM aluno segundo os critérios abaixo.",
    "",
    "REGRAS:",
    "- Você NÃO atribui nota. Diga apenas, para cada critério, se ele foi satisfeito.",
    "- Dê crédito pelo que a resposta CONSEGUE, não por ela coincidir com a resposta de referência.",
    "  Caminhos alternativos válidos valem integralmente.",
    "- PRIMEIRO, liste em `itens_respondidos` quais itens (a, b, c) a folha de fato aborda:",
    "  um item entra na lista se houver qualquer tentativa dele, mesmo errada.",
    "- Critérios de um item que NÃO está nessa lista são automaticamente NÃO satisfeitos —",
    "  a folha não traz evidência deles. Não presuma que o aluno respondeu noutro lugar.",
    "- Para os itens QUE ESTÃO na lista, avalie cada critério conferindo linha a linha, e",
    "  cite em `note` o trecho exato que comprova quando marcar satisfeito. Se o aluno",
    "  escreveu o nome de uma lei ao lado dos passos, o critério das leis ESTÁ satisfeito.",
    "- A transcrição vem de reconhecimento automático de manuscrito e ERRA com frequência.",
    "  Quando um trecho parecer erro de LEITURA e não erro do aluno, corrija-o mentalmente e",
    "  avalie a resposta como se estivesse transcrita certa — dê o benefício da dúvida ao aluno.",
    "  É muito mais provável que a máquina tenha lido errado do que o aluno ter escrito um",
    "  símbolo absurdo.",
    "  Sinais típicos: um símbolo que quebra uma cadeia coerente; uma variável que troca de",
    "  nome no meio da linha (x lido como n); ∧ e ∨, → e ←, p e q invertidos; parênteses perdidos.",
    "  LIMITE: isto vale para trechos ILEGÍVEIS ou implausíveis, não para respostas coerentes e",
    "  simplesmente erradas. Se a resposta faz sentido do começo ao fim e está errada, é erro",
    "  do ALUNO — não a conserte.",
    "  Sempre que aplicar essa correção, comece a justificativa com \"[transcrição]\" e diga o",
    "  que assumiu, para o corretor conferir o manuscrito.",
    "- Na justificativa (2 a 3 frases, português): diga o que está certo, aponte o erro exato",
    "  e ONDE ele está, para o corretor localizar sem reler tudo.",
    "- Símbolos matemáticos em LaTeX entre cifrões, como no enunciado.",
    "",
    `ENUNCIADO:\n${q.prompt || "(sem enunciado)"}`,
    q.reference ? `\nRESPOSTA DE REFERÊNCIA:\n${q.reference}` : "",
    q.guidance ? `\nORIENTAÇÕES DO PROFESSOR:\n${q.guidance}` : "",
    "\nCRITÉRIOS:",
    ...defs.map((d) => `- ${d.key}: ${d.label}${d.detail ? " — " + d.detail : ""}`),
    `\nRESPOSTA DO ALUNO (transcrita):\n${answer || "(em branco)"}`,
  ].filter(Boolean).join("\n");
}

function gradingSchema(defs: any[]) {
  const props: any = {};
  for (const d of defs) {
    props[d.key] = {
      type: "object",
      properties: { met: { type: "boolean" }, note: { type: "string" } },
      required: ["met"],
    };
  }
  return {
    type: "object",
    properties: {
      itens_respondidos: { type: "array", items: { type: "string" } },
      criteria: { type: "object", properties: props, required: defs.map((d) => d.key) },
      justification: { type: "string" },
    },
    required: ["criteria", "justification"],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let p: Record<string, any>;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = p.action;

  const ip = clientIp(req);
  if (await rateCount(`corr:${ip}`, ADMIN_WINDOW_SEC) >= ADMIN_MAX_FAILS) {
    return json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, 429);
  }
  const who = await authStaff(req);
  if (!who) {
    await rateHit(`corr:${ip}`);   // only failed auth counts toward the lockout
    return json({ error: "unauthenticated", message: "Faça login com a sua conta Google." }, 403);
  }
  if ("denied" in who) return json({ error: "sem_acesso", message: "Este e-mail não tem acesso." }, 403);
  if (TEACHER_ACTIONS.has(action) && who.role !== "teacher") {
    return json({ error: "forbidden", message: "Ação restrita a docentes." }, 403);
  }

  if (action === "whoami") return json({ ok: true, email: who.email, role: who.role }, 200);

  // ---------------- runs ----------------
  if (action === "listRuns") {
    const rs = await rows(
      `correction_runs?select=id,title,source,scale_total,archived,created_at&order=created_at.desc` +
      (p.includeArchived === true ? "" : "&archived=eq.false"),
    );
    return json({ ok: true, runs: rs }, 200);
  }

  if (action === "saveRun") {
    const runId = String(p.runId || "");
    if (!/^[a-z0-9-]{1,60}$/.test(runId)) {
      return json({ error: "ID inválido (letras minúsculas, números e hífens)" }, 400);
    }
    if (!p.title) return json({ error: "Título obrigatório" }, 400);
    const body: any = { id: runId, title: p.title, created_by: who.email };
    if (p.scaleTotal !== undefined) body.scale_total = p.scaleTotal;
    if (p.archived !== undefined) body.archived = p.archived === true;
    const res = await db(`correction_runs?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return json({ error: "Falha ao salvar", detail: (await res.text()).slice(0, 200) }, 500);
    return json({ ok: true }, 200);
  }

  // ---------------- the one bridge to the quiz platform ----------------
  // Everything else in this file is quiz-agnostic. Replacing this action is
  // all it takes to feed the correction app from somewhere else (e.g. a
  // folder of scanned exams pushed by the local pipeline).
  if (action === "importFromQuiz") {
    const runId = String(p.runId || ""), quizId = String(p.quizId || "");
    if (!/^[a-z0-9-]{1,60}$/.test(runId)) return json({ error: "ID de correção inválido" }, 400);
    if (!quizId) return json({ error: "quizId obrigatório" }, 400);

    const quiz = (await rows(`quizzes?id=eq.${enc(quizId)}&select=*`))[0];
    if (!quiz) return json({ error: "Quiz não encontrado" }, 404);

    await db(`correction_runs?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: runId, title: p.title || quiz.title, source: quizId, created_by: who.email,
      }),
    });

    // questions (keep any barème already written for this run)
    const qs = (quiz.questions || []).map((q: any, i: number) => ({
      run_id: runId, question_id: q.id, prompt: q.prompt || "", position: i,
    }));
    if (qs.length) {
      await db(`correction_questions?on_conflict=run_id,question_id`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(qs),
      });
    }

    // last submission per (student, question) wins — same rule as the export
    const subs = await rows(
      `submissions?quiz_id=eq.${enc(quizId)}` +
      `&select=student_name,student_email,question_id,answer,image_ids,created_at&order=created_at`,
    );
    const imgs = await rows(`answer_images?quiz_id=eq.${enc(quizId)}&select=id,path`);
    const pathById: Record<string, string> = {};
    for (const r of imgs) pathById[String(r.id)] = r.path;

    const latest: Record<string, any> = {};
    for (const s of subs) {
      const key = (s.student_email || s.student_name || "anon").toLowerCase().trim();
      latest[`${key}::${s.question_id}`] = { ...s, key };
    }
    const items = Object.values(latest).map((s: any) => ({
      run_id: runId,
      question_id: s.question_id,
      student_key: s.key,
      student_name: s.student_name || "",
      student_email: s.student_email || "",
      typed_answer: s.answer || "",
      image_paths: (s.image_ids || []).map((id: any) => pathById[String(id)]).filter(Boolean),
    }));
    if (items.length) {
      const res = await db(`correction_items?on_conflict=run_id,question_id,student_key`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(items),
      });
      if (!res.ok) return json({ error: "Falha ao importar", detail: (await res.text()).slice(0, 200) }, 500);
    }
    return json({ ok: true, questions: qs.length, items: items.length }, 200);
  }

  // ---------------- barème ----------------
  if (action === "getRubric") {
    const runId = String(p.runId || "");
    const qs = await rows(
      `correction_questions?run_id=eq.${enc(runId)}&select=*&order=position`,
    );
    const cs = await rows(
      `correction_criteria?run_id=eq.${enc(runId)}&active=eq.true&select=*&order=question_id,position`,
    );
    const byQ: Record<string, any[]> = {};
    for (const c of cs) (byQ[c.question_id] ??= []).push(c);
    return json({
      ok: true,
      questions: qs.map((q: any) => ({
        ...q,
        criteria: byQ[q.question_id] || [],
        max: (byQ[q.question_id] || []).reduce((a: number, c: any) => a + (Number(c.points) || 0), 0),
      })),
    }, 200);
  }

  if (action === "saveRubric") {
    const runId = String(p.runId || ""), qid = String(p.questionId || "");
    if (!runId || !qid) return json({ error: "runId e questionId obrigatórios" }, 400);

    if (p.question) {
      await db(`correction_questions?on_conflict=run_id,question_id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          run_id: runId, question_id: qid,
          prompt: p.question.prompt ?? "", reference: p.question.reference ?? "",
          guidance: p.question.guidance ?? "", position: p.question.position ?? 0,
        }),
      });
    }

    if (Array.isArray(p.criteria)) {
      for (const c of p.criteria) {
        if (!c || typeof c.key !== "string" || !/^[a-z0-9_]{1,60}$/.test(c.key)) {
          return json({ error: `Chave de critério inválida: ${c?.key}` }, 400);
        }
      }
      // Criteria are never deleted, only deactivated — an old proposal must
      // still be readable against the barème it was judged under.
      const keep = new Set(p.criteria.map((c: any) => c.key));
      const existing = await rows(
        `correction_criteria?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}&select=key,active`,
      );
      for (const e of existing) {
        if (!keep.has(e.key) && e.active) {
          await db(
            `correction_criteria?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}&key=eq.${enc(e.key)}`,
            { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }) },
          );
        }
      }
      const payload = p.criteria.map((c: any, i: number) => ({
        run_id: runId, question_id: qid, key: c.key,
        label: c.label || c.key, detail: c.detail || "",
        points: Number(c.points) || 0, position: i, active: true,
      }));
      if (payload.length) {
        const res = await db(`correction_criteria?on_conflict=run_id,question_id,key`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return json({ error: "Falha ao salvar critérios", detail: (await res.text()).slice(0, 200) }, 500);
      }
    }
    return json({ ok: true }, 200);
  }

  // Draft a barème from the question plus a sample of real answers. The teacher
  // edits it afterwards; this only saves the blank-page problem.
  if (action === "proposeRubric") {
    const runId = String(p.runId || ""), qid = String(p.questionId || "");
    const q = (await rows(
      `correction_questions?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}&select=*`,
    ))[0];
    if (!q) return json({ error: "Questão não encontrada" }, 404);

    const its = await rows(
      `correction_items?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}` +
      `&select=transcription,typed_answer&limit=60`,
    );
    const samples = its
      .map((i: any) => (i.transcription || i.typed_answer || "").replace(/\s+/g, " ").slice(0, 500))
      .filter((s: string) => s.length > 2).slice(0, 40);

    const total = Number(p.totalPoints) || 6;
    const prompt = [
      "Você monta o barema de uma questão de DCC638 (Introdução à Lógica Computacional), em português.",
      `A questão vale ${total} pontos no total.`,
      "",
      "Proponha de 3 a 6 critérios de correção, tais que:",
      "- a soma dos pontos seja exatamente o total da questão;",
      "- cada critério seja verificável objetivamente por quem lê a resposta;",
      "- os critérios distingam os ERROS QUE OS ALUNOS REALMENTE COMETERAM (veja as respostas abaixo);",
      "- itens mais difíceis da questão valham mais;",
      "- pontos em múltiplos de 0,5.",
      "Para cada critério dê: `key` (slug minúsculo com _), `label` (curto), `detail` (o que exatamente",
      "o aluno precisa fazer para ganhar o ponto) e `points`.",
      "",
      `ENUNCIADO:\n${q.prompt}`,
      q.reference ? `\nRESPOSTA DE REFERÊNCIA:\n${q.reference}` : "",
      samples.length ? `\nAMOSTRA DE RESPOSTAS DOS ALUNOS:\n${samples.map((s) => "- " + s).join("\n")}` : "",
    ].filter(Boolean).join("\n");

    const out = await gemini(prompt, {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" }, label: { type: "string" },
              detail: { type: "string" }, points: { type: "number" },
            },
            required: ["key", "label", "detail", "points"],
          },
        },
      },
      required: ["criteria"],
    });
    if (out?.error) return json(out, 502);
    const criteria = (out.criteria || []).map((c: any) => ({
      key: String(c.key || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60),
      label: c.label || "", detail: c.detail || "", points: Number(c.points) || 0,
    })).filter((c: any) => c.key);
    return json({ ok: true, criteria }, 200);
  }

  // ---------------- the review queue ----------------
  if (action === "queue") {
    const runId = String(p.runId || ""), qid = String(p.questionId || "");
    if (!runId || !qid) return json({ error: "runId e questionId obrigatórios" }, 400);

    const q = (await rows(
      `correction_questions?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}&select=*`,
    ))[0] || { prompt: "", reference: "", guidance: "" };
    const defs = await rows(
      `correction_criteria?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}&active=eq.true&select=*&order=position`,
    );
    const items = await rows(
      `correction_items?run_id=eq.${enc(runId)}&question_id=eq.${enc(qid)}&select=*&order=cluster_key,student_name`,
    );
    if (!items.length) return json({ ok: true, question: q, criteria: defs, items: [] }, 200);

    // latest proposal and latest human decision per item, reduced in memory
    const base = `correction_items!inner(run_id,question_id)&correction_items.run_id=eq.${enc(runId)}` +
                 `&correction_items.question_id=eq.${enc(qid)}&order=created_at.asc`;
    const props = await rows(
      `correction_proposals?select=item_id,criteria,justification,model,source,created_at,${base}`,
    );
    const evs = await rows(
      `correction_events?select=item_id,kind,score,justification,criteria,actor_email,created_at,${base}`,
    );
    const lastProp: Record<string, any> = {};
    for (const r of props) lastProp[r.item_id] = r;
    const lastEv: Record<string, any> = {};
    for (const r of evs) if (r.kind === "accept" || r.kind === "override") lastEv[r.item_id] = r;

    // sign every scan in one batch call (15 min), like the quiz export does
    const allPaths = items.flatMap((i: any) => i.image_paths || []);
    const byPath: Record<string, string> = {};
    if (allPaths.length) {
      const sign = await storage(`object/sign/${BUCKET}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 900, paths: allPaths }),
      });
      if (sign.ok) {
        for (const s of await sign.json()) {
          const u = s.signedURL || s.signedUrl;
          if (u) byPath[s.path] = `${SUPA_URL}/storage/v1${u}`;
        }
      }
    }

    let out = items.map((i: any) => {
      const prop = lastProp[i.id] || null;
      const ev = lastEv[i.id] || null;
      const priced = priceProposal(prop?.criteria || {}, defs);
      return {
        id: i.id,
        studentKey: i.student_key, studentName: i.student_name, studentEmail: i.student_email,
        images: (i.image_paths || []).map((path: string) => byPath[path]).filter(Boolean),
        typedAnswer: i.typed_answer, transcription: i.transcription,
        transcriptionEdited: i.transcription_edited, clusterKey: i.cluster_key,
        // proposal: re-priced against the CURRENT barème on every load
        proposal: prop
          ? { criteria: prop.criteria, justification: prop.justification, model: prop.model,
              source: prop.source, score: priced.score, breakdown: priced.breakdown }
          : null,
        max: priced.max,
        // decision: frozen exactly as the human left it
        decision: ev
          ? { score: Number(ev.score), justification: ev.justification, criteria: ev.criteria,
              kind: ev.kind, by: ev.actor_email, at: ev.created_at }
          : null,
      };
    });

    // "spread": show a range of quality first, so the barème can be set with
    // real answers in view before committing to point values.
    if (p.order === "spread") {
      const pending = out.filter((r) => !r.decision);
      const done = out.filter((r) => r.decision);
      pending.sort((a, b) => (b.proposal?.score ?? -1) - (a.proposal?.score ?? -1));
      const woven: any[] = [];
      let lo = 0, hi = pending.length - 1;
      while (lo <= hi) { woven.push(pending[lo++]); if (lo <= hi) woven.push(pending[hi--]); }
      out = [...woven, ...done];
    }
    return json({ ok: true, question: q, criteria: defs, items: out }, 200);
  }

  // ---------------- decisions (append-only) ----------------
  if (action === "commit") {
    const itemId = Number(p.itemId);
    if (!Number.isFinite(itemId)) return json({ error: "itemId inválido" }, 400);
    const kind = ["accept", "override", "reopen"].includes(p.kind) ? p.kind : "override";
    if (kind !== "reopen" && !Number.isFinite(Number(p.score))) {
      return json({ error: "score obrigatório" }, 400);
    }
    const item = (await rows(`correction_items?id=eq.${itemId}&select=run_id,question_id`))[0];
    if (!item) return json({ error: "Resposta não encontrada" }, 404);
    const defs = await rows(
      `correction_criteria?run_id=eq.${enc(item.run_id)}&question_id=eq.${enc(item.question_id)}` +
      `&active=eq.true&select=key,points`,
    );
    const rubric: Record<string, number> = {};
    for (const d of defs) rubric[d.key] = Number(d.points) || 0;

    const res = await db(`correction_events`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        item_id: itemId, kind,
        score: kind === "reopen" ? null : Number(p.score),
        justification: String(p.justification || "").slice(0, 4000),
        criteria: p.criteria || {},
        rubric,                       // the barème as it stood at this moment
        actor_email: who.email, actor_role: who.role,
      }),
    });
    if (!res.ok) return json({ error: "Falha ao registrar", detail: (await res.text()).slice(0, 200) }, 500);
    return json({ ok: true }, 200);
  }

  // Fix a transcription and/or ask for a fresh proposal for one answer.
  if (action === "regrade") {
    const itemId = Number(p.itemId);
    if (!Number.isFinite(itemId)) return json({ error: "itemId inválido" }, 400);
    const item = (await rows(`correction_items?id=eq.${itemId}&select=*`))[0];
    if (!item) return json({ error: "Resposta não encontrada" }, 404);

    let answer = item.transcription || item.typed_answer || "";
    if (typeof p.transcription === "string" && p.transcription !== item.transcription) {
      answer = p.transcription;
      await db(`correction_items?id=eq.${itemId}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ transcription: answer, transcription_edited: true }),
      });
      await db(`correction_events`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          item_id: itemId, kind: "transcription", justification: "transcrição corrigida",
          actor_email: who.email, actor_role: who.role,
        }),
      });
    }

    const q = (await rows(
      `correction_questions?run_id=eq.${enc(item.run_id)}&question_id=eq.${enc(item.question_id)}&select=*`,
    ))[0] || {};
    const defs = await rows(
      `correction_criteria?run_id=eq.${enc(item.run_id)}&question_id=eq.${enc(item.question_id)}` +
      `&active=eq.true&select=*&order=position`,
    );
    if (!defs.length) return json({ error: "Defina o barema desta questão primeiro" }, 400);

    const out = await gemini(gradingPrompt(q, defs, answer), gradingSchema(defs));
    if (out?.error) return json(out, 502);

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
    await db(`correction_proposals`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        item_id: itemId, criteria: out.criteria || {},
        justification: out.justification || "", model, source: "regrade",
      }),
    });
    const priced = priceProposal(out.criteria || {}, defs);
    return json({
      ok: true, transcription: answer,
      proposal: { criteria: out.criteria, justification: out.justification, model,
                  source: "regrade", score: priced.score, breakdown: priced.breakdown },
      max: priced.max,
    }, 200);
  }

  // ---------------- export ----------------
  if (action === "exportRows") {
    const runId = String(p.runId || "");
    const cur = await rows(
      `correction_current?run_id=eq.${enc(runId)}&select=*&order=student_name,question_id`,
    );
    const run = (await rows(`correction_runs?id=eq.${enc(runId)}&select=*`))[0] || {};
    const qs = await rows(`correction_questions?run_id=eq.${enc(runId)}&select=question_id&order=position`);
    return json({
      ok: true, run, questions: qs.map((q: any) => q.question_id), rows: cur,
    }, 200);
  }

  return json({ error: "Ação desconhecida" }, 400);
});
