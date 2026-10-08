# TO-DO — voice + app polish

Held until Martin says go ("bingo" unlocks the stop-button item; the rest
waits for a plain "ready").

## 1. Stop button turns grey just before thinking starts
- The stop/cancel button fades to a pale, disabled-looking state the moment
  the agent starts thinking, but it must stay fully active: he has to be
  able to cancel mid-think.
- Suspect: the button's disabled/look styling keys off a state that flips
  during the gap between "message submitted" and "running" — the same seam
  as the earlier mode-drop fix (commit 1c271c3), a different symptom.
- Status: ON HOLD (keyword "bingo").

## 2. UI stuck on "loading history" while the agent thinks
- The DSH web app shows a "loading history" (or similar) state for the whole
  thinking duration instead of live content; it only clears when the reply
  finishes.
- Likely in the app shell / session-log rendering, not the dsh-voice plugin —
  locate in the deepseek-harness checkout when picked up.
- Status: ON HOLD.
