/**
 * Host half of the two-way voice output: the `tts` Remote namespace.
 *
 * The browser speaks through this service: one synthesize() per finalized
 * assistant message. The text is resolved from the session log on this host
 * (never over the wire), prepared for speech, and rendered by the plugin's
 * own loopback TTS server (tts/server.py), which is supervised here:
 * started on demand, restarted if it dies.
 *
 * Deliberately kept small compared with the old voice-chat kit:
 *  - no model downloads: the models are user state under ~/.dsh/voice-chat
 *    and the plugin reports readiness through status();
 *  - no voice-bridge coupling: the retired TTSTT bridge got no notes here;
 *  - engine choice reads the shared consent file (~/.dsh/voice-chat/
 *    consent.json), defaulting to the GPU voice when its model is present.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'
import { splitSentences } from './sentences.ts'
import { budgetTurnText } from './turn-text.ts'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_PY = path.join(PLUGIN_DIR, 'tts', 'server.py')
const BIN_DIR = path.join(PLUGIN_DIR, 'bin')
const REF_DIR = path.join(PLUGIN_DIR, 'ref_voices')

const PYTHON = process.env.DSH_VOICE_PYTHON ?? 'python'
const TTS_PORT = Number(process.env.DSH_VOICE_TTS_PORT ?? 8189)
const TTS_HOST = '127.0.0.1'
const TTS_URL = `http://${TTS_HOST}:${TTS_PORT}`

const CONSENT_FILE = path.join(os.homedir(), '.dsh', 'voice-chat', 'consent.json')
const MODEL_ROOT = path.join(os.homedir(), '.dsh', 'voice-chat', 'models')
const LOG_FILE = path.join(os.homedir(), '.dsh', 'logs', 'voice-tts.log')
const FRESH_WINDOW_MS = 2 * 60_000
const TTS_MAX_CHARS = 4000
const CACHE_DIR = path.join(os.homedir(), '.dsh', 'voice-chat', 'tts-cache')
// Sentence-level entries are small and repeat a lot ("Give me the go."), so
// the cap is generous; each entry is one short WAV (~100-300 KB).
const CACHE_MAX = 50
// One render call may carry a whole message's worth of text: the client can
// join the entire (4000-char-capped) prepared message into one block, so the
// guard matches the message cap, not the old single-sentence size.
const RENDER_MAX_CHARS = 4000

function log(message: string): void {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `[dsh-voice tts] ${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* the log must never break speech */ }
}

/* ------------------------------------------------------------------ */
/* Reply cache: one text + engine pair is rendered once; every other   */
/* device or repeat replays the stored WAV. Oldest entries are killed  */
/* beyond CACHE_MAX, so the cache is small and disposable by design.   */
/* ------------------------------------------------------------------ */

function cacheKey(prepared: string, engine: string): string {
  return createHash('sha256').update(`${engine}\n${prepared}`, 'utf8').digest('hex')
}

function cacheGet(key: string): Buffer | null {
  try {
    const file = path.join(CACHE_DIR, `${key}.wav`)
    if (existsSync(file)) return readFileSync(file)
  } catch { /* a broken cache entry is a miss, never an error */ }
  return null
}

