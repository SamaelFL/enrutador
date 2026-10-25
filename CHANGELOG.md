# Cambios

## 0.1.0 · 2026-10-25

Primera versión pública.

- Decide el modelo y el esfuerzo con el primer pedido de cada tarea: Sonnet para lo trivial y lo simple, Opus para lo mediano y lo complejo.
- Clasifica con Haiku (~1 s) y, ante la duda, sube un nivel. Palabras delicadas como migración, seguridad o "no funciona" nunca bajan de Opus; si el clasificador falla, Opus alto.
- Respeta la caché: con la caché caliente solo sube; tras 60 minutos sin actividad puede volver a bajar.
- Escala a medio turno con la herramienta `subir_nivel` o tras 3 errores seguidos o 5 en total.
- Prefijos `!sonnet`, `!opus` y `!max`, y el comando `/enrutador` (on, off, stats, reset).
- No toca a los subagentes ni hace nada si la sesión no está en Opus.
- 16 pruebas, que corren en cada push.
