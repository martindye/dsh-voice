# dsh-voice

Martin's self-contained two-way voice plugin for the DSH web app: you speak,
the agent replies out loud, and the microphone keeps listening. Works on any
device the web app runs on (iPhone or PC).

A standalone fork of `@deepseek-ai/dsh-experimental-client-ui-voice-input`
(0.1.7-rc.2, from the deepseek-harness checkout), renamed `@martindye/dsh-voice`
and grown into the single voice plugin: composer in, speaker buttons and
auto-read out. The retired `dsh-voice-chat` kit and the old `dsh-voice-output`
plugin are both superseded by this repository.

## What it does

Input (the composer):

- The unified 34 px blue composer button: voice entry on an empty draft, send
  arrow while typing, stop square while the agent runs or the system speaks,
  cross while a voice turn is active.
- Continuous listening: after a reply ends the microphone reopens on its own;
  an auto-open that draws no words is quietly re-offered a few times.
- The spoken pause command ("hold the mic", "pause the mic", "stop
  listening") parks the listening loop without sending.
- In-call mute: while a voice turn is active the dictate button becomes a
  mute/unmute toggle (white on red while muted); muted audio never reaches
  the recognizer and the voice-activity clocks freeze.

Output (the speaker):

- A speaker button on every finalized assistant message (speak / stop).
- Auto-read: fresh replies (younger than 2 minutes) are read aloud on a
  device that (1) has the auto-read toggle on and (2) has used the voice
  composer on that device (`dsh.voice-chat.v1`). No PC-side bridge is
  involved — each device reads what it is shown.
- A per-device auto-read toggle in the session header corner (green dot when
  the device is voice-armed), persisted per browser.
- Text is resolved from the session log on the host and prepared for speech
  (code, links and markdown stripped) before synthesis.

## Layout

- `src/` — plugin source. `src/index.ts` (host entry), `src/tts-host.ts`
  (TTS supervision + speech preparation, host half), `src/client/` (browser
  half: composer, speaker button, header toggle, playback).
- `tts/` — the plugin's own TTS HTTP server (`server.py`) and its engines
  (`qwen3.py` GPU voice, `pocket.py` CPU fallback).
- `bin/tts-server.exe` — the bundled qwentts.cpp server for the qwen3 engine
  (adopts a compatible resident server on 127.0.0.1:8095 when present).
- `ref_voices/` — the reference voices the qwen3 engine clones from
  (`pocket`, `warm-brit`). Both are synthetic takes (Pocket TTS and a
  VoiceDesign take respectively) — no real person's voice is bundled; see
  `THIRD-PARTY.md` for the full attribution list.
- `lib/` — build output (`lib/index.js` node half, `lib/client.js` browser
  bundle). Gitignored; rebuild with `pnpm bundle`.
- `tests/` — vitest client tests (jsdom): the composer audio pipeline, the
  waveform, and the conversation simulation with its trace files.

## Building

```
pnpm install
pnpm bundle     # lib/index.js + lib/client.js
pnpm test       # vitest
```

The client bundle is a CJS closure factory registered with the host's module
loader under the package name; platform modules (react, primitives, slots,
gateway) stay externals, everything else inlines. CSS modules are compiled
with lightningcss and injected as self-managed style tags.

## Runtime requirements (the machine running DSH)

- Python 3 on PATH (override with `DSH_VOICE_PYTHON`) with `numpy` and
  `requests`; add `pocket-tts` for the CPU fallback engine. The server is
  spawned on demand at `127.0.0.1:8189` (override the port with
  `DSH_VOICE_TTS_PORT`) and supervised by the plugin host.
- qwen3 (GPU) models under `~/.dsh/voice-chat/models/qwen3` (talker +
  tokenizer GGUFs); the engine choice is the shared consent file
  `~/.dsh/voice-chat/consent.json` (`"engine": "qwen3" | "pocket"`), default
  qwen3 when its models are present.
- Host log: `~/.dsh/logs/voice-tts.log`.

With Pocket selected, only the CPU engine is warmed when the TTS server starts.
A failed Pocket request does not fall back to a GPU engine. Selecting qwen3
still enables the GPU engine and retains its CPU fallback. The host passes the
selected registry name through `VOICE_CHAT_PRELOAD_ENGINE`; a standalone server
or an older host defaults its warm-up to Pocket. GPU requests remain available
on demand. Run `python -m unittest discover -s tests -p 'test_tts_server.py'`
for the model-free startup and fallback checks.

## Installing

From npm (the published package ships prebuilt `lib/` — no build step, no
build-script permission needed):

```sh
dsh plugin --profile <profile> add @martindye/dsh-voice
```

for example `dsh plugin --profile web add @martindye/dsh-voice` for the web
app. Then restart the web host (or start it) and open the app: the unified
voice button appears in the composer, and a speaker button on every finalized
message.

Requirements: DSH 0.1.7+ (web app), Node 22+ on the host, and Python 3 with
the TTS engine dependencies for the spoken replies (see `tts/`); the browser
needs microphone permission for dictation, and the speech-to-text models are
fetched on first use under the DSH home.

## How the bundle works

The package declares a `dsh.bundle` with `cordis.patch.yml`. Adding the
bundle to a profile's bundles list (the web profile does this in its
`package.json`) inserts:

- `ui-voice` — this plugin,
- the speech-to-text stack (`speech-to-text` with `sensevoice-local` as
  default provider and language `en`, `speech-to-text-sensevoice` with
  `dataRoot` at the DSH home `speech-to-text/sensevoice`, and
  `api-speech-to-text`),

and disables the upstream `ui-voice-input` row. The three `@deepseek-ai/
dsh-experimental-*speech-to-text*` packages must be installed in the same
profile (the web profile links them from the deepseek-harness checkout).

`lib/` is not committed to git (it is included in the npm tarball); run
`pnpm bundle` after pulling when working from a checkout. A page refresh
picks up the client; the host half needs a web-host restart.

## Changelog (the 10 latest updates, as of 24/10)

Each entry is the npm version it ships in, with that version's publish
date (1.0.5 is staged and awaits approval, so it carries its latest
date for now).

- 1.0.5 (24/10) — Two new settings in the settings card: the auto-read
  freshness cutoff (how old a reply may be and still be read on auto,
  30 s to 10 min) and the pause that ends dictation (1 to 10 seconds of
  silence, defaulting to 4 s).
- 1.0.5 (24/10) — A conversation switch no longer kills the voice
  conversation: coming back restores the row where it left off (armed,
  muted, parked) and the microphone reopens without a tap.
- 1.0.2 (24/10) — A run that opened muted keeps its webm header, so the
  later unmuted words decode instead of failing with "unable to decode
  audio".
- 1.0.2 (24/10) — One microphone in the error row: the mute leaves the
  retry row and appears only where a mic is actually open.
- 1.0.1 (22/10) — One cross, one job: the cross is the single stop
  control in every phase — it stops the turn, the speech and the words
  in flight.
- 1.0.1 (22/10) — A dead input device is named when a recording draws no
  audio ("check the input device"), instead of a generic retry.
- 1.0.1 (22/10) — Auto-reads queue behind audio that is already playing
  instead of cutting it off; a manual read or an explicit stop still
  cuts in.
- 1.0.1 (22/10) — Dictated messages can carry a flag (a marker line or a
  sidecar note) so they are recognisable in the log; typed messages
  never do.
- 1.0.1 (22/10) — The microphone stays open while the agent thinks, so
  words spoken mid-turn are transcribed and queued.
- 1.0.1 (22/10) — Voice activity trusts the recorder only when the
  analyser is blind (a suspended page), so a quiet room never reads as
  speech.
