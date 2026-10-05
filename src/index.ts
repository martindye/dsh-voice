/**
 * Host half of @martin/dsh-voice: the metrics sink.
 *
 * The browser voice UI (src/client/metrics.ts) forwards one entry per
 * completed voice turn; each entry is appended as a JSON line to
 * ~/.dsh/logs/voice-metrics.log, where the numbers behind "the phone feels
 * slow" can be analysed afterwards.
 */
import { appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

function metricsLogPath(): string {
  return path.join(os.homedir(), '.dsh', 'logs', 'voice-metrics.log')
}

class VoiceMetricsController {
  readonly typertRemote = Object.freeze({
    service: this,
    serviceKey: 'voiceMetricsController',
    namespace: 'voiceMetrics',
  })

  /** One entry per completed voice turn (a JSON object from the client). */
  log(entry: unknown): { ok: true } {
    try {
      appendFileSync(metricsLogPath(), (typeof entry === 'string' ? entry : JSON.stringify(entry)) + '\n', 'utf8')
    } catch { /* metrics must never break the voice path */ }
    return { ok: true }
  }
}

Object.defineProperty(VoiceMetricsController.prototype, REMOTE_METHODS_KEY, {
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: 'log', invocation: { kind: 'direct' } },
    ]),
  }),
})

interface HostContext {
  provide(serviceKey: string, controller: unknown): void
}

export function apply(ctx: HostContext): void {
  ctx.provide('voiceMetricsController', new VoiceMetricsController())
}
