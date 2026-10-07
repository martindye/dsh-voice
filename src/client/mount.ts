/** Source-safe lifecycle for the optional speech Remote and browser UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceInput, type VoiceInputInjected } from './VoiceInput.tsx'
import { setMetricsSink } from './metrics.ts'
import { Recording } from './audio.ts'
import { en, NS, zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { armPageAudioUnlock } from './audio-unlock.ts'
import { observeReadiness } from './readiness.ts'
import { VoicePreparation } from './PreparationCard.tsx'
import { VoiceSetupPrompt } from './VoiceSetupPrompt.tsx'
import { TTS_REMOTE, noteTtsStatus, setTtsRemote, speakNow as speakNowTts } from './tts.ts'
import { SpeakerButton } from './SpeakerButton.tsx'
import { AutoReadToggle } from './AutoReadToggle.tsx'

export const inject = ['remote', 'slots', 'locale', 'pluginNavigation']

/** Pass-through codec (the bundle has no zod): the runtime only needs the shape. */
function passThroughCodec(typeSymbol: string): unknown {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value: unknown) => value,
      safeParse: (value: unknown) => ({ success: true, data: value }),
    }),
  }
}

/** The plugin's own tiny Remote: one voice-turn latency line to the host log. */
const METRICS_REMOTE = {
  package: '@martin/dsh-voice',
  descriptors: [{
    id: '@martin/dsh-voice#voiceMetrics/log',
    service: 'voiceMetricsController',
    namespace: 'voiceMetrics',
    method: 'log',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'entry', wire: 'entry', source: 'json', codec: passThroughCodec('@martin/dsh-voice#MetricEntry') }],
    result: passThroughCodec('@martin/dsh-voice#MetricResult'),
  }],
} as const

/**
 * The plugin's own Remotes (voice metrics + TTS output) share one package,
 * and the typert registry rejects a second registration of the same package:
 * they mount as a single contribution.
 */
const VOICE_REMOTE = {
  package: METRICS_REMOTE.package,
  descriptors: [...METRICS_REMOTE.descriptors, ...TTS_REMOTE.descriptors],
} as unknown as TypertRemoteContribution

/**
 * The unified activity-slot button takes over the composer's send/stop control,
 * so retire the native primary button. Matching is by the host's own labels;
 * on a non-English host the labels differ and the native button simply stays.
 */
/** :not([data-voice-unified]) keeps this plugin's own unified button out of the rule. */
const NATIVE_SEND_HIDE_RULES = [
  'button[aria-label="Send message"]:not([data-voice-unified])',
  'button[aria-label="Queue message"]:not([data-voice-unified])',
  'button[aria-label="Steer message"]:not([data-voice-unified])',
  'button[aria-label="Stop generating"]:not([data-voice-unified])',
]

/** The app's own stop button: hidden by the rule above, still wired to the host's stop path. */
const NATIVE_STOP_SELECTORS = [
  'button[aria-label="Stop generating"]:not([data-voice-unified])',
]