function cachePut(key: string, wav: Buffer): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const file = path.join(CACHE_DIR, `${key}.wav`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, wav)
    renameSync(tmp, file)
    const entries = readdirSync(CACHE_DIR)
      .filter((n) => n.endsWith('.wav'))
      .map((n) => ({ n, mtime: statSync(path.join(CACHE_DIR, n)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
    for (const { n } of entries.slice(0, Math.max(0, entries.length - CACHE_MAX))) {
      try { unlinkSync(path.join(CACHE_DIR, n)) } catch { /* best effort */ }
    }
  } catch { /* the cache must never break speech */ }
}

/* ------------------------------------------------------------------ */
/* Machine probes                                                      */
/* ------------------------------------------------------------------ */

let pythonProbeCache: { cmd: string; args: string[] } | null | undefined

function pythonProbeCommand(): { cmd: string; args: string[] } | null {
  if (pythonProbeCache !== undefined) return pythonProbeCache
  const probe = (cmd: string, args: string[]): { cmd: string; args: string[] } | null => {
    try {
      execFileSync(cmd, [...args, '--version'], { stdio: 'ignore', windowsHide: true, timeout: 8000 })
      return { cmd, args }
    } catch { return null }
  }
  pythonProbeCache = probe(PYTHON, []) ?? probe('py', ['-3']) ?? null
  return pythonProbeCache
}

function qwenModelReady(): boolean {
  const dir = path.join(MODEL_ROOT, 'qwen3')
  return ['qwen-talker-1.7b-base-Q8_0.gguf', 'qwen-tokenizer-12hz-Q8_0.gguf']
    .every((name) => { try { return existsSync(path.join(dir, name)) } catch { return false } })
}

interface Consent { engine?: string }

function readConsent(): Consent | null {
  try { return JSON.parse(readFileSync(CONSENT_FILE, 'utf8')) as Consent } catch { return null }
}

/** The consented engine, or the best ready one (GPU first, CPU fallback). */
/** The consented engine, or the best ready one (GPU first, CPU fallback).
 *  Maps the consent keys to the TTS server's registry names. */
function selectedEngine(): string {
  const consent = readConsent()
  if (consent?.engine === 'qwen3') return 'qwen3ggufbase'
  if (consent?.engine === 'pocket') return 'pocket'
  return qwenModelReady() ? 'qwen3ggufbase' : 'pocket'
}

/**
 * The GPU voice chain (tts-gate on 8095 fronting CosyVoice on 8097) is a
 * user OPT-IN, not an auto-start: it takes real VRAM from the LLM. The
 * starter script is idempotent and reuses a live chain.
 */
const GPU_STARTER = process.env.DSH_VOICE_GPU_STARTER
  ?? path.join(os.homedir(), '.dsh', 'tts-gate', 'start-tts-gate.ps1')

async function gpuChainUp(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:8095/v1/models', { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}

/* ------------------------------------------------------------------ */
/* TTS server supervision (tts/server.py)                              */
/* ------------------------------------------------------------------ */

let child: ChildProcess | null = null
let healthOk = false
let lastHealthAt = 0

async function fetchHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return false
    const body = (await r.json()) as { ok?: boolean }
    return body.ok === true
  } catch { return false }
}

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VOICE_CHAT_MODEL_ROOT: MODEL_ROOT,
    VOICE_CHAT_BIN_DIR: BIN_DIR,
    VOICE_CHAT_REF_DIR: REF_DIR,
    VOICE_CHAT_STATE_DIR: path.join(os.homedir(), '.dsh', 'voice-chat', 'state'),
    VOICE_CHAT_PRELOAD_ENGINE: selectedEngine(),
  }
}

