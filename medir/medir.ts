// Mide cuánto habría ahorrado el enrutador con tu propio historial de Claude Code.
//
// Lee las conversaciones guardadas en ~/.claude/projects, repite cada decisión que el
// enrutador habría tomado (con la misma lógica de hooks/logica.ts y el mismo
// clasificador en Haiku) y compara el costo de solo Opus contra el costo con enrutador,
// a precios de la API.
//
// Uso:
//   node --experimental-strip-types medir/medir.ts --sin-clasificar   # cuenta, no gasta nada
//   node --experimental-strip-types medir/medir.ts                    # mide (llama a Haiku)
//
// Con ANTHROPIC_API_KEY llama a la API; sin ella, usa `claude -p` con tu sesión de Claude Code.
//
// Opciones: --desde AAAA-MM-DD, --hasta AAAA-MM-DD, --excluir <texto> (repetible: salta
// proyectos cuya carpeta contenga ese texto), --dir <carpeta de proyectos>,
// --salida <carpeta>, --modelo <id del clasificador>, --minutos-cache <n> (default 60).
//
// Solo manda a la API el texto de cada pedido y el final de la respuesta anterior, igual
// que el enrutador. Lo que guarda en disco son totales y, en la caché del clasificador,
// un hash de cada pedido con su nivel: nunca el texto.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DESTINO,
  aplicarDuda,
  debeEscalar,
  enElTope,
  esEsfuerzo,
  esSeguimiento,
  familiaDe,
  leerForzado,
  maxEsfuerzo,
  maxNivel,
  parsearClasificador,
  pisoPorPalabras,
  porReglas,
  promptClasificador,
  retenerPorCache,
  SISTEMA_CLASIFICADOR,
} from '../hooks/logica.ts'
import type { Enviado, Esfuerzo, Familia, Nivel } from '../hooks/logica.ts'

// --- Precios (USD por millón de tokens). Fuente: platform.claude.com/docs/en/about-claude/pricing

type Precio = { entrada: number; escritura5m: number; escritura1h: number; lectura: number; salida: number }

const PRECIOS: Record<string, Precio> = {
  opus: { entrada: 4, escritura5m: 5, escritura1h: 8, lectura: 0.2, salida: 20 },
  sonnet: { entrada: 2, escritura5m: 2.5, escritura1h: 4, lectura: 0.1, salida: 10 },
  haiku: { entrada: 0.1, escritura5m: 0.125, escritura1h: 0.2, lectura: 0.01, salida: 0.5 },
}

type Uso = { entrada: number; escritura5m: number; escritura1h: number; lectura: number; salida: number }

function precioDe(modelo: string): Precio {
  if (/opus/i.test(modelo)) return PRECIOS.opus
  if (/sonnet/i.test(modelo)) return PRECIOS.sonnet
  if (/haiku/i.test(modelo)) return PRECIOS.haiku
  return PRECIOS.opus
}

function costo(u: Uso, p: Precio): number {
  return (
    (u.entrada * p.entrada +
      u.escritura5m * p.escritura5m +
      u.escritura1h * p.escritura1h +
      u.lectura * p.lectura +
      u.salida * p.salida) /
    1e6
  )
}

function leerUso(raw: any): Uso {
  const creacion = raw?.cache_creation ?? {}
  const total = Number(raw?.cache_creation_input_tokens ?? 0)
  const h1 = Number(creacion.ephemeral_1h_input_tokens ?? 0)
  const m5 = Number(creacion.ephemeral_5m_input_tokens ?? 0)
  // Versiones viejas solo traen el total: se cobra como escritura de 5 minutos.
  const desglosado = h1 + m5 > 0
  return {
    entrada: Number(raw?.input_tokens ?? 0),
    escritura5m: desglosado ? m5 : total,
    escritura1h: desglosado ? h1 : 0,
    lectura: Number(raw?.cache_read_input_tokens ?? 0),
    salida: Number(raw?.output_tokens ?? 0),
  }
}

// --- Opciones ------------------------------------------------------------------------

