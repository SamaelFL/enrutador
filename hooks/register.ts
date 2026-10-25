import type { EngineInterface, Register } from 'claude-code'

import {
  DESTINO,
  aplicarDuda,
  debeEscalar,
  enElTope,
  esEsfuerzo,
  esSeguimiento,
  etiqueta,
  familiaDe,
  idLigero,
  leerForzado,
  maxEsfuerzo,
  maxNivel,
  parsearClasificador,
  pisoPorPalabras,
  porReglas,
  promptClasificador,
  retenerPorCache,
  SISTEMA_CLASIFICADOR,
} from './logica'
import type { Enviado, Esfuerzo, Familia, Nivel } from './logica'

const HERRAMIENTA = 'subir_nivel'
const HERRAMIENTA_COMPLETA = 'mcp__enrutador__subir_nivel'

type Decision = { nivel: Nivel; motivo: string; esfuerzoForzado?: Esfuerzo; forzado: boolean }

type Turno = Decision & {
  errSeguidos: number
  errTotales: number
  escalado?: string
  elegido?: { familia: Familia; esfuerzo: Esfuerzo; retenido: boolean }
}

type UsoModelo = { pasos: number; entrada: number; cacheLeido: number; cacheEscrito: number; salida: number }

type Estadisticas = {
  turnos: Record<Nivel, number>
  escalados: number
  retenidosPorCache: number
  porModelo: Record<string, UsoModelo>
}

const estadisticasVacias = (): Estadisticas => ({
  turnos: { trivial: 0, simple: 0, media: 0, compleja: 0 },
  escalados: 0,
  retenidosPorCache: 0,
  porModelo: {},
})

// Estado de la sesión. Un reload del módulo lo arranca de cero (las
// estadísticas y el on/off viven en $.store).
type Estado = {
  activo: boolean
  pendiente: Decision | null
  actual: Turno | null
  ultimoNivel: Nivel | null
  ultimoEnviado: Enviado | null
  planActivo: boolean
  stats: Estadisticas
}

const st: Estado = {
  activo: true,
  pendiente: null,
  actual: null,
  ultimoNivel: null,
  ultimoEnviado: null,
  planActivo: false,
  stats: estadisticasVacias(),
}

async function guardarStats($: EngineInterface): Promise<void> {
  try {
    await $.store.set('stats', st.stats)
  } catch {
    // las estadísticas son de cortesía
  }
}

async function clasificar($: EngineInterface, texto: string): Promise<Decision> {
  let ultimaRespuesta = ''
  try {
    const mensajes = await $.session.messages()
    if (Array.isArray(mensajes)) {
      const ultima = [...mensajes].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
      ultimaRespuesta = ultima?.text ?? ''
    }
  } catch {
    // sin historial: se clasifica el pedido solo
  }

  const r = await $.model.complete({
    model: 'haiku',
    system: SISTEMA_CLASIFICADOR,
    prompt: promptClasificador(texto, ultimaRespuesta),
    maxTokens: 1500,
    effort: 'low',
    timeoutMs: 8000,
  })
  if (!r.isAnswered) return { nivel: 'compleja', motivo: 'clasificador sin respuesta', forzado: false }

  const leido = parsearClasificador(r.text)
  if (leido === null) return { nivel: 'compleja', motivo: 'clasificador ilegible', forzado: false }

  let nivel = aplicarDuda(leido.nivel, leido.seguro)
  const piso = pisoPorPalabras(texto)
  if (piso !== null) nivel = maxNivel(nivel, piso)
  return { nivel, motivo: leido.seguro ? 'clasificador' : 'clasificador, con dudas', forzado: false }
}

function escalar($: EngineInterface, motivo: string): void {
  const t = st.actual
  if (t === null || t.escalado !== undefined) return
  t.escalado = motivo
  st.stats.escalados += 1
  $.ui.toast(`enrutador: sube a Opus · high (${motivo})`)
}

const yaEnAlto = (t: Turno): boolean =>
  t.escalado !== undefined ||
  (t.elegido !== undefined && t.elegido.familia === 'opus' && t.elegido.esfuerzo !== 'low' && t.elegido.esfuerzo !== 'medium')

