# Publishing @martindye/dsh-voice

The npm account uses a **stage-only** granular token: a plain `npm publish`
is rejected by design, so every version goes through npm's staged-publish
gate.

## Flow
1. Make the changes, pass the tests (`pnpm test`), rebuild (`pnpm bundle`).
2. Bump `version` in package.json (semver) and commit.
3. From the repo root: `npm stage publish` (token lives in `~/.npmrc`;
   this step needs no 2FA).
4. Martin approves the version in the **Staged Packages** tab on
   npmjs.com — that step needs his 2FA. The version goes live on the
   registry the moment it is approved.

## Pack contents
The `files` whitelist in package.json (src, lib, cordis.patch.yml,
README.md, THIRD-PARTY.md, tts, bin, ref_voices) narrowed by `.npmignore`
(tests, logs, build scratch). `bin/tts-server.exe` is included on purpose
— it is the pocket TTS engine — which is why the tarball is ~55 MB.

## Version history
- 1.0.1 (22/10): first public version (renamed from @martin/dsh-voice).
- 1.0.2 (22/10): webm-header decode fix for muted runs; mute button
  removed from the error row; this file.
- 1.0.3 (24/10): conversation-switch fix — leaving a voice conversation
  and coming back restored the row (armed/mute/parked state) instead of
  a fresh dictate row; the mic reopens without a tap. (Staged, then
  superseded by 1.0.4 the same day — do not approve the 1.0.3 stage.)
- 1.0.4 (24/10): 1.0.3 plus two settings: the auto-read freshness cutoff
  (30 s-10 min, default 2 min) and the pause that ends dictation
  (1-5 s, default 2 s), both in the settings card. (Staged, then
  superseded by 1.0.5 the same day — do not approve the 1.0.4 stage.)
- 1.0.5 (24/10): 1.0.4 with the dictation pause reworked per Martin: the
  default is now 4 s and the range extends to 10 s (options 1, 1.5, 2,
  3, 4, 5, 10). STAGED — approve this one first.
- 1.0.6 (24/10): README-only — the npm changelog now carries the version
  number and that version's publish date per entry instead of the dev
  date. STAGED — approve after 1.0.5.
