/** Browser entry for the optional speech Remote contribution and composer control. */
import type { Context } from '@deepseek-ai/cordis'
import speechRemote from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
import { mountVoiceInput } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the experimental microphone contribution.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  try {
    return await mountVoiceInput(ctx, speechRemote)
  } catch (error) {
    // Surface the real boot failure in the page console (the loader only
    // reports "failed" for a failed entry, which is otherwise opaque).
    console.error('DSH_VOICE_APPLY_ERR', error)
    throw error
  }
}
