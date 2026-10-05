/**
 * Per-turn latency metrics for the voice conversation.
 *
 * The phone side of a two-way voice conversation is a black box to the host,
 * so the client marks the moments it can see and ships one line per completed
 * voice turn to the plugin's host half, which appends it as JSON to
 * ~/.dsh/logs/voice-metrics.log:
 *
 *   toAgentMs — user's words ended (VAD silence / cross / max length) until
 *               the session first reported running (queue + dispatch cost)
 *   thinkMs   — running true until running false (my thinking time)
 *   toVoiceMs — words ended until the system's voice starts (only when a
 *               spoken reply follows; the end-to-end voice-to-voice number)
 *
 * Best effort: with no host attached (tests, non-voice hosts) lines drop.
 */

export type MetricSink = (entry: Record<string, unknown>) => void

let sink: MetricSink = () => { /* no host attached: metrics are best effort */ }

/** Wire the transport (mount.ts) before the first turn. */
export function setMetricsSink(next: MetricSink): void { sink = next }

interface TurnMarks {
  /** The user's words became final (VAD silence, cross tap, max length). */
  voiceEnd: number | null
  /** First `running === true` after the words. */
  agentStart: number | null
  /** The `running === false` that followed the start. */
  agentEnd: number | null
  /** System speech started after the words (a spoken reply). */
  voiceStart: number | null
}

const marks: TurnMarks = { voiceEnd: null, agentStart: null, agentEnd: null, voiceStart: null }

/** The user's words are final: a new measurement window opens. */
export function voiceEnded(): void {
  marks.voiceEnd = Date.now()
  marks.agentStart = null
  marks.agentEnd = null
  marks.voiceStart = null
}

/** The session's running flag changed. */
export function runningChanged(running: boolean): void {
  if (marks.voiceEnd === null) return
  if (running) {
    if (marks.agentStart === null) marks.agentStart = Date.now()
  } else if (marks.agentStart !== null) {
    marks.agentEnd = Date.now()
    settle()
  }
}

/** System speech started (the reply's voice). */
export function speechStarted(): void {
  if (marks.voiceEnd !== null && marks.agentStart !== null && marks.agentEnd === null && marks.voiceStart === null) {
    marks.voiceStart = Date.now()
  }
}

function settle(): void {
  const { voiceEnd, agentStart, agentEnd, voiceStart } = marks
  Object.assign(marks, { voiceEnd: null, agentStart: null, agentEnd: null, voiceStart: null })
  if (voiceEnd === null || agentStart === null || agentEnd === null) return // agent never ran: nothing to measure
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    toAgentMs: agentStart - voiceEnd,
    thinkMs: agentEnd - agentStart,
  }
  if (voiceStart !== null) entry.toVoiceMs = voiceStart - voiceEnd
  sink(entry)
}