async function ensureServer(): Promise<void> {
  if (healthOk && Date.now() - lastHealthAt < 30_000) return
  healthOk = await fetchHealth()
  lastHealthAt = Date.now()
  if (healthOk) return
  if (child) { try { child.kill() } catch { /* ignore */ } child = null }
  const probe = pythonProbeCommand()
  if (!probe) throw new Error('Python is required for the voice replies but was not found on PATH')
  log('starting TTS server (python tts/server.py)')
  child = spawn(probe.cmd, [...probe.args, '-X', 'utf8', SERVER_PY,
    '--port', String(TTS_PORT), '--bind', TTS_HOST], {
    cwd: path.join(PLUGIN_DIR, 'tts'),
    env: serverEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => log(`tts-server: ${String(d).trimEnd()}`))
  child.stderr?.on('data', (d: Buffer) => log(`tts-server: ${String(d).trimEnd()}`))
  child.on('error', (e) => log(`tts server spawn error: ${e.message}`))
  child.on('exit', (code) => { log(`tts server exited (${code}); will restart on demand`); child = null; healthOk = false })
  const deadline = Date.now() + 90_000
  for (;;) {
    if (Date.now() > deadline) throw new Error('TTS server did not become healthy within 90 s')
    if (await fetchHealth()) { healthOk = true; lastHealthAt = Date.now(); return }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function renderWav(text: string, { engine }: { engine?: string }): Promise<Buffer> {
  const r = await fetch(`${TTS_URL}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(engine ? { engine } : {}) }),
    signal: AbortSignal.timeout(300_000), // first call loads the model
  })
  if (!r.ok) {
    let detail = `TTS server HTTP ${r.status}`
    try { detail = ((await r.json()) as { error?: string }).error ?? detail } catch { /* keep default */ }
    throw new Error(detail)
  }
  return Buffer.from(await r.arrayBuffer())
}

/* ------------------------------------------------------------------ */
/* Message text resolution (session log: concatenated zstd frames)     */
/* ------------------------------------------------------------------ */

const ZSTD_MAGIC = 0xfd2fb528

/** Walk a concatenated zstd frame stream (port of DSH's scanZstdFrames). */
function scanZstdFrames(buffer: Buffer): { frames: { start: number; end: number }[] } {
  const frames: { start: number; end: number }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (buffer.length - offset < (blockType === 0x01 ? 1 : blockSize)) break
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return { frames }
}

function findSessionFile(sessionId: string): string | null {
  const id = /^session-[0-9a-f-]+$/i.test(sessionId) ? sessionId : `session-${sessionId}`
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  let projects: string[] = []
  try { projects = readdirSync(root) } catch { return null }
  for (const name of projects) {
    const file = path.join(root, name, id, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return null
}

function eventTime(t: unknown): number {
  if (typeof t === 'number') return t > 1e12 ? t : t * 1000
  if (typeof t === 'string') { const n = Date.parse(t); if (!Number.isNaN(n)) return n }
  return 0
}

interface SessionEvent {
  type?: string
  time?: unknown
  data?: { turn?: number; message?: { id?: string; content?: unknown } }
}

type ReadScope = 'final' | 'steps'

/** The visible text of one assistant message (all its text blocks, in order). */
function messageText(ev: SessionEvent): string {
  const content = ev.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => (b as { text: string }).text)
    .join('\n')
}

/**
 * Resolve the speakable text of a reply from the session log.
 * 'final' (default) reads only the message itself — the turn's last answer.
 * 'steps' reads every assistant step of the same turn in order, capped by
 * TTS_MAX_CHARS with the final answer keeping priority (budgetTurnText).
 */
function resolveMessage(sessionId: string, messageId: string, scope: ReadScope = 'final'): { text: string; time: number } {
  const file = findSessionFile(sessionId)
  if (!file) throw new Error(`session ${sessionId} not found on this host`)
  const buf = readFileSync(file)
  const { frames } = scanZstdFrames(buf)
  const zstdDecompressSync = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (!zstdDecompressSync) throw new Error('this host\'s Node build cannot read zstd session logs')
  const events: SessionEvent[] = []
  for (const frame of frames) {
    let text: string
    try { text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line) as SessionEvent) } catch { continue }
    }
  }
  // The newest occurrence wins (matches the previous newest-first scan).
  let target: { ev: SessionEvent; index: number } | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'assistant/message' && ev.data?.message?.id === messageId) { target = { ev, index: i }; break }
  }
  if (!target) throw new Error(`message ${messageId} not found in the session log`)
  const targetText = messageText(target.ev)
  const time = eventTime(target.ev.time)
  if (scope !== 'steps') return { text: targetText, time }
  const turn = target.ev.data?.turn
  if (turn === undefined) return { text: targetText, time }
  const parts: string[] = []
  for (let i = 0; i <= target.index; i++) {
    const ev = events[i]
    if (ev.type !== 'assistant/message' || ev.data?.turn !== turn) continue
    const text = messageText(ev).trim()
    if (text) parts.push(text)
  }
  if (parts.length === 0) return { text: targetText, time }
  return { text: budgetTurnText(parts, TTS_MAX_CHARS), time }
}

/** Strip the parts of a reply that must never be spoken. */
function prepForSpeech(text: string): string {
  return (text ?? '')
    .replace(/\[\[[a-z_]+\]\]/gi, ' ')        // mood tags
    .replace(/```[\s\S]*?```/g, ' [code] ')    // fenced code blocks
    .replace(/`[^`\n]*`/g, ' ')                // inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links -> label
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt
    .replace(/[*_#>|~-]{1,4}/g, ' ')           // markdown markers
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ */
/* The Remote service                                                  */
/* ------------------------------------------------------------------ */

const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

interface SynthesizeRequest {
  sessionId?: string
  messageId?: string
  auto?: boolean
  /** 'steps' speaks the whole turn (intermediate steps + final answer). */
  scope?: 'final' | 'steps'
}

class TtsController {
  readonly typertRemote = Object.freeze({
    service: this,
    serviceKey: 'ttsController',
    namespace: 'tts',
  })

  /** Machine facts for the client: server state and the active engine. */
  async status(): Promise<{ ok: true; server: 'up' | 'off'; engine: string; python: boolean }> {
    let up = healthOk
    if (!up) {
      up = await fetchHealth()
      if (up) { healthOk = true; lastHealthAt = Date.now() }
    }
    const gpu = await gpuChainUp()
    return { ok: true, server: up ? 'up' : 'off', engine: selectedEngine(), python: pythonProbeCommand() !== null, gpu }
  }

  /**
   * The user's voice choice. 'pocket' = small CPU voice (default; no GPU);
   * 'qwen3' = the GPU voice — starts the GPU chain on demand (3-5 min load)
   * and never auto-restarts it. The choice persists in the shared consent
   * file and is read per request.
   */
  async setEngine(engine: 'pocket' | 'qwen3') {
    if (engine !== 'pocket' && engine !== 'qwen3') throw new Error(`unknown voice choice: ${String(engine)}`)
    mkdirSync(path.dirname(CONSENT_FILE), { recursive: true })
    writeFileSync(CONSENT_FILE, JSON.stringify({ engine }), 'utf8')
    log(`voice choice: ${engine}`)
    let gpu: 'not-requested' | 'up' | 'starting' | 'starter-missing' = 'not-requested'
    if (engine === 'qwen3') {
      if (await gpuChainUp()) gpu = 'up'
      else if (existsSync(GPU_STARTER)) {
        spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', GPU_STARTER],
          { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
        log('gpu voice chain starter launched')
        gpu = 'starting'
      } else {
        log(`gpu starter missing: ${GPU_STARTER}`)
        gpu = 'starter-missing'
      }
    }
    return { ok: true, engine, gpu }
  }

  /** Render one finalized assistant message to a base64 WAV. */
  async synthesize(request: SynthesizeRequest, signal?: { throwIfAborted?: () => void }): Promise<Record<string, unknown>> {
    signal?.throwIfAborted?.()
    const sessionId = request?.sessionId
    const messageId = request?.messageId
    const auto = !!request?.auto
    const scope = request?.scope
    log(`synthesize start: session=${sessionId} message=${messageId} auto=${auto} scope=${scope ?? 'final'}`)
    if (!sessionId || !messageId) throw new Error('synthesize requires sessionId and messageId')
    const { text, time } = resolveMessage(sessionId, messageId, scope)
    let prepared = prepForSpeech(text)
    if (!prepared) throw new Error('that message has no speakable text')
    if (prepared.length > TTS_MAX_CHARS) prepared = `${prepared.slice(0, TTS_MAX_CHARS).trimEnd()}...`

    if (auto) {
      const ageMs = Date.now() - time
      if (time > 0 && ageMs > FRESH_WINDOW_MS) {
        log(`synthesize stale: age ${Math.round(ageMs / 1000)}s (auto)`)
        return { stale: true }
      }
    }

    const engine = selectedEngine()
    const key = cacheKey(prepared, engine)
    const cached = cacheGet(key)
    if (cached) {
      log(`cache hit: ${prepared.length} chars (engine ${engine}, wav ${cached.length} bytes)`)
      return { audioBase64: cached.toString('base64'), elapsedMs: 0, engine, cached: true }
    }
    await ensureServer()
    const started = Date.now()
    const wav = await renderWav(prepared, { engine })
    const elapsedMs = Date.now() - started
    log(`synthesize ok: ${prepared.length} chars in ${elapsedMs}ms (engine ${engine}, wav ${wav.length} bytes)`)
    cachePut(key, wav)
    return { audioBase64: wav.toString('base64'), elapsedMs, engine }
  }

  /**
   * Sentence plan for one finalized message: the prepared text split into
   * sentences, NO audio. The client then pipelines one render() per sentence
   * so the first words are heard while the rest is still being rendered
   * (the engine renders ~2.5x faster than real time, so the pipe never
   * starves). The freshness check lives here, once, not per sentence.
   */
  async plan(
    request: { sessionId?: string; messageId?: string; auto?: boolean; scope?: 'final' | 'steps' },
    signal?: { throwIfAborted?: () => void },
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted?.()
    const sessionId = request?.sessionId
    const messageId = request?.messageId
    const auto = !!request?.auto
    const scope = request?.scope
    if (!sessionId || !messageId) throw new Error('plan requires sessionId and messageId')
    const { text, time } = resolveMessage(sessionId, messageId, scope)
    let prepared = prepForSpeech(text)
    if (!prepared) throw new Error('that message has no speakable text')
    if (prepared.length > TTS_MAX_CHARS) prepared = `${prepared.slice(0, TTS_MAX_CHARS).trimEnd()}...`
    if (auto) {
      const ageMs = Date.now() - time
      if (time > 0 && ageMs > FRESH_WINDOW_MS) {
        log(`plan stale: age ${Math.round(ageMs / 1000)}s (auto)`)
        return { stale: true, ageSeconds: Math.round(ageMs / 1000) }
      }
    }
    const sentences = splitSentences(prepared)
    log(`plan: message=${messageId} ${prepared.length} chars -> ${sentences.length} sentences (auto=${auto})`)
    return { stale: false, sentences }
  }

  /**
   * Render one prepared sentence (as returned by plan()) to a base64 WAV.
   * Sentence-granular: repeat phrases across messages hit the cache.
   */
  async render(
    request: { text?: string },
    signal?: { throwIfAborted?: () => void },
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted?.()
    const sentence = (request?.text ?? '').trim()
    if (!sentence) throw new Error('render requires text')
    if (sentence.length > RENDER_MAX_CHARS) throw new Error('render text too long')
    const engine = selectedEngine()
    const key = cacheKey(sentence, engine)
    const cached = cacheGet(key)
    if (cached) {
      log(`render cache hit: ${sentence.length} chars (engine ${engine}, wav ${cached.length} bytes)`)
      return { audioBase64: cached.toString('base64'), elapsedMs: 0, engine, cached: true }
    }
    await ensureServer()
    const started = Date.now()
    const wav = await renderWav(sentence, { engine })
    const elapsedMs = Date.now() - started
    log(`render ok: ${sentence.length} chars in ${elapsedMs}ms (engine ${engine}, wav ${wav.length} bytes)`)
    cachePut(key, wav)
    return { audioBase64: wav.toString('base64'), elapsedMs, engine, cached: false }
  }
}

Object.defineProperty(TtsController.prototype, REMOTE_METHODS_KEY, {
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'synthesize', invocation: { kind: 'direct' } },
      { method: 'plan', invocation: { kind: 'direct' } },
      { method: 'render', invocation: { kind: 'direct' } },
      { method: 'setEngine', invocation: { kind: 'direct' } },
    ]),
  }),
})

export { TtsController, ensureServer, log as ttsLog }
