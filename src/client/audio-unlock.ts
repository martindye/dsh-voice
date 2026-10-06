/**
 * Page-level media unlock for Safari/iOS (and any autoplay-gated browser).
 *
 * Safari keeps a page's audio locked until a real touch gesture happens, and
 * revokes it again when the screen locks. The reply auto-read arrives on its
 * own (no tap behind it), so a refresh -> speak -> reply cycle can land while
 * the page is still locked: the wav renders fine on the host but plays back
 * silent, and the speaker button prints its red "audio is blocked by the
 * phone" note.
 *
 * The voice composer is the first thing the user touches on the page, so this
 * plugin takes the unlock on his behalf: the first gesture anywhere grants
 * the page, and every later tap (voice button, kit button, anything) re-arms
 * it right before a reply is due. The unlock is a one-sample silent buffer
 * through a shared context — the canonical iOS unlock — and idempotent once
 * the context is running.
 */
let shared: AudioContext | null = null
let installed = false

function contextCtor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null
  const ctor = (window.AudioContext
    ?? (window as Window & { webkitAudioContext?: new () => AudioContext }).webkitAudioContext)
  return ctor ?? null
}

/** The shared AudioContext (created lazily; null without WebAudio). */
export function getSharedAudioContext(): AudioContext | null {
  const ctor = contextCtor()
  if (!ctor) return null
  try {
    if (!shared) shared = new ctor()
  } catch { shared = null }
  return shared
}

/** Grant (or re-grant) page media playback. Best-effort; safe to call often. */
export function unlockPageAudio(): void {
  const ctor = contextCtor()
  if (!ctor) return
  try {
    if (!shared) shared = new ctor()
    if (shared.state === 'running') return
    // Resume and push one inaudible sample through: the context may take a
    // tick to flip, and the sample proves the output path the moment it does.
    void shared.resume().catch(() => { /* a later gesture retries */ })
    const sample = shared.createBuffer(1, 1, 22050)
    const source = shared.createBufferSource()
    source.buffer = sample
    source.connect(shared.destination)
    source.start()
  } catch { /* best effort: a host without WebAudio simply has nothing to unlock */ }
}

/**
 * Arm the one-per-page gesture listeners. Call once at plugin mount; safe to
 * call again (the listeners are not duplicated).
 */
export function armPageAudioUnlock(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const options: AddEventListenerOptions = { capture: true, passive: true }
  document.addEventListener('pointerdown', unlockPageAudio, options)
  document.addEventListener('touchstart', unlockPageAudio, options)
  document.addEventListener('keydown', unlockPageAudio, options)
}
