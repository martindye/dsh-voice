// @vitest-environment jsdom
/** One button: text send, stop, and voice turns that submit — no dictation mode. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SpeechPreparationState, SpeechProviderId, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceInput, type VoiceInputProps } from '../src/client/VoiceInput.tsx'
import { RecordingError, Recording } from '../src/client/audio.ts'
import type { SpeechReadiness } from '../src/client/readiness.ts'
import { zh } from '../src/client/locales.ts'
import { captureFixture } from './audio-fixture.client.ts'

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn()) })
afterEach(() => { cleanup(); document.querySelector('[data-composer-card]')?.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
const id = 'sensevoice-local' as SpeechProviderId
const transcript: Transcript = { text: '检查 TypeScript 类型', audioSeconds: 2, inferenceSeconds: 0.4 }
function fixture(extra: Partial<VoiceInputProps> = {}) {
  const capture = Object.assign(new Recording(() => {}), { start: vi.fn<Recording['start']>(async () => {}), stop: vi.fn(async () => new Uint8Array(48)),
    amplitude: vi.fn(() => 0), dispose: vi.fn(async () => {}) })
  const inputActions = { notify: vi.fn(), captureInsertion: vi.fn(() => ({ start: 3, end: 3, draftRev: 1 })), insertText: vi.fn(() => true),
    setDraft: vi.fn(), addAttachments: vi.fn(() => true), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit: vi.fn() }
  const readiness = createSnapshotStore<SpeechReadiness>({ connected: true, error: null, catalog: {
    providers: [{ id, name: 'SenseVoiceSmall', location: 'host-local', languages: ['auto', 'zh', 'en', 'ja'], preparation: { phase: 'ready' } }],
    selection: { providerId: id, language: 'auto' }, maxAudioBytes: 100, maxDurationSeconds: 120,
  } })
  const transcribe = vi.fn<(request: unknown, signal: AbortSignal) => Promise<RemoteResult<Transcript>>>(
    async () => ({ ok: true, value: transcript }))
  // The session's turn state is a mutable snapshot the tests flip between renders.
  const snapshot = { running: false }
  const useSession = ((selector: (value: { running: boolean }) => unknown) => selector(snapshot)) as unknown as VoiceInputProps['useSession']
  const stopTurn = vi.fn()
  // The composer as the host app renders it: a card wrapping the contenteditable input.
  document.querySelector('[data-composer-card]')?.remove()
  const card = document.createElement('div'); card.setAttribute('data-composer-card', '')
  const input = document.createElement('div'); input.setAttribute('data-composer-input', ''); input.setAttribute('contenteditable', 'true')
  card.append(input); document.body.append(card)
  const props: VoiceInputProps = { sessionId: 'one' as SessionId, inputActions, transcribe, locked: false, onActiveChange: vi.fn(),
    useSession, stopTurn,
    openSettings: vi.fn(), prepare: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}), configure: vi.fn(async () => {}),
    useSpeechReadiness: bindSnapshotSelector(readiness), createRecording: () => capture,
    t: makeTranslate(zh, commonZh), ...extra }
  const view = render(<VoiceInput {...props} />)
  return { props, capture, inputActions, readiness, transcribe, view, snapshot, stopTurn, composer: { card, input } }
}
async function start(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await screen.findByRole('button', { name: zh['voiceChat.stop'] })
}
function stop(): void { fireEvent.click(screen.getByRole('button', { name: zh['voiceChat.stop'] })) }

it('starts a voice turn, stops it, and submits the transcript as a message', async () => {
  const b = fixture()
  fireEvent.mouseEnter(screen.getByRole('button', { name: zh.start }).parentElement!)
  expect(screen.getByRole('tooltip').textContent).toBe('听写')
  fireEvent.mouseDown(screen.getByRole('button', { name: zh.start }))
  await start()
  // A live turn keeps the composer intact: only the button swaps to the
  // cross, so the slot never claims the toolbar for itself.
  expect(b.props.onActiveChange).not.toHaveBeenCalledWith(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  stop()
  await waitFor(() => {
    expect(b.inputActions.setDraft).toHaveBeenCalledWith(transcript.text)
    expect(b.inputActions.submit).toHaveBeenCalled()
  })
  await waitFor(() => { expect(b.props.onActiveChange).toHaveBeenLastCalledWith(false) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('releases a recording without transcription on escape', async () => {
  const b = fixture()
  await start()
  fireEvent.keyDown(document, { key: 'Escape' })
  await screen.findByRole('button', { name: zh.start })
  expect(b.capture.dispose).toHaveBeenCalled()
  expect(b.transcribe).not.toHaveBeenCalled()
  expect(b.inputActions.submit).not.toHaveBeenCalled()
})

it.each(['blur', 'hidden'])('pauses a live recording on %s and resumes it on focus', async (how) => {
  const b = fixture()
  await start()
  if (how === 'blur') fireEvent.blur(window)
  else {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    fireEvent(document, new Event('visibilitychange'))
  }
  // Focus loss no longer kills the turn (it flickered the buttons on phones):
  // the cross stays on screen and nothing is released.
  expect(screen.getByRole('button', { name: zh['voiceChat.stop'] })).toBeTruthy()
  expect(b.capture.dispose).not.toHaveBeenCalled()
  // Focus returns and the turn is still live: it can still transcribe and send.
  if (how === 'blur') fireEvent.focus(window)
  else {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    fireEvent(document, new Event('visibilitychange'))
    delete (document as { hidden?: boolean }).hidden
  }
  stop()
  await waitFor(() => {
    expect(b.inputActions.setDraft).toHaveBeenCalledWith(transcript.text)
    expect(b.inputActions.submit).toHaveBeenCalled()
  })
})

it('cancels a pending permission request from the button', async () => {
  const b = fixture()
  const permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  const cancel = screen.getByRole('button', { name: zh.cancel })
  expect(b.inputActions.notify).not.toHaveBeenCalled()
  fireEvent.click(cancel)
  permission.resolve(undefined)
  await act(async () => {})
  expect(b.capture.dispose).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: zh['voiceChat.stop'] })).toBeNull()
})

it('invalidates permission settlement after cancel (failure=%s)', async () => {
  const b = fixture()
  const permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  permission.reject(new Error('permission closed'))
  await act(async () => {})
  expect(b.capture.dispose).toHaveBeenCalled()
  expect(b.inputActions.notify).not.toHaveBeenCalled()
  expect(screen.queryByText('permission closed')).toBeNull()
})

it('keeps the selection fixed when the preference changes mid-turn and still sends', async () => {
  const b = fixture()
  await start()
  const state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, selection: { providerId: id, language: 'en' } } }) })
  stop()
  await waitFor(() => {
    expect(b.transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'auto' }), expect.any(AbortSignal))
    expect(b.inputActions.setDraft).toHaveBeenCalledWith(transcript.text)
    expect(b.inputActions.submit).toHaveBeenCalled()
  })
  expect(b.inputActions.insertText).not.toHaveBeenCalled()
})

it.each(['transcription', 'conversion', 'failed conversion'])('discards late %s after switching Sessions', async (phase) => {
  const b = fixture()
  const result = Promise.withResolvers<RemoteResult<Transcript>>()
  const conversion = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
  if (phase === 'transcription') b.transcribe.mockReturnValueOnce(result.promise)
  else b.capture.stop.mockReturnValueOnce(conversion.promise)
  await start(); stop()
  await act(async () => {})
  b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  if (phase === 'transcription') result.resolve({ ok: true, value: transcript })
  else if (phase === 'conversion') conversion.resolve(new Uint8Array(48))
  else conversion.reject(new Error('cancelled'))
  await act(async () => {})
  expect(b.inputActions.setDraft).not.toHaveBeenCalled()
  expect(b.inputActions.submit).not.toHaveBeenCalled()
  expect(b.inputActions.notify).not.toHaveBeenCalled()
})

it('settles empty speech quietly and keeps service errors inside the toolbar', async () => {
  const b = fixture()
  b.transcribe.mockResolvedValueOnce({ ok: true, value: { ...transcript, text: '' } })
  await start(); stop()
  // A wordless tap settles quietly: both buttons come back, no status row.
  await screen.findByRole('button', { name: zh.start })
  expect(screen.queryByRole('status')).toBeNull()
  expect(b.inputActions.notify).not.toHaveBeenCalled()
  b.transcribe.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await screen.findByRole('button', { name: zh['voiceChat.stop'] })
  stop()
  await screen.findByText('语音识别失败：offline')
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(screen.getByRole('button', { name: zh.start })).toBeTruthy()
})

it.each([new RecordingError('permission'), new Error('device lost'), 'device lost'])('handles capture failure locally (%s)', async (failure) => {
  const b = fixture()
  b.capture.start.mockRejectedValueOnce(failure)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await screen.findByText(failure instanceof RecordingError ? zh.permission : '语音识别失败：device lost')
  expect(b.inputActions.notify).not.toHaveBeenCalled()
})

it.each([new Error('decode failed'), 'decode failed'])('handles conversion failure locally (%s)', async (failure) => {
  const b = fixture()
  b.capture.stop.mockRejectedValueOnce(failure)
  await start(); stop()
  await screen.findByText('语音识别失败：decode failed')
  expect(b.capture.dispose).toHaveBeenCalledOnce()
  expect(b.inputActions.insertText).not.toHaveBeenCalled()
  expect(b.inputActions.submit).not.toHaveBeenCalled()
})

it('settles quietly when a fully muted microphone captures nothing', async () => {
  const b = fixture()
  b.capture.stop.mockRejectedValueOnce(new RecordingError('empty'))
  await start(); stop()
  // Nothing was ever captured: no error row, the buttons simply come back.
  await screen.findByRole('button', { name: zh.start })
  expect(screen.queryByRole('status')).toBeNull()
  expect(b.capture.dispose).toHaveBeenCalledOnce()
  expect(b.inputActions.submit).not.toHaveBeenCalled()
})

it('bounds recordings and cancels an in-flight transcription', async () => {
  const b = fixture()
  const result = Promise.withResolvers<RemoteResult<Transcript>>()
  b.transcribe.mockReturnValueOnce(result.promise)
  // The mic is voiced for the whole recording, so voice-activity stays quiet
  // and the max-duration timer — not the silence cancel — is what ends it.
  ;(b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude.mockReturnValue(0.2)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: zh.start })); await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(b.capture.stop).toHaveBeenCalledWith(120)
  expect(screen.getByRole('button', { name: zh.transcribingShort })).toBeTruthy()
  expect(b.transcribe.mock.calls[0]?.[1].aborted).toBe(false)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(b.transcribe.mock.calls[0]?.[1].aborted).toBe(true)
  result.resolve({ ok: true, value: transcript }); await act(async () => {})
  expect(b.inputActions.submit).not.toHaveBeenCalled()
})

it('rejects excessive audio and keeps locked recognition disabled', async () => {
  const b = fixture()
  b.capture.stop.mockResolvedValueOnce(new Uint8Array(101))
  await start(); stop(); await screen.findByText(zh.tooLarge)
  expect(b.transcribe).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  act(() => { b.readiness.set({ catalog: null, connected: false, error: null }) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['setupPrompt.trigger'] }).disabled).toBe(false)
  b.view.rerender(<VoiceInput {...b.props} locked />)
  const locked = screen.getByRole<HTMLButtonElement>('button', { name: zh['setupPrompt.trigger'] })
  expect(locked.disabled).toBe(true)
  fireEvent.click(locked)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.capture.start).toHaveBeenCalledOnce()
})

it('releases expansion and contains cleanup failures on unmount', async () => {
  const b = fixture()
  fireEvent.keyDown(document, { key: 'x' }); fireEvent.blur(window); fireEvent(document, new Event('visibilitychange'))
  await start()
  b.capture.dispose.mockRejectedValueOnce(new Error('already closed'))
  b.view.unmount(); await act(async () => {})
  expect(b.props.onActiveChange).toHaveBeenLastCalledWith(false)
  expect(b.capture.dispose).toHaveBeenCalledOnce()
})

it('coalesces repeated capture and stop clicks before the toolbar rerenders', async () => {
  const b = fixture()
  const microphone = screen.getByRole<HTMLButtonElement>('button', { name: zh.start })
  act(() => { microphone.click(); microphone.click() })
  const stopButton = await screen.findByRole<HTMLButtonElement>('button', { name: zh['voiceChat.stop'] })
  act(() => { stopButton.click(); stopButton.click() })
  await waitFor(() => { expect(b.inputActions.submit).toHaveBeenCalledOnce() })
  expect(b.capture.start).toHaveBeenCalledOnce()
  expect(b.capture.stop).toHaveBeenCalledOnce()
})

it('ends the recording UI immediately on a device failure and clears automatic transcription', async () => {
  const devices = captureFixture(), b = fixture()
  const closing = Promise.withResolvers<undefined>()
  const recording = devices.recording
  const originalCreate = b.props.createRecording
  void originalCreate
  b.view.rerender(<VoiceInput {...b.props} createRecording={() => recording} />)
  devices.close.mockReturnValueOnce(closing.promise)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fireEvent.click(screen.getByRole('button', { name: zh.start }))
    await act(async () => {})
    expect(screen.getByRole('button', { name: zh['voiceChat.stop'] })).toBeTruthy()
    act(() => { devices.failRecorder() })
    expect(screen.queryByRole('button', { name: zh['voiceChat.stop'] })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.interrupted)
    expect(devices.disposed).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
    expect(b.transcribe).not.toHaveBeenCalled()
    expect(b.inputActions.notify).not.toHaveBeenCalled()
  } finally { closing.resolve(undefined); await recording.dispose() }
})

it.each(['cancel', 'session', 'unmount', 'finishing', 'finished'])('ignores interruption notifications after %s', async (action) => {
  const b = fixture()
  await start()
  const failed = b.capture.start.mock.calls[0]![0]!
  if (action === 'cancel') fireEvent.keyDown(document, { key: 'Escape' })
  if (action === 'session') b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  if (action === 'unmount') b.view.unmount()
  const pending = Promise.withResolvers<RemoteResult<Transcript>>()
  if (action === 'finishing') b.transcribe.mockReturnValueOnce(pending.promise)
  if (action === 'finishing' || action === 'finished') { stop(); await act(async () => {}) }
  try {
    act(() => { failed(new RecordingError('interrupted')) })
    expect(screen.queryByText(zh.interrupted)).toBeNull()
    expect(b.inputActions.notify).not.toHaveBeenCalled()
  } finally { pending.resolve({ ok: true, value: transcript }); await act(async () => {}) }
})

it('does not restore recording when capture reports failure before start settles', async () => {
  const b = fixture()
  b.capture.start.mockImplementationOnce(async (failed) => { failed!(new RecordingError('interrupted')) })
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toBe(zh.interrupted)
  expect(screen.queryByRole('button', { name: zh['voiceChat.stop'] })).toBeNull()
  expect(b.transcribe).not.toHaveBeenCalled()
})

it('allows recording while verified local resources are waking', async () => {
  const b = fixture()
  const state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation: { phase: 'waking', startedAt: 0 } },
  ] } }) })
  await start()
  stop()
  await waitFor(() => {
    expect(b.inputActions.setDraft).toHaveBeenCalledWith(transcript.text)
    expect(b.inputActions.submit).toHaveBeenCalled()
  })
})

it('keeps the first recording after the permission prompt causes window blur', async () => {
  const b = fixture()
  const permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  fireEvent.blur(window)
  expect(screen.getByRole('button', { name: zh.cancel })).toBeTruthy()
  expect(b.capture.dispose).not.toHaveBeenCalled()
  permission.resolve(undefined)
  await screen.findByRole('button', { name: zh['voiceChat.stop'] })
  stop()
  await waitFor(() => {
    expect(b.inputActions.setDraft).toHaveBeenCalledWith(transcript.text)
    expect(b.inputActions.submit).toHaveBeenCalled()
  })
})

it.each(['escape', 'hidden', 'session'])('discards pending permission after %s', async (action) => {
  const b = fixture()
  const permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  if (action === 'session') b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  if (action === 'hidden') {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try { fireEvent(document, new Event('visibilitychange')) } finally { delete (document as { hidden?: boolean }).hidden }
  }
  permission.resolve(undefined)
  await act(async () => {})
  expect(b.capture.dispose).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: zh.start })).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['voiceChat.stop'] })).toBeNull()
  expect(b.transcribe).not.toHaveBeenCalled()
})

it('offers installation on click without a preparation tooltip', () => {
  const b = fixture()
  const state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation: { phase: 'unprepared' } },
  ] } }) })
  const mic = screen.getByRole<HTMLButtonElement>('button', { name: zh['setupPrompt.trigger'] })
  expect(mic.disabled).toBe(false)
  expect(mic.getAttribute('aria-haspopup')).toBe('dialog')
  fireEvent.mouseEnter(mic.parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(mic)
  expect(screen.getByRole('dialog').textContent).toContain(zh['setupPrompt.body'])
  expect(b.capture.start).not.toHaveBeenCalled()
  expect(b.props.prepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.open'] }))
  expect(b.props.openSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each<SpeechPreparationState>([
  { phase: 'checking', step: 'check', startedAt: 0 },
  { phase: 'downloading', resource: 'model', completedBytes: 0 },
  { phase: 'failed', message: 'download failed' },
  { phase: 'cancelled' },
])('guides $phase recognition to its status page without starting recording or preparation', (preparation) => {
  const b = fixture()
  const state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation },
  ] } }) })
  fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
  expect(screen.getByRole('dialog').textContent).toContain(zh['setupPrompt.unavailableBody'])
  expect(screen.queryByText(zh['setupPrompt.body'])).toBeNull()
  expect(b.capture.start).not.toHaveBeenCalled()
  expect(b.props.prepare).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh['setupPrompt.details'] }))
  expect(b.props.openSettings).toHaveBeenCalledOnce()
})

it('moves focus into setup guidance, contains Tab traversal, and restores the draft focus on dismissal', () => {
  const b = fixture()
  render(<textarea aria-label="draft" defaultValue="Keep this draft" />)
  const draft = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'draft' })
  act(() => { b.readiness.set({ catalog: null, connected: false, error: 'offline' }) })
  draft.focus()
  const mic = screen.getByRole('button', { name: zh['setupPrompt.trigger'] })
  fireEvent.mouseDown(mic)
  fireEvent.click(mic)
  const dialog = screen.getByRole('dialog')
  const details = within(dialog).getByRole('button', { name: zh['setupPrompt.details'] })
  const close = within(dialog).getByRole('button', { name: zh.cancel })
  expect(document.activeElement).toBe(details)
  fireEvent.keyDown(details, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(details)
  fireEvent.keyDown(details, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(draft)
  expect(draft.value).toBe('Keep this draft')
  expect(b.inputActions.submit).not.toHaveBeenCalled()
  expect(b.props.openSettings).not.toHaveBeenCalled()
})

it.each(['later', 'escape', 'ready', 'session'])('dismisses unavailable recognition guidance on %s without changing the draft', (reason) => {
  const b = fixture()
  const ready = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ catalog: null, connected: false, error: 'offline' }) })
  const open = () => { fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] })) }
  open()
  expect(screen.getByRole('dialog').textContent).toContain(zh['setupPrompt.unavailableTitle'])
  if (reason === 'later') fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.later'] }))
  if (reason === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  if (reason === 'ready') act(() => { b.readiness.set(ready) })
  if (reason === 'session') b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.props.openSettings).not.toHaveBeenCalled()
  expect(b.capture.start).not.toHaveBeenCalled()
  expect(b.inputActions.setDraft).not.toHaveBeenCalled()
  if (reason === 'ready') {
    act(() => { b.readiness.set({ ...ready, connected: false }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  } else {
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()
  }
})

it('sends text from the unified button when the draft is not empty', async () => {
  const b = fixture()
  b.composer.input.textContent = 'hello'
  const send = await screen.findByRole('button', { name: zh.send })
  expect(send.disabled).toBe(false)
  fireEvent.click(send)
  expect(b.inputActions.submit).toHaveBeenCalledOnce()
  expect(b.inputActions.setDraft).not.toHaveBeenCalled()
})

it('shows the voice-chat entry on an empty draft and starts a turn from it', async () => {
  fixture()
  const voice = screen.getByRole<HTMLButtonElement>('button', { name: zh['voiceChat.start'] })
  expect(voice.disabled).toBe(false)
  fireEvent.click(voice)
  await screen.findByRole('button', { name: zh['voiceChat.stop'] })
})

it('stops the running turn from the unified button and ignores the draft', async () => {
  const b = fixture()
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  const stopButton = screen.getByRole('button', { name: zh.stopGenerating })
  fireEvent.click(stopButton)
  expect(b.stopTurn).toHaveBeenCalledTimes(1)
  expect(b.inputActions.submit).not.toHaveBeenCalled()
})

it('steers a running turn with the draft instead of stopping it', async () => {
  const b = fixture()
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  b.composer.input.textContent = 'hello'
  const send = await screen.findByRole('button', { name: zh.send })
  fireEvent.click(send)
  expect(b.inputActions.submit).toHaveBeenCalledOnce()
  expect(b.stopTurn).not.toHaveBeenCalled()
})

/** Complete one voice turn (speak, pause, auto-send) so continuous listening is armed. */
async function completeVoiceTurn(b: {
  capture: { amplitude: ReturnType<typeof vi.fn> }
  inputActions: { submit: ReturnType<typeof vi.fn> }
}): Promise<void> {
  b.capture.amplitude.mockReturnValue(0.2)
  await start()
  await new Promise((resolve) => { setTimeout(resolve, 500) })
  b.capture.amplitude.mockReturnValue(0.0001)
  await waitFor(() => { expect(b.inputActions.submit).toHaveBeenCalled() }, { timeout: 6000 })
}

