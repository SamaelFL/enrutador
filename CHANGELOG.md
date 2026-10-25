# Cambios

## 0.2.0 · 2026-10-25

Medida con 6 semanas de historial real (37 sesiones, 275 turnos): **32.4% menos costo equivalente de API** ($512 → $346).

- Compacta la sesión al terminar un turno cuando el contexto pasa de 200k tokens, conservando la tarea en curso (30.0% del ahorro). Prefijo `!sigue` para no compactar al terminar ese turno; ajuste `compactarEn` (0 lo apaga).
- Corre los subagentes en Sonnet salvo los tipos de `subagentesEnOpus` (por defecto `Plan`). No reescribe la caché de la sesión (2.4%).
- El cambio de modelo en la sesión principal sigue igual: en la medición es neutro (0.0%).
- `medir/medir.ts`: repite tu historial de Claude Code y compara el costo de cada política; sin API key clasifica con `claude -p`. `--tendencias` muestra contexto, pasos y subagentes por semana.
- `/enrutador stats` muestra compactaciones y pasos de subagentes en Sonnet.
- 24 pruebas.

## 0.1.0 · 2026-10-25

Primera versión pública.

- Decide el modelo y el esfuerzo con el primer pedido de cada tarea: Sonnet para lo trivial y lo simple, Opus para lo mediano y lo complejo.
- Clasifica con Haiku (~1 s) y, ante la duda, sube un nivel. Palabras delicadas como migración, seguridad o "no funciona" nunca bajan de Opus; si el clasificador falla, Opus alto.
- Respeta la caché: con la caché caliente solo sube; tras 60 minutos sin actividad puede volver a bajar.
- Escala a medio turno con la herramienta `subir_nivel` o tras 3 errores seguidos o 5 en total.
- Prefijos `!sonnet`, `!opus` y `!max`, y el comando `/enrutador` (on, off, stats, reset).
- No toca a los subagentes ni hace nada si la sesión no está en Opus.
- 16 pruebas, que corren en cada push.