function opciones() {
  const args = process.argv.slice(2)
  const o = {
    dir: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
    salida: 'medicion',
    modelo: 'claude-haiku-5-5',
    desde: '',
    hasta: '',
    excluir: [] as string[],
    minutos: 60,
    sinClasificar: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = () => args[++i] ?? ''
    if (a === '--dir') o.dir = v()
    else if (a === '--salida') o.salida = v()
    else if (a === '--modelo') o.modelo = v()
    else if (a === '--desde') o.desde = v()
    else if (a === '--hasta') o.hasta = v()
    else if (a === '--excluir') o.excluir.push(v().toLowerCase())
    else if (a === '--minutos-cache') o.minutos = Number(v())
    else if (a === '--sin-clasificar') o.sinClasificar = true
    else if (a === '--ayuda' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 20).join('\n'))
      process.exit(0)
    } else {
      console.error(`Opción desconocida: ${a}`)
      process.exit(2)
    }
  }
  return o
}

// --- Lectura del historial ---------------------------------------------------------------

type Paso = { t: number; modelo: string; uso: Uso; esfuerzo?: Esfuerzo; lateral: boolean }
type Pedido = { t: number; texto: string; adjuntos: boolean; plan: boolean; previo: string }
type Evento = { tipo: 'pedido'; p: Pedido } | { tipo: 'paso'; p: Paso } | { tipo: 'resultado'; t: number; error: boolean }

const RECORDATORIO = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function textoDe(contenido: any): { texto: string; adjuntos: boolean; herramienta: boolean } {
  if (typeof contenido === 'string') return { texto: contenido, adjuntos: false, herramienta: false }
  if (!Array.isArray(contenido)) return { texto: '', adjuntos: false, herramienta: false }
  let texto = ''
  let adjuntos = false
  let herramienta = false
  for (const b of contenido) {
    if (b?.type === 'text') texto += (texto === '' ? '' : '\n') + String(b.text ?? '')
    else if (b?.type === 'image' || b?.type === 'document') adjuntos = true
    else if (b?.type === 'tool_result') herramienta = true
  }
  return { texto, adjuntos, herramienta }
}

function archivos(dir: string): string[] {
  const out: string[] = []
  const recorrer = (d: string) => {
    for (const n of readdirSync(d)) {
      const ruta = join(d, n)
      const s = statSync(ruta)
      if (s.isDirectory()) recorrer(ruta)
      else if (n.endsWith('.jsonl')) out.push(ruta)
    }
  }
  recorrer(dir)
  return out
}

type Sesion = { id: string; proyecto: string; eventos: Evento[] }