function retireNativeSendButton(): void {
  try {
    if (typeof document === 'undefined' || document.getElementById('dsh-voice-unified-hide')) return
    const style = document.createElement('style')
    style.id = 'dsh-voice-unified-hide'
    style.textContent = NATIVE_SEND_HIDE_RULES.map(selector => `${selector}{display:none!important}`).join('')
    document.head.append(style)
  } catch { /* non-DOM host: nothing to hide */ }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  retireNativeSendButton()
  const recordings = new Set<Recording>()
  const readiness = observeReadiness(ctx)
  ctx.effect(() => readiness.dispose)
  ctx.effect(() => async () => { await Promise.all([...recordings].map(recording => recording.dispose())) })
  const actions: VoiceInputInjected = {
    openSettings: () => { ctx.pluginNavigation.openBundle('@martin/dsh-voice') },
    stopTurn: (sessionId: SessionId) => {
      // Preferred: the app's own stop button. It stays in the DOM while a
      // turn runs (the unified-button CSS only hides it) and is wired to the
      // host's stop path, so clicking it stops the turn exactly as the
      // native UI would.
      const native = document.querySelector<HTMLButtonElement>(NATIVE_STOP_SELECTORS.join(', '))
      if (native) { native.click(); return }
      // No native button in the DOM (non-English label, or a moment it is
      // not rendered): cancel through the session-scoped Conversation.
      try {
        const scoped = ctx.sessions?.scope?.(sessionId)
        const conversation = scoped?.get?.('conversation') as { cancel?: () => Promise<unknown> } | undefined
        void conversation?.cancel?.().catch(() => { /* a failed stop surfaces through the session prompt line */ })
      } catch { /* nothing reachable: the stop cannot complete */ }
    },
    hooks: { speechReadiness: readiness.state },
    createRecording: () => {
      const recording = new Recording(() => { recordings.delete(recording) })
      recordings.add(recording)
      return recording
    },
    transcribe: async (request, signal) => await ctx.remote.speech.transcribe(request, signal),
    configure: async (patch) => { const result = await ctx.remote.speech.configure(patch); if (!result.ok) throw result.error },
    prepare: async (providerId, options) => {
      const result = await ctx.remote.speech.prepare(providerId, options); if (!result.ok) throw result.error
    },
    cancelPreparation: async (providerId) => {
      const result = await ctx.remote.speech.cancelPreparation(providerId); if (!result.ok) throw result.error
    },
  }
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity', locale: NS, inject: () => actions,
  }, VoiceInput))
  // The Plugins page dispatches these keyed slots by the installed bundle's
  // package name, so the cards register under this plugin's own name.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config',
    key: '@martin/dsh-voice', locale: NS, inject: () => actions,
  }, VoicePreparation))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation',
    key: '@martin/dsh-voice', locale: NS, inject: () => actions,
  }, VoiceSetupPrompt))
  // Output side: a speaker button on each finalized assistant message and a
  // per-device auto-read toggle in the session header corner.
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'speak', order: 20, locale: NS,
    inject: (sessionId?: unknown) => ({
      speakNow: (messageId: string) => {
        if (typeof sessionId === 'string' && typeof messageId === 'string') speakNowTts(sessionId, messageId)
      },
    }),
  }, SpeakerButton))
  ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
    name: 'conversation.session.header.corner', locale: NS,
    inject: () => ({}),
  }, AutoReadToggle))
}

/**
 * Mount this experimental namespace without adding it to stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated speech Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountVoiceInput(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  // Safari locks page audio until a real touch; the voice composer is the
  // first thing touched, so take the unlock on behalf of the whole page.
  armPageAudioUnlock()
  const disposeRemote = await ctx.remote.$mount(contribution)
  const disposeVoice = await ctx.remote.$mount(VOICE_REMOTE)
  // The Remote proxy gates namespace property access by inject declaration;
  // this fiber declares only 'remote', so take the service-key lookups for
  // our own namespaces here, once, and hold the references.
  const ttsNs = ctx.get('remote.tts') as { status?: () => Promise<unknown> } | undefined
  const metricsNs = ctx.get('remote.voiceMetrics') as { log?: (entry: Record<string, unknown>) => unknown } | undefined
  setTtsRemote({ tts: ttsNs })
  setMetricsSink((entry) => {
    try {
      void Promise.resolve(metricsNs?.log?.(entry)).catch(() => { /* metrics never break the voice path */ })
    } catch { /* ditto */ }
  })
  // Keep the output status (server up/down, active engine) fresh for the
  // header toggle's tooltip; the host starts the server lazily on demand.
  const pollTtsStatus = () => {
    try {
      void ttsNs?.status?.().then((r) => {
        const out = r && typeof r === 'object' && 'ok' in (r as object)
          ? (r as { value?: unknown }).value
          : r
        noteTtsStatus(out as { server?: string; engine?: string } | null)
      }).catch(() => { /* status is cosmetic */ })
    } catch { /* status is cosmetic */ }
  }
  void pollTtsStatus()
  const statusTimer = setInterval(pollTtsStatus, 25_000)
  const ui = ctx.inject(['remote.speech', 'sessions', 'slots', 'locale', 'pluginNavigation'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); await disposeVoice(); throw error }
  return async () => { clearInterval(statusTimer); await ui.dispose(); await disposeRemote(); await disposeVoice() }
}
