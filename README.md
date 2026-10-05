# dsh-voice

Martin's two-way voice plugin for the DSH web app: you speak, the agent replies
out loud, and the microphone keeps listening.

This is a standalone fork of `@deepseek-ai/dsh-experimental-client-ui-voice-input`
(0.1.7-rc.2, from the deepseek-harness checkout), renamed `@martin/dsh-voice`
and maintained here as an independent DSH plugin. The plugin name, source, and
build config in this repository are the single source of truth for the voice
composer that runs in the web app.

## What it adds

- The unified 34 px blue composer button: voice entry on an empty draft, send
  arrow while typing, stop square while the agent runs or the system speaks,
  cross while a voice turn is active.
- Continuous listening: after a reply ends the microphone reopens on its own;
  an auto-open that draws no words is quietly re-offered a few times.
- The spoken pause command ("hold the mic", "pause the mic", "stop listening")
  parks the listening loop without sending.
- In-call mute: while a voice turn is active the dictate button becomes a
  mute/unmute toggle (white on red while muted); muted audio never reaches the
  recognizer and the voice-activity clocks freeze.

## Layout

- `src/` — plugin source (client half under `src/client/`).
- `lib/` — build output (`lib/index.js` node half, `lib/client.js` browser
  bundle). Committed so the plugin runs without a build step.
- `tests/` — vitest client tests (jsdom).

## Building

```
pnpm install
pnpm bundle
```

The client bundle is a CJS closure factory registered with the host's module
loader under the package name; platform modules (react, primitives, slots,
gateway) stay externals, everything else inlines. CSS modules are compiled
with lightningcss and injected as self-managed style tags.

## Installing (bundle)

The package declares a `dsh.bundle` with `cordis.patch.yml`: installing it
disables the upstream `ui-voice-input` row (inserted by the dsh-voice-chat
kit) and inserts this plugin as `ui-voice`. The dsh-voice-chat kit (the
speech-to-text side) must be installed in the same profile, in any order —
the kit inserts its row first, this bundle patches it.

```
dsh plugin add ./dsh-voice-1.0.0.tgz        # tarball: pnpm pack in this repo
dsh plugin add github:martindye/dsh-voice   # from GitHub (needs the allowline below)
dsh plugin add @martin/dsh-voice            # once published to npm
```

For `github:` installs, pnpm >= 10 refuses to run the `prepare` build until
the user allowlists it in the profile's `pnpm-workspace.yaml` (copy the
exact key pnpm prints; pin a commit for safety):

```yaml
allowBuilds:
  '@martin/dsh-voice': true
```

The built `lib/` is committed, so an install that skips the build still
ships working prebuilt code; `prepare` rebuilds it from `src/` when the
toolchain is available.
