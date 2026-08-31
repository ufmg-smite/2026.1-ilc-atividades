"""Prompts shared by the two local passes.

The grading prompt is kept word-for-word in sync with `gradingPrompt()` in
supabase/functions/correction/index.ts. That matters: the batch pass runs
locally and re-grades run on Gemini, and the two must not disagree merely
because they were asked different questions.
"""

# ---------------------------------------------------------------- transcription
TRANSCRIBE_SYSTEM = (
    "Você transcreve respostas manuscritas de uma prova de lógica, em português."
)

TRANSCRIBE_USER = """Transcreva EXATAMENTE o que está escrito nesta imagem.

REGRAS:
- Transcreva o que o aluno escreveu, mesmo que esteja ERRADO. Não corrija, não
  complete, não melhore, não resolva o exercício.
- Símbolos matemáticos em UNICODE (∀ ∃ ¬ ∧ ∨ → ↔ ≡ ∈ ≥ ≤ ≠), nunca LaTeX nem
  cifrões — é a mesma convenção do resto da plataforma.
- Mantenha a estrutura: itens a), b), c), uma linha por linha escrita.
- Texto riscado pelo aluno: ignore.
- Trecho ilegível: escreva [ilegível] no lugar. NUNCA repita um símbolo ou uma
  linha para preencher espaço — se não der para ler, diga que não deu.
- Se não houver resposta nenhuma, devolva transcription vazia.

Responda em JSON: {"transcription": "...", "legible": true}"""

# ---------------------------------------------------------------- grading
def grading_prompt(question, criteria, answer):
    """question: dict(prompt, reference, guidance); criteria: list of dicts."""
    parts = [
        "Você corrige provas de DCC638 (Introdução à Lógica Computacional), em português.",
        "Avalie a resposta de UM aluno segundo os critérios abaixo.",
        "",
        "REGRAS:",
        "- Você NÃO atribui nota. Diga apenas, para cada critério, se ele foi satisfeito.",
        "- Dê crédito pelo que a resposta CONSEGUE, não por ela coincidir com a resposta de referência.",
        "  Caminhos alternativos válidos valem integralmente.",
        "- PRIMEIRO, liste em `itens_respondidos` quais itens (a, b, c) a folha de fato",
        "  aborda: um item entra na lista se houver qualquer tentativa dele, mesmo errada.",
        "- Critérios de um item que NÃO está nessa lista são automaticamente NÃO satisfeitos",
        "  — a folha não traz evidência deles. Não presuma que o aluno respondeu noutro lugar.",
        "- Para os itens QUE ESTÃO na lista, avalie cada critério normalmente, conferindo",
        "  linha a linha, e cite em `note` o trecho exato que comprova quando marcar",
        "  satisfeito. Se o aluno escreveu o nome de uma lei ao lado dos passos, o critério",
        "  das leis ESTÁ satisfeito.",
        "- A transcrição vem de reconhecimento de manuscrito e pode conter erros de leitura.",
        "  Se algo parecer um erro de transcrição e não um erro do aluno, diga isso na justificativa.",
        "- Na justificativa (2 a 3 frases, português): diga o que está certo, aponte o erro exato",
        "  e ONDE ele está, para o corretor localizar sem reler tudo.",
        "- Símbolos matemáticos em UNICODE (∀ ∃ ¬ ∧ ∨ → ↔ ≡), nunca LaTeX nem cifrões.",
        "",
        "ENUNCIADO:\n" + (question.get("prompt") or "(sem enunciado)"),
    ]
    if question.get("reference"):
        parts.append("\nRESPOSTA DE REFERÊNCIA:\n" + question["reference"])
    if question.get("guidance"):
        parts.append("\nORIENTAÇÕES DO PROFESSOR:\n" + question["guidance"])
    parts.append("\nCRITÉRIOS:")
    for c in criteria:
        detail = (" — " + c["detail"]) if c.get("detail") else ""
        parts.append(f"- {c['key']}: {c['label']}{detail}")
    parts.append("\nRESPOSTA DO ALUNO (transcrita):\n" + (answer or "(em branco)"))
    # The shape is described rather than exemplified with values: an example
    # showing "met": true for every criterion anchors a small model into
    # passing everything, which is exactly the failure that would waste the
    # reviewer's time.
    keys = ", ".join(c["key"] for c in criteria)
    parts.append(
        "\nResponda em JSON com esta forma, uma entrada por critério, usando "
        "exatamente estas chaves: " + keys + "\n"
        '{"itens_respondidos": ["<a|b|c>"], '
        '"criteria": {"<chave>": {"met": <true ou false>, "note": "<se met=true, o '
        'trecho exato que comprova; se met=false, o que faltou>"}}, '
        '"justification": "<2 a 3 frases>"}\n'
        "Marque met=true apenas quando puder apontar o trecho que comprova o critério."
    )
    return "\n".join(parts)