function leerSesiones(dir: string, excluir: string[]): { sesiones: Sesion[]; saltadas: number } {
  const porSesion = new Map<string, Sesion>()
  const vistos = new Set<string>()
  let saltadas = 0
  for (const ruta of archivos(dir)) {
    const proyecto = ruta.slice(dir.length + 1).split('/')[0] ?? ''
    if (excluir.some(x => proyecto.toLowerCase().includes(x))) {
      saltadas += 1
      continue
    }
    const ultimaRespuesta = new Map<string, string>()
    for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
      if (linea.trim() === '') continue
      let e: any
      try {
        e = JSON.parse(linea)
      } catch {
        continue
      }
      const sid = String(e.sessionId ?? '')
      const t = Date.parse(e.timestamp ?? '')
      if (sid === '' || Number.isNaN(t)) continue
      if (excluir.some(x => String(e.cwd ?? '').toLowerCase().includes(x))) continue
      let s = porSesion.get(sid)
      if (s === undefined) {
        s = { id: sid, proyecto, eventos: [] }
        porSesion.set(sid, s)
      }
      const lateral = e.isSidechain === true || ruta.includes('/subagents/')

      if (e.type === 'assistant') {
        const m = e.message ?? {}
        const textoResp = textoDe(m.content).texto.trim()
        if (!lateral && textoResp !== '') ultimaRespuesta.set(sid, textoResp)
        const id = String(m.id ?? e.requestId ?? '')
        if (m.usage == null || id === '' || vistos.has(id)) continue // un mensaje se guarda en varias líneas
        vistos.add(id)
        s.eventos.push({
          tipo: 'paso',
          p: { t, modelo: String(m.model ?? ''), uso: leerUso(m.usage), esfuerzo: esEsfuerzo(e.effort) ? e.effort : undefined, lateral },
        })
        continue
      }

      if (e.type !== 'user' || lateral) continue
      const { texto: crudo, adjuntos, herramienta } = textoDe(e.message?.content)
      if (herramienta) {
        for (const b of e.message.content) {
          if (b?.type === 'tool_result') s.eventos.push({ tipo: 'resultado', t, error: b.is_error === true })
        }
        continue
      }
      if (e.isMeta === true || e.isCompactSummary === true) continue
      let texto = crudo.replace(RECORDATORIO, '').trim()
      if (texto.startsWith('<local-command-stdout>') || texto.startsWith('<bash-') || texto.startsWith('[Request interrupted')) continue
      const cmd = /<command-name>\s*(\/?[^<]+?)\s*<\/command-name>/.exec(texto)
      if (cmd !== null) texto = (cmd[1] ?? '').startsWith('/') ? (cmd[1] ?? '') : `/${cmd[1] ?? ''}`
      if (texto === '' && !adjuntos) continue
      s.eventos.push({
        tipo: 'pedido',
        p: { t, texto, adjuntos, plan: e.permissionMode === 'plan', previo: ultimaRespuesta.get(sid) ?? '' },
      })
    }
  }
  const sesiones = [...porSesion.values()]
  for (const s of sesiones) s.eventos.sort((a, b) => tiempo(a) - tiempo(b))
  return { sesiones, saltadas }
}

const tiempo = (e: Evento): number => (e.tipo === 'resultado' ? e.t : e.p.t)

// --- Clasificador ---------------------------------------------------------------------

type Clasificado = { nivel: Nivel; seguro: boolean; uso: Uso } | null

// Lo que le cuesta al enrutador una clasificación: el sistema y el pedido, ~3.5 caracteres por
// token, y unas 15 de respuesta.
function usoEstimado(pedido: string, previo: string): Uso {
  const entrada = Math.ceil((SISTEMA_CLASIFICADOR.length + promptClasificador(pedido, previo).length) / 3.5)
  return { entrada, escritura5m: 0, escritura1h: 0, lectura: 0, salida: 15 }
}

class Clasificador {
  private cache: Record<string, Clasificado>
  private ruta: string
  pendientes = new Map<string, { pedido: string; previo: string }>()
  llamadas = 0
  fallas = 0

  private modelo: string

  constructor(salida: string, modelo: string) {
    this.modelo = modelo
    this.ruta = join(salida, '.cache-clasificador.json')
    this.cache = existsSync(this.ruta) ? JSON.parse(readFileSync(this.ruta, 'utf8')) : {}
  }

  clave(pedido: string, previo: string): string {
    return createHash('sha256').update(this.modelo + '\0' + promptClasificador(pedido, previo)).digest('hex').slice(0, 32)
  }

  buscar(pedido: string, previo: string): Clasificado | undefined {
    const k = this.clave(pedido, previo)
    if (k in this.cache) return this.cache[k]
    this.pendientes.set(k, { pedido, previo })
    return undefined
  }

  // Con ANTHROPIC_API_KEY llama a la API; sin ella, usa Claude Code (`claude -p`) con tu sesión.
  get via(): string {
    const llave = process.env.ANTHROPIC_API_KEY
    return llave !== undefined && llave !== '' ? 'API' : 'Claude Code (tu sesión)'
  }

