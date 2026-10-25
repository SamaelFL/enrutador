# enrutador

A model router for Claude Code. Your session stays on Opus, but easy requests go to Sonnet and the effort level adapts to each task. When in doubt, it stays on Opus.

[Español abajo](#español)

## Why

I use Claude Code all day on Opus. Most of my requests are small (a rename, a quick question, a one-file change), but each one was billed at Opus prices against my plan limits, which ran out in 4 to 5 days. With the router I finish the week at around 60% of my plan. That is my own usage, not a benchmark.

## How it decides

- **One decision per task.** The first request picks the model and effort: trivial → Sonnet · low, simple → Sonnet · medium, medium → Opus · medium, complex → Opus · high.
- **A cheap classifier.** Haiku reads only the request (and the end of the agent's last reply) and returns a level (~$0.0001, ~1 s). The request is passed as data, never as instructions.
- **Rules before the model.** Slash commands, attachments and long requests go straight to Opus. Follow-ups like "yes", "go ahead" or "continue" keep the previous level.
- **Biased toward Opus.** If the classifier is unsure, it moves one level up. Words like migration, security, deadlock, design or "doesn't work" never go below Opus. If the classifier fails, the turn goes to Opus · high. Plan mode always runs on Opus · high.
- **Cache-aware.** Switching models rewrites the prompt cache, and the base context is already ~43k tokens, so downgrading for a few steps costs more than it saves. With a warm cache the router only goes up, never down. After 60 minutes idle the cache is cold and it can go down again.
- **Escalates mid-task.** The model gets a `subir_nivel` tool to ask for more reasoning when a task turns out harder than it looked. Three errors in a row, or five in total, also escalate to Opus · high.
- **Stays out of the way.** Subagents are not touched, and if the session is not on Opus the router does nothing.

The decision logic is pure functions in `hooks/logica.ts`, tested on their own; `hooks/register.ts` wires them to Claude Code's events.

## Usage

- Prefixes: `!sonnet`, `!opus`, `!max`.
- `/enrutador` shows the status · `/enrutador on|off` · `/enrutador stats` (cache tokens per model) · `/enrutador reset`.
- The status line shows the decision, for example `⚙ Sonnet · medium · simple (clasificador)`.

## Install

Requires Claude Code 2.1.296 or newer.

```
git clone https://github.com/SamaelFL/enrutador.git
cd enrutador
claude plugin marketplace add "$PWD"
claude plugin install enrutador@enrutador
```

After editing the folder, run `/reload-plugins` inside Claude Code.

Settings: `minutosCacheFria` (minutes until the cache counts as cold, default 60) and `modeloLigero` (the cheaper model id; empty means the Opus id with `sonnet` instead of `opus`).

## Uninstall

```
claude plugin uninstall enrutador@enrutador
claude plugin marketplace remove enrutador
```

## License

MIT

---

## Español

Enrutador de modelo para Claude Code. Con la sesión en Opus, manda los pedidos fáciles a Sonnet y ajusta el esfuerzo. Ante la duda se queda en Opus.

### Por qué

Uso Claude Code todo el día en Opus. La mayoría de mis pedidos son chicos, pero todos se cobraban a precio de Opus contra los límites de mi plan, que se me acababan en 4 o 5 días. Con el enrutador cierro la semana usando alrededor del 60%. Es mi uso personal, no un benchmark.

### Cómo decide

- El primer pedido elige modelo y esfuerzo: trivial → Sonnet · low, simple → Sonnet · medium, media → Opus · medium, compleja → Opus · high.
- Clasifica con Haiku, que solo lee el pedido (~$0.0001, ~1 s).
- Con la caché caliente solo sube, nunca baja: cambiar de modelo o de esfuerzo reescribe la caché y cuesta más de lo que ahorra. Tras 60 min sin actividad puede volver a bajar.
- Ante la duda, Opus: si el clasificador no está seguro sube un nivel; palabras delicadas (migración, deadlock, seguridad, "no funciona", diseña…) no bajan de Opus; si el clasificador falla, Opus alto; el modo plan va en Opus alto.
- "dale", "sí", "continúa" heredan el nivel anterior.
- Escala a Opus alto a medio turno si el modelo llama `subir_nivel` o hay 3 errores seguidos / 5 en total.
- No toca a los subagentes. Si la sesión no está en Opus, no hace nada.

### Uso

- Prefijos: `!sonnet`, `!opus`, `!max`.
- `/enrutador` estado · `/enrutador on|off` · `/enrutador stats` (tokens de caché por modelo) · `/enrutador reset`.

### Instalar

```
git clone https://github.com/SamaelFL/enrutador.git
cd enrutador
claude plugin marketplace add "$PWD"
claude plugin install enrutador@enrutador
```

### Quitar

```
claude plugin uninstall enrutador@enrutador
claude plugin marketplace remove enrutador
```
