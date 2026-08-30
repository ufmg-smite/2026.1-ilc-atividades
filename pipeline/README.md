# Pipeline local de correção

A metade offline do app de correção. Prepara os scans, transcreve o manuscrito e
propõe uma avaliação — tudo na sua máquina. Só o **texto** resultante (transcrição,
critérios satisfeitos, justificativa) e a imagem já tratada vão para o Supabase,
onde `correcao.html` mostra a fila de correção.

**Nenhuma imagem de aluno sai desta máquina.** Essa é a razão de o lote pesado
rodar local: a linha que já existe na plataforma — *"apenas respostas anônimas
são enviadas, nomes e e-mails não saem do backend"* — vale aqui também, e agora
vale também para o manuscrito.

## Hardware

Medido nesta máquina: **uma** RTX 4070 Laptop com 8 GB de VRAM — dos quais o
ollama reporta **6,9 GiB realmente disponíveis** — e o WSL enxergando **7,6 GB**
de RAM com o swap praticamente cheio. Esse 6,9 é o número que manda:

| modelo | tamanho | cabe? |
|---|---|---|
| `qwen3-vl:4b` | 3,3 GB | sim, com folga para os tokens de imagem |
| `qwen3-vl:8b` | 6,1 GB | sobra ~0,8 GB — estoura o cache e cai para a CPU |
| `qwen3:8b` (texto) | 5,2 GB | sim, ~1,7 GB de folga |

Por isso a transcrição usa o **4b** e não o 8b: um modelo que não cabe não é
mais preciso, é só mais lento. Vale medir os dois numa amostra antes de decidir.

Se o Windows tiver mais RAM, vale aumentar o teto do WSL em `.wslconfig` — não é
obrigatório, mas o swap cheio deixa tudo mais lento.

As duas passagens são **comandos separados de propósito**: você não segura um
modelo de visão e um de raciocínio ao mesmo tempo em 8 GB, e não precisa.
Transcreve tudo, descarrega, avalia tudo — cada passagem fica com a placa
inteira, e por isso a avaliação pode usar um modelo de texto mais forte do que
um VLM do mesmo tamanho seria.

## Instalação

O ollama já está instalado nesta máquina, **em `~/.local`, sem sudo** (o script
oficial `curl | sh` precisa de root para escrever em `/usr/local`). Para repetir
noutra máquina:

```bash
curl -L -o ollama.tar.zst https://ollama.com/download/ollama-linux-amd64.tar.zst
tar --zstd -xf ollama.tar.zst -C ~/.local        # cria ~/.local/bin e ~/.local/lib
```

Ele roda como **serviço de usuário** do systemd (`~/.config/systemd/user/ollama.service`),
que também não precisa de root:

```bash
systemctl --user enable --now ollama      # iniciar
systemctl --user status ollama            # conferir
journalctl --user -u ollama -f            # logs
```

O serviço traz quatro ajustes que existem por causa dos 6,9 GiB:

| variável | por quê |
|---|---|
| `OLLAMA_MAX_LOADED_MODELS=1` | força descarregar o modelo de visão antes de carregar o de texto — é exatamente a divisão transcrever-depois-avaliar |
| `OLLAMA_CONTEXT_LENGTH=8192` | o padrão (4096) trunca: uma página são ~2k tokens de imagem e o prompt de correção chega a ~2,5k |
| `OLLAMA_KV_CACHE_TYPE=q8_0` | corta o cache pela metade, que é o que de fato estoura |
| `OLLAMA_FLASH_ATTENTION=1` | menos memória de atenção |

Modelos:

```bash
ollama pull qwen3-vl:4b && ollama pull qwen3:8b
```

Se o seu servidor não estiver em `http://localhost:11434/v1` (por exemplo
`llama-server`, que usa a porta 8080), aponte com `PIPELINE_API_BASE`.

Dependências Python (já presentes neste ambiente): `pillow`, `numpy`, `requests`.

## Credenciais

Só o passo `push` fala com o Supabase. Crie `pipeline/.env` (já está no
`.gitignore`):

```
SUPABASE_URL="https://SEU-PROJETO.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role..."
```

Essa chave ignora RLS: ela fica na sua máquina e nunca no repositório.

## Uso

```bash
# 1. importar (de uma pasta do export.py, ou direto de um quiz do Supabase)
python3 run.py import-dir ../dados/exports/dcc638-atividade3_export --run dcc638-atv3
python3 run.py import-quiz dcc638-logica --run dcc638-atv3     # alternativa

# 2. endireitar, achatar a iluminação, tirar o sombreado dos scans
python3 run.py preprocess --run dcc638-atv3

# 3. transcrever o manuscrito (modelo de visão)
python3 run.py transcribe --run dcc638-atv3 --model qwen3-vl:4b

# 4. agrupar respostas idênticas
python3 run.py cluster --run dcc638-atv3

# 5. defina o barema em correcao.html (tecla b) — ou rode
#    supabase/correction_seed_atv3.sql — e então avalie (modelo de texto)
python3 run.py grade --run dcc638-atv3 --model qwen3:8b

# 6. enviar transcrições, propostas e imagens tratadas
python3 run.py push --run dcc638-atv3

python3 run.py status --run dcc638-atv3        # quanto falta, por questão
```

Todo comando aceita `--question q1` para trabalhar uma questão de cada vez.

## Retomada

Cada passagem grava em `dados/pipeline/<run>/work.db` e **pula o que já terminou**. Um
travamento, um reboot ou uma troca de modelo custam apenas o item em andamento —
basta rodar o mesmo comando de novo. É o que torna seguro deixar o lote rodando
de madrugada.

## O que fica onde

| Caminho | Conteúdo |
|---|---|
| `dados/pipeline/<run>/raw/` | imagens baixadas do Supabase (só no `import-quiz`) |
| `dados/pipeline/<run>/prepared/` | imagens tratadas, WebP ~60 KB, o que o modelo lê |
| `dados/pipeline/<run>/work.db` | SQLite: transcrições, critérios, o que já foi enviado |

Tudo isso é dado de aluno e mora em `dados/`, ignorada por inteiro pelo git —
junto com `dados/exports/` (respostas do Supabase) e `dados/correcoes/`
(gabaritos). Uma pasta, uma regra.

## Pré-processamento

A ordem importa: primeiro achatar a iluminação (dividindo pela versão borrada,
o que mata a sombra da estante e quase todo o vazamento da página de trás),
depois endireitar sobre a tinta já limpa, depois esticar o contraste, e só então
reduzir para 1600 px. Esticar o contraste antes de achatar amplificaria a sombra.

### Rotação é manual, e isso é de propósito

Um VLM pequeno **não** sabe dizer que a página está de cabeça para baixo. Ele
responde `orientation: 0` e transcreve os glifos girados ao pé da letra — um `p`
invertido vira `d`, um `q` vira `b` — produzindo uma resposta errada de aparência
plausível, e não um erro visível. Medido nesta base: girada, a mesma foto sai em
2,7 s e correta; sem girar, sai em 4 s e sem sentido, com `legible: true`.

Por isso não há detecção automática. Para as fotos antigas, marque as poucas
tortas à mão:

```bash
python3 run.py rotate --run dcc638-atv3 --image q1__ana-luiza__1 --degrees 180
```

Isso grava em `dados/pipeline/<run>/rotations.json`, re-prepara a imagem e marca o item
para nova transcrição. Com scans de mesa esse arquivo fica vazio.

A rede de segurança real é a tela de correção: transcrição e imagem lado a lado,
e `t` corrige. Uma transcrição ruim custa uma tecla, não uma nota errada.