  async resolver(alAvanzar: (hechos: number, total: number) => void): Promise<void> {
    const llave = process.env.ANTHROPIC_API_KEY ?? ''
    const cola = [...this.pendientes.entries()]
    let hechos = 0
    const trabajador = async () => {
      for (;;) {
        const sig = cola.shift()
        if (sig === undefined) return
        const [k, { pedido, previo }] = sig
        const r = llave !== '' ? await this.llamar(llave, pedido, previo) : await this.llamarClaude(pedido, previo)
        // El costo del clasificador se estima con el tamaño del pedido, igual en las dos vías:
        // `claude -p` agrega su propio contexto, que el enrutador no paga.
        this.cache[k] = r === null ? null : { ...r, uso: usoEstimado(pedido, previo) }
        hechos += 1
        if (hechos % 25 === 0) this.guardar()
        alAvanzar(hechos, this.pendientes.size)
      }
    }
    await Promise.all(Array.from({ length: llave !== '' ? 6 : 8 }, trabajador))
    this.pendientes.clear()
    this.guardar()
  }

  private async llamar(llave: string, pedido: string, previo: string): Promise<Clasificado> {
    for (let intento = 0; intento < 5; intento++) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': llave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.modelo,
            max_tokens: 200,
            system: SISTEMA_CLASIFICADOR,
            messages: [{ role: 'user', content: promptClasificador(pedido, previo) }],
          }),
        })
        if (r.status === 429 || r.status >= 500) {
          await new Promise(res => setTimeout(res, 1000 * 2 ** intento))
          continue
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
        const j: any = await r.json()
        this.llamadas += 1
        const texto = (j.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('')
        const leido = parsearClasificador(texto)
        if (leido === null) return null
        return { ...leido, uso: leerUso(j.usage) }
      } catch (err) {
        if (intento === 4) {
          this.fallas += 1
          console.error(`\n  clasificador: ${(err as Error).message}`)
          return null
        }
        await new Promise(res => setTimeout(res, 1000 * 2 ** intento))
      }
    }
    this.fallas += 1
    return null
  }

  private llamarClaude(pedido: string, previo: string): Promise<Clasificado> {
    const args = [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '', '--no-session-persistence',
      '--strict-mcp-config', '--setting-sources', 'project', '--exclude-dynamic-system-prompt-sections',
      '--system-prompt', SISTEMA_CLASIFICADOR, '--output-format', 'json', promptClasificador(pedido, previo),
    ]
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    const intentar = (n: number): Promise<Clasificado> =>
      new Promise(resolve => {
        // cwd vacío y sin settings de usuario: no carga tus hooks, plugins ni MCP, y no guarda la sesión.
        const hijo = spawn('claude', args, { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] })
        let salida = ''
        let errores = ''
        const reloj = setTimeout(() => hijo.kill(), 120000)
        hijo.stdout.on('data', d => (salida += d))
        hijo.stderr.on('data', d => (errores += d))
        hijo.on('error', err => {
          clearTimeout(reloj)
          console.error(`\n  no pude correr claude: ${err.message}`)
          resolve(null)
        })
        hijo.on('close', async code => {
          clearTimeout(reloj)
          try {
            const j = JSON.parse(salida)
            if (j.is_error === true) throw new Error(String(j.result ?? 'error'))
            this.llamadas += 1
            const leido = parsearClasificador(String(j.result ?? ''))
            resolve(leido === null ? null : { ...leido, uso: usoEstimado(pedido, previo) })
          } catch (err) {
            if (n < 2) {
              await new Promise(res => setTimeout(res, 3000 * (n + 1)))
              resolve(await intentar(n + 1))
              return
            }
            this.fallas += 1
            console.error(`\n  claude -p (código ${code}): ${((err as Error).message || errores).slice(0, 200)}`)
            resolve(null)
          }
        })
      })
    return intentar(0)
  }

  private guardar(): void {
    writeFileSync(this.ruta, JSON.stringify(this.cache))
  }
}

// --- Simulación -----------------------------------------------------------------------

type Totales = {
  sesiones: Set<string>
  turnos: number
  turnosSonnet: number
  retenidos: number
  escalados: number
  clasificaciones: number
  costoBase: number
  costoEnrutador: number
  costoClasificador: number
  costoReescritura: number
  motivos: Record<string, number>
}

