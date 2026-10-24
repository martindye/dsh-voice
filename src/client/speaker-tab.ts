/**
 * One speaker per browser: tabs of the same DSH web app in the same browser
 * elect a single auto-read speaker.
 *
 * After a reboot the browser restores every tab that was open, so two (or
 * more) tabs of the app can be alive at once — and each tab's speaker
 * button auto-reads, so the reply is spoken twice, overlapping. This module
 * elects exactly one tab per browser to perform the AUTO-read. The manual
 * speaker button is never gated: wherever Martin clicks it, it speaks.
 *
 * Mechanism: every tab announces itself over a BroadcastChannel every 2 s
 * (a BroadcastChannel reaches only other tabs of the SAME browser and
 * origin, which is exactly the group that can double-speak). Peers go stale
 * after 6 s of silence (the tab closed). The tab with the lowest live id
 * speaks; when it goes away the next-lowest id takes over automatically,
 * because the election is re-read from the live set on every decision.
 *
 * A freshly opened tab is silent until its election is settled (2.5 s, or as
 * soon as it hears a peer — whichever comes first), so two tabs that both
 * boot at once (the reboot case) can never both claim a brand-new reply.
 */

export interface SpeakerElection {
  /** True while this tab is the one that should perform the auto-read. */
  isSpeaker: () => boolean
  /** Announce this tab and drop peers that went silent. */
  beat: () => void
  /** Stop announcing (the tab is going away). */
  close: () => void
}

export interface SpeakerElectionOptions {
  /** Unique id of this tab (stable across reloads — see loadTabId). */
  id: string
  /** The channel to announce over; null/absent means "no other tabs can
   * exist", so this tab is always the speaker. */
  channel?: { postMessage: (msg: unknown) => void; close: () => void } | null
  /** Injectable clock (tests). */
  now?: () => number
  /** Start a real interval automatically (true for the app, false in tests). */
  timers?: boolean
}

const HEARTBEAT_MS = 2000
const EXPIRE_MS = 6000
/** A brand-new tab stays silent this long unless it hears a peer sooner. */
const SETTLE_MS = 2500

export function createSpeakerElection(opts: SpeakerElectionOptions): SpeakerElection {
  const now = opts.now ?? Date.now
  const { id, channel } = opts
  const peers = new Map<string, number>()
  let seenAnyPeer = false
  const bootAt = now()

  const beat = (): void => {
    if (channel) channel.postMessage(id)
    const t = now()
    for (const [pid, seen] of peers) {
      if (t - seen > EXPIRE_MS) peers.delete(pid)
    }
  }

  if (channel && 'onmessage' in channel) {
    const ch = channel as unknown as { onmessage: ((e: { data: unknown }) => void) | null }
    ch.onmessage = (e: { data: unknown }) => {
      const pid = typeof e.data === 'string' ? e.data : null
      if (!pid || pid === id) return
      seenAnyPeer = true
      peers.set(pid, now())
    }
  }

  let timer: { pause?: () => void } | null = null
  if (channel && (opts.timers ?? true) && typeof setInterval !== 'undefined') {
    // Announce immediately so a young tab is heard before its first beat.
    beat()
    timer = setInterval(beat, HEARTBEAT_MS)
  }

  const isSpeaker = (): boolean => {
    if (!channel) return true
    const t = now()
    // Unsettled: a young tab that has heard nobody yet may be one of several
    // that booted together — stay silent rather than risk a double read.
    if (!seenAnyPeer && t - bootAt < SETTLE_MS) return false
    for (const [pid, seen] of peers) {
      if (t - seen > EXPIRE_MS) peers.delete(pid)
    }
    if (peers.size === 0) return true
    const live = [id, ...peers.keys()].sort()
    return live[0] === id
  }

  const close = (): void => {
    if (timer && typeof clearInterval !== 'undefined') clearInterval(timer)
    timer = null
    if (channel) channel.close()
  }

  return { isSpeaker, beat, close }
}

/* The app-facing singleton. */

const CHANNEL_NAME = 'dsh-voice-speaker'
const TAB_ID_KEY = 'dsh-voice:tab-id'

/** Stable per tab across reloads (sessionStorage is per-tab). */
function loadTabId(): string {
  const fresh = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY)
    if (!id) {
      id = fresh()
      sessionStorage.setItem(TAB_ID_KEY, id)
    }
    return id
  } catch {
    return fresh() // private-mode sessionStorage
  }
}

let shared: SpeakerElection | null = null

export function speakerElection(): SpeakerElection {
  if (shared) return shared
  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null
  shared = createSpeakerElection({ id: loadTabId(), channel, timers: true })
  return shared
}

/** The single gate the auto-read path consults (manual reads skip this). */
export function isSpeakerTab(): boolean {
  try {
    return speakerElection().isSpeaker()
  } catch {
    return true // no channel support at all: assume a single tab
  }
}
