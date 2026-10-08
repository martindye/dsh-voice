# TO-DO — voice + app polish

Held until Martin says go (the stop-button item was unlocked with
"bingo" on 08/10; the loading-history item waits for a plain "ready").

## 1. Stop button turns grey just before thinking starts — DONE (d6e9899, 08/10)
- Root cause found: the grey was the transcribing window (words final, STT
  running — the last visible state before a reply starts). The button was
  `disabled` there, and its click handler had no branch for the phase, so it
  was a dead, pale-blue circle. Fix: the button is now live in every phase;
  a press cancels the pending permission request or the in-flight
  transcription (generation bump + abort discards the result pre-submit,
  which is always safe — the words are final by then).
- The submitted-turn seam was re-checked and is clean: `stop` is defined in
  the same render as `running` (VoiceInput.tsx), so the stop square never
  loses to a disabled state after submit.

## 2. UI stuck on "loading history" while the agent thinks
- Confirmed a DSH (harness) issue, not the plugin: the string and state
  machine live in their ui-chat (ChatView.tsx, chat.loadingHistory) and
  session-controller packages (openState 'loading' until events.open()
  resolves).
- Still present at upstream HEAD (477b4f4205, RC 0.1.7-rc.2 — the running
  build). Reported upstream in GitHub Discussions (issues are DISABLED on
  the repo, as are PRs — verified via the GitHub API on 08/10):
  - discussion #7802 — root cause + community patch (the one to build on)
  - discussion #6921 — openState=loading render loop
  - discussion #6520 — known-unfixed list, discussion #5487, #5677, #2119
- Route: post a fix as a Discussion (like #7802 did); if they re-enable PRs
  it converts to one in one step.
- Status: ON HOLD (waits for "ready").