const totalesVacios = (): Totales => ({
  sesiones: new Set(),
  turnos: 0,
  turnosSonnet: 0,
  retenidos: 0,
  escalados: 0,
  clasificaciones: 0,
  costoBase: 0,
  costoEnrutador: 0,
  costoClasificador: 0,
  costoReescritura: 0,
  motivos: {},
})

function contar(t: Totales, clave: string): void {
  t.motivos[clave] = (t.motivos[clave] ?? 0) + 1
}

function semanaDe(t: number): string {
  const d = new Date(t)
  const lunes = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const mm = String(lunes.getMonth() + 1).padStart(2, '0')
  const dd = String(lunes.getDate()).padStart(2, '0')
  return `${lunes.getFullYear()}-${mm}-${dd}`
}

type Decision = { nivel: Nivel; forzado: boolean; esfuerzo?: Esfuerzo; clasificado: boolean }

function simular(
  s: Sesion,
  clasif: Clasificador,
  o: ReturnType<typeof opciones>,
  porSemana: Map<string, Totales>,
): void {
  const enRango = (t: number) => {
    const dia = new Date(t).toISOString().slice(0, 10)
    return (o.desde === '' || dia >= o.desde) && (o.hasta === '' || dia <= o.hasta)
  }
  const tot = (t: number): Totales => {
    const k = semanaDe(t)
    let x = porSemana.get(k)
    if (x === undefined) {
      x = totalesVacios()
      porSemana.set(k, x)
    }
    return x
  }

  let ultimoNivel: Nivel | null = null
  let ultimoEnviado: Enviado | null = null
  let familiaPrevia: Familia | null = null
  // Por modelo: cuándo se usó por última vez y cuánto contexto quedó en su caché.
  const cacheDe: Partial<Record<Familia, { at: number; contexto: number }>> = {}
  let turno: (Decision & { plan: boolean; elegido?: Familia; esfElegido?: Esfuerzo; escalado: boolean; seguidos: number; totales: number; t: number }) | null = null

  const cerrar = () => {
    if (turno === null) return
    ultimoNivel = turno.escalado ? 'compleja' : turno.nivel
    turno = null
  }

  for (const ev of s.eventos) {
    if (ev.tipo === 'pedido') {
      cerrar()
      const p = ev.p
      let d: Decision
      let motivo: string
      const forzado = leerForzado(p.texto)
      if (forzado !== null) {
        d = { nivel: forzado.nivel, esfuerzo: forzado.esfuerzo, forzado: true, clasificado: false }
        motivo = 'prefijo manual'
      } else if (esSeguimiento(p.texto) && ultimoNivel !== null) {
        d = { nivel: ultimoNivel, forzado: false, clasificado: false }
        motivo = 'seguimiento ("dale", "sí"…): hereda el nivel'
      } else {
        const regla = porReglas(p.texto, p.adjuntos)
        if (regla !== null) {
          d = { nivel: regla.nivel, forzado: false, clasificado: false }
          motivo = `regla: ${regla.motivo} → Opus`
        } else if (enElTope(ultimoEnviado, p.t, o.minutos)) {
          d = { nivel: ultimoNivel ?? 'compleja', forzado: false, clasificado: false }
          motivo = 'ya en Opus alto con caché caliente: no clasifica'
        } else {
          const r = clasif.buscar(p.texto, p.previo)
          if (r === undefined || r === null) {
            d = { nivel: 'compleja', forzado: false, clasificado: r !== undefined }
            motivo = 'clasificador sin respuesta → Opus'
          } else {
            let nivel = aplicarDuda(r.nivel, r.seguro)
            const piso = pisoPorPalabras(p.texto)
            if (piso !== null) nivel = maxNivel(nivel, piso)
            d = { nivel, forzado: false, clasificado: true }
            motivo = `clasificador: ${r.nivel}${r.seguro ? '' : ' con dudas'}${piso !== null && nivel !== aplicarDuda(r.nivel, r.seguro) ? ' + palabra delicada' : ''} → ${nivel}`
            if (enRango(p.t)) tot(p.t).costoClasificador += costo(r.uso, PRECIOS.haiku)
          }
          if (enRango(p.t)) tot(p.t).clasificaciones += 1
        }
      }
      if (p.plan) {
        d = { ...d, nivel: 'compleja' }
        motivo = 'modo plan → Opus'
      }
      turno = { ...d, plan: p.plan, escalado: false, seguidos: 0, totales: 0, t: p.t }
      if (enRango(p.t)) {
        contar(tot(p.t), `Decisión · ${motivo}`)
        tot(p.t).turnos += 1
        tot(p.t).sesiones.add(s.id)
      }
      continue
    }

    if (ev.tipo === 'resultado') {
      if (turno === null) continue
      if (ev.error) {
        turno.seguidos += 1
        turno.totales += 1
        if (!turno.escalado && debeEscalar(turno.seguidos, turno.totales)) {
          turno.escalado = true
          if (enRango(turno.t)) tot(turno.t).escalados += 1
        }
      } else turno.seguidos = 0
      continue
    }

    const paso = ev.p
    const base = costo(paso.uso, precioDe(paso.modelo))
    if (paso.lateral) {
      // Los subagentes no se tocan: cuestan lo mismo con y sin enrutador.
      if (enRango(paso.t)) {
        tot(paso.t).costoBase += base
        tot(paso.t).costoEnrutador += base
      }
      continue
    }

    const costoOpus = costo(paso.uso, PRECIOS.opus)
    let familia: Familia = 'opus'
    let esfuerzo: Esfuerzo | undefined = paso.esfuerzo
    if (turno !== null) {
      if (turno.elegido === undefined) {
        if (enRango(turno.t)) contar(tot(turno.t), `Esfuerzo de la sesión · ${paso.esfuerzo ?? 'sin dato'}`)
        const destino = DESTINO[turno.nivel]
        let esf: Esfuerzo = turno.esfuerzo ?? destino.esfuerzo
        if (destino.familia === 'opus' && paso.esfuerzo !== undefined) esf = maxEsfuerzo(esf, paso.esfuerzo)
        let fam: Familia = destino.familia
        if (!turno.forzado && !turno.plan && retenerPorCache({ destino: { familia: fam, esfuerzo: esf }, ultimo: ultimoEnviado, ahora: paso.t, minutosFria: o.minutos })) {
          fam = ultimoEnviado?.familia ?? fam
          esf = ultimoEnviado?.esfuerzo ?? esf
          if (enRango(turno.t)) {
            tot(turno.t).retenidos += 1
            contar(tot(turno.t), 'Decisión · iba a Sonnet pero la caché lo dejó en Opus')
          }
        }
        turno.elegido = fam
        turno.esfElegido = esf
        if (fam === 'sonnet' && enRango(turno.t)) tot(turno.t).turnosSonnet += 1
      }
      familia = turno.escalado ? 'opus' : turno.elegido
      esfuerzo = turno.escalado ? 'high' : turno.esfElegido
    }

    let simulado = costo(paso.uso, PRECIOS[familia])
    // Cambiar de modelo reescribe la caché: lo que este paso leía de caché el otro modelo no
    // lo tiene. Si ese modelo se usó hace menos de una hora, su caché sigue viva y solo falta
    // escribir lo que creció la conversación desde entonces.
    if (familiaPrevia !== null && familia !== familiaPrevia && paso.uso.lectura > 0) {
      const previa = cacheDe[familia]
      const viva = previa !== undefined && (paso.t - previa.at) / 60000 < o.minutos
      const faltante = viva ? Math.max(0, Math.min(paso.uso.lectura, paso.uso.lectura - previa.contexto)) : paso.uso.lectura
      const p = PRECIOS[familia]
      const extra = (faltante * (p.escritura1h - p.lectura)) / 1e6
      simulado += extra
      if (enRango(paso.t)) tot(paso.t).costoReescritura += extra
    }
    familiaPrevia = familia
    cacheDe[familia] = { at: paso.t, contexto: paso.uso.lectura + paso.uso.escritura5m + paso.uso.escritura1h }
    ultimoEnviado = { familia, esfuerzo, at: paso.t }
    if (enRango(paso.t)) {
      tot(paso.t).costoBase += costoOpus
      tot(paso.t).costoEnrutador += simulado
    }
  }
  cerrar()
}

