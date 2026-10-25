import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const USO = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Mundo = {
  reloj: MockClock
  respuestas: string[]
  pasos: TurnStepInput[]
  clasificaciones: number
  textos: string[]
  avisos: string[]
}

// El mundo bajo el plugin: clasificador, sesión, reloj, almacén y modelo.
function mundo(on: On, opciones: { respuesta?: string | null; errores?: boolean } = {}): Mundo {
  const reloj = mock.clock(on, { now: 1_000_000 })
  const m: Mundo = { reloj, respuestas: [], pasos: [], clasificaciones: 0, textos: [], avisos: [] }
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    m.clasificaciones += 1
    const r = m.respuestas.shift() ?? opciones.respuesta
    if (r === null) {
      return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USO } }
    }
    return {
      value: { isAnswered: true as const, text: r ?? 'nivel: trivial\nseguro: si', usage: USO },
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    m.avisos.push(String(e.text))
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__enrutador__${e.name}` } }))
  on('prompt.submit', (_$, e) => {
    m.textos.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => (opciones.errores === true ? { isError: true, result: 'falló', text: 'falló' } : { result: 'ok', text: 'ok' }))
  on('turn.step', async function* (_$, e) {
    m.pasos.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return m
}

async function arrancar($: Engine): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

async function paso($: Engine, turnId: string, index: number, extra: Partial<TurnStepInput> = {}): Promise<void> {
  const s = $.turn.step({ turnId, index, model: OPUS, effort: 'medium', messageCount: 3, ...extra })
  for await (const _ of s) {
    // nada que leer
  }
}

async function turno($: Engine, texto: string, id: string): Promise<void> {
  await $.prompt.submit({ text: texto, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: texto, turnId: id })
  await paso($, id, 0)
}

async function cerrar($: Engine, id: string): Promise<void> {
  await $.turn.complete({ turnId: id, reason: 'answer', answer: '', durationMs: 1, isAborted: false })
}

describe('enrutador', () => {
  test('lo trivial baja a Sonnet con esfuerzo bajo', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await turno($, 'explícame qué hace git stash', 't1')
    expect(m.clasificaciones).toBe(1)
    expect(m.pasos[0]?.model).toBe(SONNET)
    expect(m.pasos[0]?.effort).toBe('low')
  })

  test('con dudas sube un nivel: simple dudoso va a Opus', async ($, on) => {
    const m = mundo(on, { respuesta: 'nivel: simple\nseguro: no' })
    await arrancar($)
    await turno($, 'agrega un campo fecha al formulario', 't1')
    expect(m.pasos[0]?.model).toBe(OPUS)
    expect(m.pasos[0]?.effort).toBe('medium')
  })

  test('palabras delicadas no dejan bajar de Opus', async ($, on) => {
    const m = mundo(on, { respuesta: 'nivel: trivial\nseguro: si' })
    await arrancar($)
    await turno($, 'revisa el deadlock de esta transacción', 't1')
    expect(m.pasos[0]?.model).toBe(OPUS)
  })

  test('si el clasificador no responde, Opus alto', async ($, on) => {
    const m = mundo(on, { respuesta: null })
    await arrancar($)
    await turno($, 'cambia el color del botón', 't1')
    expect(m.pasos[0]?.model).toBe(OPUS)
    expect(m.pasos[0]?.effort).toBe('high')
  })

  test('!sonnet fuerza Sonnet, no clasifica y quita el prefijo', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await turno($, '!sonnet arregla el typo del README', 't1')
    expect(m.clasificaciones).toBe(0)
    expect(m.textos[0]).toBe('arregla el typo del README')
    expect(m.pasos[0]?.model).toBe(SONNET)
  })

  test('!max manda Opus con esfuerzo max', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await turno($, '!max diseña el esquema de permisos', 't1')
    expect(m.pasos[0]?.model).toBe(OPUS)
    expect(m.pasos[0]?.effort).toBe('max')
  })

  test('"dale" hereda el nivel del turno anterior sin clasificar', async ($, on) => {
    const m = mundo(on, { respuesta: 'nivel: compleja\nseguro: si' })
    await arrancar($)
    await turno($, 'planea la migración de la base', 't1')
    await cerrar($, 't1')
    await turno($, 'dale', 't2')
    expect(m.clasificaciones).toBe(1)
    expect(m.pasos[1]?.model).toBe(OPUS)
    expect(m.pasos[1]?.effort).toBe('high')
  })

  test('tres errores seguidos en Sonnet escalan a Opus alto', async ($, on) => {
    const m = mundo(on, { errores: true })
    await arrancar($)
    await turno($, 'corre el linter', 't1')
    expect(m.pasos[0]?.model).toBe(SONNET)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm run lint', tool_use_id: `b${i}` })
    await paso($, 't1', 1)
    expect(m.pasos[1]?.model).toBe(OPUS)
    expect(m.pasos[1]?.effort).toBe('high')
    expect(m.avisos.length).toBe(1)
  })

  test('el modelo puede pedir Opus con subir_nivel', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await turno($, 'renombra la variable x a total', 't1')
    expect(m.pasos[0]?.model).toBe(SONNET)
    await $.tool.call({ tool: 'mcp__enrutador__subir_nivel', motivo: 'la causa no es clara', tool_use_id: 'u1' })
    await paso($, 't1', 1)
    expect(m.pasos[1]?.model).toBe(OPUS)
  })

  test('un subagente sin tipo conocido no se toca', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await turno($, 'explícame qué hace git stash', 't1')
    await paso($, 't1', 1, { agentId: 'peon-1' })
    expect(m.pasos[1]?.model).toBe(OPUS)
    expect(m.pasos[1]?.effort).toBe('medium')
  })

  test('si la sesión no está en Opus, no hace nada', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await $.prompt.submit({ text: 'explícame qué hace git stash', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'x', turnId: 't1' })
    await paso($, 't1', 0, { model: SONNET, effort: 'high' })
    expect(m.pasos[0]?.model).toBe(SONNET)
    expect(m.pasos[0]?.effort).toBe('high')
  })

  test('con la caché caliente de Opus no baja a Sonnet', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await $.turn.start({ text: '', turnId: 't0' })
    await paso($, 't0', 0)
    await cerrar($, 't0')
    await turno($, 'explícame qué hace git stash', 't1')
    expect(m.pasos[1]?.model).toBe(OPUS)
    expect(m.pasos[1]?.effort).toBe('medium')
  })

  test('/enrutador off deja todo como viene', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    const r = await $.command.run({ command: 'enrutador', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(r.text).toContain('apagado')
    await turno($, 'explícame qué hace git stash', 't1')
    expect(m.clasificaciones).toBe(0)
    expect(m.pasos[0]?.model).toBe(OPUS)
  })

  test('modo plan siempre va en Opus alto', async ($, on) => {
    const m = mundo(on)
    await arrancar($)
    await $.prompt.submit({ text: 'explícame qué hace git stash', wait: false, origin: { kind: 'composer' } })
    await $.session.append({
      door: 'attachment',
      origin: { kind: 'engine' },
      uuid: 'a1',
      message: { type: 'attachment', name: 'plan_mode', content: [] },
    })
    await $.turn.start({ text: 'x', turnId: 't1' })
    await paso($, 't1', 0)
    expect(m.pasos[0]?.model).toBe(OPUS)
    expect(m.pasos[0]?.effort).toBe('high')
  })

  test('por sesión: decide al inicio, sube cuando hace falta y ya no baja', async ($, on) => {
    const m = mundo(on)
    m.respuestas.push('nivel: trivial\nseguro: si', 'nivel: trivial\nseguro: si', 'nivel: compleja\nseguro: si')
    await arrancar($)
    await turno($, 'qué hace git stash', 't1')
    await cerrar($, 't1')
    await turno($, 'y git stash pop', 't2')
    await cerrar($, 't2')
    await turno($, 'diseña el modelo de permisos por rol', 't3')
    await cerrar($, 't3')
    await turno($, 'renombra la variable x', 't4')
    expect(m.pasos.map(p => p.model)).toEqual([SONNET, SONNET, OPUS, OPUS])
    expect(m.pasos[3]?.effort).toBe('high')
    expect(m.clasificaciones).toBe(3)
  })

  test('con la caché fría puede volver a bajar', async ($, on) => {
    const m = mundo(on)
    m.respuestas.push('nivel: compleja\nseguro: si', 'nivel: trivial\nseguro: si')
    await arrancar($)
    await turno($, 'diseña el modelo de permisos por rol', 't1')
    await cerrar($, 't1')
    await m.reloj.advance(61 * 60_000)
    await turno($, 'qué hace git stash', 't2')
    expect(m.pasos.map(p => p.model)).toEqual([OPUS, SONNET])
  })
})


// --- v0.2: compactar antes de una tarea nueva y subagentes en Sonnet ------------------

function contexto(on: On, tokens: number): { compactaciones: string[] } {
  const r = { compactaciones: [] as string[] }
  mock.session(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('session.compact', (_$, e) => {
    r.compactaciones.push(e.instructions ?? '')
    return { messages: [{ role: 'user' as const, text: 'Resumen de la conversación.', toolUses: [], toolResults: [] }], tokensBefore: tokens, tokensAfter: 20_000 }
  })
  return r
}

function agentes(on: On, lista: Array<{ id: string; type: string }>): void {
  on('agent.list', () => ({ value: lista.map(a => ({ ...a, description: '', status: 'running' as const })) }))
}

describe('enrutador v2', () => {
  test('al terminar un turno con el contexto grande, compacta', async ($, on) => {
    const m = mundo(on)
    const c = contexto(on, 250_000)
    await arrancar($)
    await turno($, 'ahora agrega la pantalla de reportes', 't1')
    expect(c.compactaciones.length).toBe(0)
    await cerrar($, 't1')
    expect(c.compactaciones.length).toBe(1)
    expect(c.compactaciones[0]).toContain('tarea en curso')
    expect(m.avisos.some(a => a.includes('compacté'))).toBe(true)
  })

  test('con el contexto chico no compacta', async ($, on) => {
    mundo(on)
    const c = contexto(on, 120_000)
    await arrancar($)
    await turno($, 'ahora agrega la pantalla de reportes', 't1')
    await cerrar($, 't1')
    expect(c.compactaciones.length).toBe(0)
  })

  test('!sigue no compacta al terminar y se quita del texto', async ($, on) => {
    const m = mundo(on)
    const c = contexto(on, 250_000)
    await arrancar($)
    await turno($, '!sigue ahora conecta eso con el reporte', 't1')
    await cerrar($, 't1')
    expect(c.compactaciones.length).toBe(0)
    expect(m.textos[0]).toBe('ahora conecta eso con el reporte')
  })

  test('!sigue vale solo para su turno', async ($, on) => {
    mundo(on)
    const c = contexto(on, 250_000)
    await arrancar($)
    await turno($, '!sigue conecta eso', 't1')
    await cerrar($, 't1')
    await turno($, 'ahora otra cosa', 't2')
    await cerrar($, 't2')
    expect(c.compactaciones.length).toBe(1)
  })

  test('/enrutador off no compacta', async ($, on) => {
    mundo(on)
    const c = contexto(on, 250_000)
    await arrancar($)
    await $.command.run({ command: 'enrutador', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    await turno($, 'ahora otra cosa', 't1')
    await cerrar($, 't1')
    expect(c.compactaciones.length).toBe(0)
  })

  test('los subagentes corren en Sonnet', async ($, on) => {
    const m = mundo(on, { respuesta: 'nivel: compleja\nseguro: si' })
    agentes(on, [{ id: 'a1', type: 'Explore' }])
    await arrancar($)
    await turno($, 'investiga cómo se calculan los totales', 't1')
    await paso($, 't1', 1, { agentId: 'a1' })
    expect(m.pasos[0]?.model).toBe(OPUS)
    expect(m.pasos[1]?.model).toBe(SONNET)
  })

  test('el subagente de planeación se queda en Opus', async ($, on) => {
    const m = mundo(on, { respuesta: 'nivel: compleja\nseguro: si' })
    agentes(on, [{ id: 'p1', type: 'Plan' }])
    await arrancar($)
    await turno($, 'planea la migración', 't1')
    await paso($, 't1', 1, { agentId: 'p1' })
    expect(m.pasos[1]?.model).toBe(OPUS)
  })

  test('una bifurcación del engine (sin tipo) no se toca', async ($, on) => {
    const m = mundo(on, { respuesta: 'nivel: compleja\nseguro: si' })
    agentes(on, [])
    await arrancar($)
    await turno($, 'investiga el módulo de pagos', 't1')
    await paso($, 't1', 1, { agentId: 'fork-1' })
    expect(m.pasos[1]?.model).toBe(OPUS)
  })
})