it('reopens the microphone when a reply ends so the conversation continues', async () => {
  const b = fixture()
  const amplitude = (b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude
  await completeVoiceTurn({ capture: { amplitude }, inputActions: b.inputActions })
  // The reply: the agent runs, then finishes without speaking (device muted).
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  await screen.findByRole('button', { name: zh.stopGenerating })
  b.snapshot.running = false
  b.view.rerender(<VoiceInput {...b.props} />)
  // The microphone reopens on its own a beat later — no tap required.
  await screen.findByRole('button', { name: zh['voiceChat.stop'] }, { timeout: 8000 })
}, 15000)

it('does not reopen the microphone while a draft is being typed', async () => {
  const b = fixture()
  const amplitude = (b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude
  await completeVoiceTurn({ capture: { amplitude }, inputActions: b.inputActions })
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  b.composer.input.textContent = 'typing'
  b.snapshot.running = false
  b.view.rerender(<VoiceInput {...b.props} />)
  await new Promise((resolve) => { setTimeout(resolve, 4000) })
  expect(screen.queryByRole('button', { name: zh['voiceChat.stop'] })).toBeNull()
  expect(screen.getByRole('button', { name: zh.send })).toBeTruthy()
}, 15000)

it('does not reopen the microphone after an auto-opened turn is closed', async () => {
  const b = fixture()
  const amplitude = (b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude
  await completeVoiceTurn({ capture: { amplitude }, inputActions: b.inputActions })
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  b.snapshot.running = false
  b.view.rerender(<VoiceInput {...b.props} />)
  await screen.findByRole('button', { name: zh['voiceChat.stop'] }, { timeout: 8000 })
  fireEvent.keyDown(document, { key: 'Escape' })
  await screen.findByRole('button', { name: zh['voiceChat.start'] })
  // An explicit cancel (Escape) ends the listening loop: no re-offer.
  await new Promise((resolve) => { setTimeout(resolve, 4000) })
  expect(screen.queryByRole('button', { name: zh['voiceChat.stop'] })).toBeNull()
  expect(screen.getByRole('button', { name: zh['voiceChat.start'] })).toBeTruthy()
}, 15000)

it('re-offers the microphone after an auto-opened turn settles without words', async () => {
  const b = fixture()
  const amplitude = (b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude
  await completeVoiceTurn({ capture: { amplitude }, inputActions: b.inputActions })
  // The reply ends: the microphone reopens on its own (auto-open number one).
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  b.snapshot.running = false
  b.view.rerender(<VoiceInput {...b.props} />)
  await screen.findByRole('button', { name: zh['voiceChat.stop'] }, { timeout: 8000 })
  // It draws no words, settles quietly, and is offered again on its own
  // (auto-open number two) instead of ending the conversation.
  await waitFor(() => { expect(b.capture.start).toHaveBeenCalledTimes(3) }, { timeout: 30000 })
}, 40000)

it('settles an auto-opened turn quietly when the transcript is empty', async () => {
  const b = fixture()
  const amplitude = (b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude
  await completeVoiceTurn({ capture: { amplitude }, inputActions: b.inputActions })
  // The reply ends: the microphone reopens on its own (auto-open number one).
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  b.snapshot.running = false
  b.view.rerender(<VoiceInput {...b.props} />)
  await screen.findByRole('button', { name: zh['voiceChat.stop'] }, { timeout: 8000 })
  // Room noise wakes the voice activity, the recognizer still hears no words.
  b.transcribe.mockResolvedValueOnce({ ok: true, value: { text: '', audioSeconds: 1, inferenceSeconds: 0.1 } })
  amplitude.mockReturnValue(0.2)
  await new Promise((resolve) => { setTimeout(resolve, 400) })
  amplitude.mockReturnValue(0.0001)
  // It settles quietly and is offered again — no "no speech" row, no dead end.
  await waitFor(() => { expect(b.capture.start).toHaveBeenCalledTimes(3) }, { timeout: 20000 })
  expect(screen.queryByText(zh.empty)).toBeNull()
}, 40000)

it('settles a tapped turn quietly when it catches no words', async () => {
  const b = fixture()
  b.transcribe.mockResolvedValueOnce({ ok: true, value: { text: '', audioSeconds: 1, inferenceSeconds: 0.1 } })
  await start()
  // Stop straight away, before a word has been caught: both buttons come back,
  // no "no speech" row, nothing sent.
  fireEvent.click(screen.getByRole('button', { name: zh['voiceChat.stop'] }))
  await screen.findByRole('button', { name: zh['voiceChat.start'] }, { timeout: 8000 })
  expect(screen.queryByText(zh.empty)).toBeNull()
  expect(b.inputActions.submit).not.toHaveBeenCalled()
}, 15000)

it('mutes and unmutes the microphone mid-turn without ending it', async () => {
  const b = fixture()
  b.capture.setMuted = vi.fn()
  await start()
  fireEvent.click(screen.getByRole('button', { name: zh.muteMic }))
  expect(b.capture.setMuted).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: zh.unmuteMic }))
  expect(b.capture.setMuted).toHaveBeenLastCalledWith(false)
  // The voice turn itself is untouched: the cross is still on duty.
  expect(screen.getByRole('button', { name: zh['voiceChat.stop'] })).toBeTruthy()
}, 15000)

it('parks listening on "hold the mic" without sending, and a tap resumes', async () => {
  const b = fixture()
  b.transcribe.mockResolvedValueOnce({ ok: true, value: { text: 'Hold the mic', audioSeconds: 1, inferenceSeconds: 0.2 } })
  await start()
  stop()
  await screen.findByText(zh.listeningPaused)
  expect(b.inputActions.submit).not.toHaveBeenCalled()
  // The retry microphone is a deliberate tap: it resumes the parked loop.
  fireEvent.click(screen.getByRole('button', { name: zh.retryRecording }))
  await screen.findByRole('button', { name: zh['voiceChat.stop'] }, { timeout: 8000 })
}, 15000)

it('ends the turn on its own after a pause following speech and sends it', async () => {
  const b = fixture()
  const amplitude = (b.capture as unknown as { amplitude: ReturnType<typeof vi.fn> }).amplitude
  amplitude.mockReturnValue(0.2)
  await start()
  // A few ticks of voice, then silence: the turn must finish and send itself.
  await new Promise((resolve) => { setTimeout(resolve, 700) })
  amplitude.mockReturnValue(0.0001)
  await waitFor(() => { expect(b.transcribe).toHaveBeenCalled() }, { timeout: 6000 })
  await waitFor(() => {
    expect(b.inputActions.setDraft).toHaveBeenCalledWith(transcript.text)
    expect(b.inputActions.submit).toHaveBeenCalled()
  })
})

// The dsh-voice-output plugin marks the message it is reading with a speaker
// button whose aria-label is exactly "Stop speaking"; that is the speaking signal.
function fakeSpeech(): { speaker: HTMLButtonElement; clicks: ReturnType<typeof vi.fn>; cleanup: () => void } {
  const speaker = document.createElement('button')
  speaker.setAttribute('aria-label', 'Stop speaking')
  const clicks = vi.fn()
  speaker.addEventListener('click', clicks)
  document.body.appendChild(speaker)
  return { speaker, clicks, cleanup: () => { document.body.removeChild(speaker) } }
}

it('shows the stop square while the system speaks and stops the speech from it', async () => {
  const b = fixture()
  const speech = fakeSpeech()
  try {
    const stopButton = await screen.findByRole('button', { name: zh.stopSpeech })
    fireEvent.click(stopButton)
    expect(speech.clicks).toHaveBeenCalledOnce()
    expect(b.stopTurn).not.toHaveBeenCalled()
    expect(b.inputActions.submit).not.toHaveBeenCalled()
  } finally { speech.cleanup() }
})

it('stops both the turn and the speech when both are active', async () => {
  const b = fixture()
  b.snapshot.running = true
  b.view.rerender(<VoiceInput {...b.props} />)
  const speech = fakeSpeech()
  try {
    const stopButton = await screen.findByRole('button', { name: zh.stopGenerating })
    fireEvent.click(stopButton)
    expect(b.stopTurn).toHaveBeenCalledTimes(1)
    expect(speech.clicks).toHaveBeenCalledOnce()
  } finally { speech.cleanup() }
})

it('prefers the send arrow over the speech stop while typing', async () => {
  const b = fixture()
  b.composer.input.textContent = 'typing'
  const speech = fakeSpeech()
  try {
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.send })).toBeTruthy() })
    expect(screen.queryByRole('button', { name: zh.stopSpeech })).toBeNull()
  } finally { speech.cleanup() }
})