export const register: Register = (on, options) => {
  const minutosFria = Number(options.minutosCacheFria ?? 60)
  const modeloLigero = String(options.modeloLigero ?? '')

  st.pendiente = null
  st.actual = null
  st.planActivo = false

  on('session.start', async ($, e, next) => {
    st.activo = (await $.store.get('activo')) !== false
    const guardadas = await $.store.get('stats')
    if (typeof guardadas === 'object' && guardadas !== null) {
      st.stats = { ...estadisticasVacias(), ...(guardadas as Partial<Estadisticas>) }
    }
    await $.command.register({
      name: 'enrutador',
      description: 'Enrutador de modelo: estado, on, off, stats, reset',
      argumentHint: '[on|off|stats|reset]',
      immediate: true,
    })
    await $.tool.register({
      name: HERRAMIENTA,
      description:
        'Pide más capacidad de razonamiento para el resto de esta tarea (pasa a Opus con esfuerzo alto). ' +
        'Llámala en cuanto notes que la tarea es más difícil de lo que parecía: varios intentos fallidos, ' +
        'causa raíz poco clara, diseño o decisiones delicadas. Si ya estás en Opus no hace falta.',
      inputSchema: {
        type: 'object',
        properties: { motivo: { type: 'string', description: 'Por qué hace falta, en una frase.' } },
      },
      isDeferred: false,
    })
    return next(e)
  })

  // 1. Clasificar el pedido antes de que empiece el turno.
  on('prompt.submit', async ($, e, next) => {
    if (!st.activo || e.turnId !== undefined) return next(e)

    const forzado = leerForzado(e.text)
    if (forzado !== null) {
      st.pendiente = { nivel: forzado.nivel, motivo: 'manual', esfuerzoForzado: forzado.esfuerzo, forzado: true }
      return forzado.texto.trim() === '' ? next(e) : next({ ...e, text: forzado.texto })
    }

    if (esSeguimiento(e.text) && st.ultimoNivel !== null) {
      st.pendiente = { nivel: st.ultimoNivel, motivo: 'seguimiento', forzado: false }
      return next(e)
    }

    const regla = porReglas(e.text, (e.attachments?.length ?? 0) > 0)
    if (regla !== null) {
      st.pendiente = { ...regla, forzado: false }
      return next(e)
    }

    if (enElTope(st.ultimoEnviado, await $.clock.now(), minutosFria)) {
      st.pendiente = { nivel: st.ultimoNivel ?? 'compleja', motivo: 'ya en Opus alto', forzado: false }
      return next(e)
    }

    st.pendiente = await clasificar($, e.text)
    return next(e)
  }).catch(($, e, next) => {
    // Nunca frena el pedido: sin decisión, el turno va en Opus como siempre.
    st.pendiente = null
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    st.actual = st.pendiente === null ? null : { ...st.pendiente, errSeguidos: 0, errTotales: 0 }
    st.pendiente = null
    return next(e)
  })

  // Modo plan: el engine agrega su aviso en cada turno planeando.
  on('session.append', ($, e, next) => {
    const nombre = e.message.name
    if (e.agentId === undefined && typeof nombre === 'string' && /^plan_mode/.test(nombre)) {
      st.planActivo = nombre !== 'plan_mode_exit'
    }
    return next(e)
  })

  // 2. La herramienta con la que el propio modelo pide más capacidad.
  on('tool.call', { tool: HERRAMIENTA_COMPLETA }, ($, e) => {
    const t = st.actual
    if (t === null || e.agentId !== undefined) {
      return { result: 'No hace falta: este paso ya va con el modelo de la sesión. Continúa con la tarea.' }
    }
    if (yaEnAlto(t)) return { result: 'Ya estás en Opus con esfuerzo alto. Continúa con la tarea.' }
    escalar($, 'lo pidió el modelo')
    return { result: 'Listo: los siguientes pasos de esta tarea van en Opus con esfuerzo alto. Continúa.' }
  })

  // 3. Errores seguidos en el hilo principal: escalar.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const t = st.actual
    if (t === null || e.agentId !== undefined || e.tool === HERRAMIENTA_COMPLETA) return r
    if (r.isError === true) {
      t.errSeguidos += 1
      t.errTotales += 1
      if (!yaEnAlto(t) && debeEscalar(t.errSeguidos, t.errTotales)) {
        escalar($, t.errSeguidos >= 3 ? `${t.errSeguidos} errores seguidos` : `${t.errTotales} errores`)
      }
    } else if (r.deny === undefined) {
      t.errSeguidos = 0
    }
    return r
  }).catch(($, e, next) => next(e))

  // 4. Aplicar modelo y esfuerzo a cada petición del hilo principal.
  on('turn.step', async function* ($, e, next) {
    const familiaSesion = familiaDe(e.model)
    const esPrincipal = e.agentId === undefined
    const esfuerzoSesion = esEsfuerzo(e.effort) ? e.effort : undefined
    const t = st.actual

    if (!esPrincipal || !st.activo || t === null || familiaSesion !== 'opus') {
      if (esPrincipal && familiaSesion !== 'otro') {
        st.ultimoEnviado = { familia: familiaSesion, esfuerzo: esfuerzoSesion, at: await $.clock.now() }
      }
      return yield* next(e)
    }

    const ahora = await $.clock.now()

    if (t.elegido === undefined) {
      const nivel: Nivel = st.planActivo ? 'compleja' : t.nivel
      const base = DESTINO[nivel]
      let esfuerzo: Esfuerzo = t.esfuerzoForzado ?? base.esfuerzo
      // En Opus nunca por debajo de lo que la sesión ya pide (/effort).
      if (base.familia === 'opus' && esfuerzoSesion !== undefined) esfuerzo = maxEsfuerzo(esfuerzo, esfuerzoSesion)
      let familia: Familia = base.familia
      let retenido = false

      const previo = st.ultimoEnviado
      if (!t.forzado && !st.planActivo && previo !== null) {
        if (retenerPorCache({ destino: { familia, esfuerzo }, ultimo: previo, ahora, minutosFria })) {
          familia = previo.familia
          esfuerzo = previo.esfuerzo ?? esfuerzo
          retenido = true
          st.stats.retenidosPorCache += 1
        }
      }
      t.elegido = { familia, esfuerzo, retenido }
      if (st.planActivo) t.motivo = 'modo plan'
    }

    let familia = t.elegido.familia
    let esfuerzo = t.elegido.esfuerzo
    if (t.escalado !== undefined) {
      familia = 'opus'
      esfuerzo = maxEsfuerzo('high', esfuerzoSesion ?? 'high')
    }

    const model = familia === 'opus' ? e.model : idLigero(e.model, modeloLigero)
    const nota = t.escalado ?? (t.elegido.retenido ? 'se queda por caché' : t.motivo)
    $.ui.status(etiqueta(familia, esfuerzo, t.nivel, nota))
    st.ultimoEnviado = { familia, esfuerzo, at: ahora }

    const res = yield* next({ ...e, model, effort: esfuerzo })

    const u = res.usage
    if (u !== null) {
      const fila = st.stats.porModelo[u.model] ?? { pasos: 0, entrada: 0, cacheLeido: 0, cacheEscrito: 0, salida: 0 }
      fila.pasos += 1
      fila.entrada += u.input_tokens ?? 0
      fila.cacheLeido += u.cache_read_input_tokens ?? 0
      fila.cacheEscrito += u.cache_creation_input_tokens ?? 0
      fila.salida += u.output_tokens ?? 0
      st.stats.porModelo[u.model] = fila
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const t = st.actual
    if (e.agentId === undefined && t !== null) {
      st.ultimoNivel = t.escalado !== undefined ? 'compleja' : t.nivel
      st.stats.turnos[t.nivel] += 1
      st.actual = null
      st.planActivo = false
      await guardarStats($)
    }
    return next(e)
  })

  // 5. /enrutador
  on('command.run', { command: 'enrutador' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      st.activo = arg === 'on'
      await $.store.set('activo', st.activo)
      if (!st.activo) $.ui.status(undefined)
      return { text: st.activo ? 'Enrutador encendido.' : 'Enrutador apagado: todo va con el modelo de la sesión.' }
    }
    if (arg === 'reset') {
      st.stats = estadisticasVacias()
      await $.store.set('stats', st.stats)
      return { text: 'Estadísticas en cero.' }
    }
    if (arg === 'stats') return { text: textoStats(st.stats) }
    return {
      text:
        `Enrutador ${st.activo ? 'encendido' : 'apagado'}. Último nivel: ${st.ultimoNivel ?? '—'}.\n` +
        `Prefijos: !sonnet, !opus, !max. Subcomandos: on, off, stats, reset.\n` +
        `Decide al primer pedido y con la caché caliente solo sube; la da por fría a los ${minutosFria} min.`,
    }
  })
}

function textoStats(s: Estadisticas): string {
  const t = s.turnos
  const total = t.trivial + t.simple + t.media + t.compleja
  const lineas = [
    `Turnos enrutados: ${total} (trivial ${t.trivial}, simple ${t.simple}, media ${t.media}, compleja ${t.compleja})`,
    `Escaladas a Opus a medio turno: ${s.escalados}`,
    `Se quedó en el modelo anterior por caché: ${s.retenidosPorCache}`,
    '',
    'Tokens por modelo (entrada sin caché / caché leída / caché escrita / salida):',
  ]
  for (const [modelo, u] of Object.entries(s.porModelo)) {
    lineas.push(`- ${modelo}: ${u.pasos} pasos · ${u.entrada} / ${u.cacheLeido} / ${u.cacheEscrito} / ${u.salida}`)
  }
  return lineas.join('\n')
}