// --- Reporte --------------------------------------------------------------------------

const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`)

function sumar(xs: Totales[]): Totales {
  const t = totalesVacios()
  for (const x of xs) {
    for (const s of x.sesiones) t.sesiones.add(s)
    t.turnos += x.turnos
    t.turnosSonnet += x.turnosSonnet
    t.retenidos += x.retenidos
    t.escalados += x.escalados
    t.clasificaciones += x.clasificaciones
    t.costoBase += x.costoBase
    t.costoEnrutador += x.costoEnrutador
    t.costoClasificador += x.costoClasificador
    t.costoReescritura += x.costoReescritura
    for (const [k, n] of Object.entries(x.motivos)) t.motivos[k] = (t.motivos[k] ?? 0) + n
  }
  return t
}

function fila(nombre: string, t: Totales): string[] {
  const conClasif = t.costoEnrutador + t.costoClasificador
  return [
    nombre,
    String(t.sesiones.size),
    String(t.turnos),
    pct(t.turnosSonnet, t.turnos),
    usd(t.costoBase),
    usd(conClasif),
    pct(t.costoBase - conClasif, t.costoBase),
  ]
}

function tabla(filas: string[][]): string {
  const enc = ['Semana', 'Sesiones', 'Turnos', 'Turnos en Sonnet', 'Solo Opus', 'Con enrutador', 'Ahorro']
  const todas = [enc, ...filas]
  const anchos = enc.map((_, i) => Math.max(...todas.map(f => (f[i] ?? '').length)))
  const linea = (f: string[]) => '| ' + f.map((c, i) => (i === 0 ? c.padEnd(anchos[i] ?? 0) : c.padStart(anchos[i] ?? 0))).join(' | ') + ' |'
  return [linea(enc), '| ' + anchos.map((a, i) => (i === 0 ? '-'.repeat(a) : '-'.repeat(a - 1) + ':')).join(' | ') + ' |', ...filas.map(linea)].join('\n')
}

// --- Main -----------------------------------------------------------------------------

async function main() {
  const o = opciones()
  if (!existsSync(o.dir)) {
    console.error(`No encontré ${o.dir}. Usa --dir con la carpeta de proyectos de Claude Code.`)
    process.exit(1)
  }
  mkdirSync(o.salida, { recursive: true })
  const clasif = new Clasificador(o.salida, o.modelo)

  console.log(`Leyendo ${o.dir}…`)
  const { sesiones, saltadas } = leerSesiones(o.dir, o.excluir)
  const enOpus = sesiones.filter(s => s.eventos.some(e => e.tipo === 'paso' && !e.p.lateral && familiaDe(e.p.modelo) === 'opus'))
  console.log(`${sesiones.length} sesiones (${enOpus.length} en Opus; las demás no las tocaría el enrutador).${saltadas > 0 ? ` Archivos excluidos: ${saltadas}.` : ''}`)

  // Qué pedidos podría mandar al clasificador. Se piden todos de una vez: cuáles llegan de
  // verdad al clasificador depende de las decisiones anteriores, y eso se resuelve al simular.
  for (const s of enOpus) {
    for (const e of s.eventos) {
      if (e.tipo !== 'pedido') continue
      const p = e.p
      if (leerForzado(p.texto) !== null || porReglas(p.texto, p.adjuntos) !== null) continue
      if (esSeguimiento(p.texto)) continue
      clasif.buscar(p.texto, p.previo)
    }
  }
  const faltan = clasif.pendientes.size
  if (faltan > 0) {
    const estimado = faltan * 0.0002
    if (o.sinClasificar) {
      console.log(`\nHay ${faltan} pedidos por clasificar con ${o.modelo} (costo estimado: ~$${estimado.toFixed(2)}).`)
      console.log('Corre sin --sin-clasificar para medir. Lo que ya se clasificó queda en caché y no se vuelve a pagar.')
      return
    }
    console.log(`Clasificando ${faltan} pedidos con Haiku vía ${clasif.via}${clasif.via === 'API' ? ` (~$${estimado.toFixed(2)})` : '; tarda unos minutos'}…`)
    await clasif.resolver((h, n) => process.stdout.write(`\r  ${h}/${n}`))
    process.stdout.write('\n')
  }

  // La medición. Si algún pedido no previsto necesitó clasificador (un "dale" al inicio de
  // una sesión, por ejemplo), se clasifica y se vuelve a simular.
  let porSemana = new Map<string, Totales>()
  for (let ronda = 0; ronda < 5; ronda++) {
    porSemana = new Map()
    for (const s of enOpus) simular(s, clasif, o, porSemana)
    if (clasif.pendientes.size === 0 || o.sinClasificar) break
    await clasif.resolver(() => {})
  }
  const semanas = [...porSemana.keys()].sort()
  if (semanas.length === 0) {
    console.log('No hay turnos en el rango pedido.')
    return
  }
  const total = sumar([...porSemana.values()])
  const filas = [...semanas.map(k => fila(k, porSemana.get(k) ?? totalesVacios())), fila('Total', total)]
  const t = tabla(filas)
  const conClasif = total.costoEnrutador + total.costoClasificador
  const notas = [
    `Costo a precios de la API (Opus $4/$20, Sonnet $2/$10 por millón de tokens de entrada/salida, con caché).`,
    `"Solo Opus" vuelve a cobrar a precio de Opus cada paso del hilo principal; los subagentes cuestan igual en las dos columnas.`,
    `"Con enrutador" repite las decisiones del enrutador pedido por pedido, incluye el clasificador (${usd(total.costoClasificador)}) y la caché que se reescribe al cambiar de modelo (${usd(total.costoReescritura)}).`,
    `Turnos que se quedaron en el modelo anterior por la caché: ${total.retenidos}. Escaladas a Opus por errores: ${total.escalados}.`,
    `No simula: subir_nivel (lo pide el modelo a media tarea) ni que Sonnet responda con más o menos tokens que Opus.`,
    `Los límites de los planes de suscripción no son públicos: esto mide costo equivalente de API, no el porcentaje exacto del plan.`,
  ]
  console.log('\n' + t + '\n')
  console.log(`Ahorro total: ${pct(total.costoBase - conClasif, total.costoBase)} (${usd(total.costoBase)} → ${usd(conClasif)}).\n`)
  for (const n of notas) console.log(`· ${n}`)

  console.log('\nPor qué decidió así (turnos):')
  for (const [k, n] of Object.entries(total.motivos).sort((a, b) => (a[0].split(' · ')[0] ?? '').localeCompare(b[0].split(' · ')[0] ?? '') || b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`)
  }

  const resumen = [
    '# Medición del enrutador',
    '',
    `Generado el ${new Date().toISOString().slice(0, 10)} con \`medir/medir.ts\` sobre ${total.sesiones.size} sesiones y ${total.turnos} turnos.`,
    '',
    t,
    '',
    ...notas.map(n => `- ${n}`),
    '',
  ].join('\n')
  writeFileSync(join(o.salida, 'resumen.md'), resumen)
  writeFileSync(
    join(o.salida, 'resultado.json'),
    JSON.stringify(
      {
        generado: new Date().toISOString(),
        opciones: { desde: o.desde, hasta: o.hasta, excluidos: o.excluir.length, minutosCache: o.minutos, clasificador: o.modelo },
        precios: PRECIOS,
        semanas: Object.fromEntries(semanas.map(k => {
          const x = porSemana.get(k) ?? totalesVacios()
          return [k, { ...x, sesiones: x.sesiones.size }]
        })),
        total: { ...total, sesiones: total.sesiones.size },
      },
      null,
      2,
    ),
  )
  console.log(`\nGuardado en ${join(o.salida, 'resumen.md')} y ${join(o.salida, 'resultado.json')} (solo totales, sin texto de tus pedidos).`)
}

main().catch(err => {
  console.error((err as Error).message)
  process.exit(1)
})
