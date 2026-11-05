# Force Codec in YT & YT Music

A Tampermonkey/Violentmonkey userscript that **prioritizes** the **VP9** (video) and **Opus** (audio) codecs on YouTube & YouTube Music — **without blocking any other codec**. If VP9/Opus is not available for a stream (e.g. live streams that only offer H.264/AAC), playback continues normally through the fallback.

It also ships an optional **Strict Audio Mode** (on by default only on `music.youtube.com`) for cases where plain prioritization cannot win — e.g. the standard Opus tier is ~160 kbps (itag 251) while a Premium account also gets 256 kbps streams (AAC `itag 141` and, on many tracks, Opus `itag 774`). While strictly engaged for a video, known non-Opus audio answers (AAC/Vorbis/FLAC/MP3) are reported as unsupported so the player picks the available Opus variant, with automatic failsafes.

## Files

| File | Description |
|---|---|
| `force-codec-in-yt-and-yt-music.user.js` | The userscript |
| `tests/core.test.mjs` | Unit tests for the pure core logic (Node.js) |
| `tests/runtime.smoke.test.mjs` | Runtime smoke tests: runs the whole script in a `vm` sandbox with browser stubs |
| `package.json` | Test scripts (`npm test`) |

## Installation

1. Install **Tampermonkey** (Chrome/Edge) or **Violentmonkey** (Firefox).
2. Install the script:
   - **One click**: open [`force-codec-in-yt-and-yt-music.user.js` raw link](https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music/raw/main/force-codec-in-yt-and-yt-music.user.js), or
   - **Manual**: dashboard → create new script → paste the full contents of `force-codec-in-yt-and-yt-music.user.js` → save.
3. Keep `@run-at document-start` and `@grant none` untouched (both matter: the trap must be installed before YouTube's page scripts run, and the script must run in page context for the hooks to be effective).

## How it works (why "prioritize" instead of "block")

1. **Player response rewrite** — hooks `fetch` + `XMLHttpRequest` for `/youtubei/v1/player`, plus a `window.ytInitialPlayerResponse` trap (first page load). `streamingData.adaptiveFormats` is reordered **stably within each quality tier**: the VP9 (video) and Opus (audio) variants move to the front of their tier. No entry is removed → no codec is blocked, the fallback always stays intact.
2. **Capability promotion (upgrade-only)** — `MediaSource.isTypeSupported` / `canPlayType` may only make an answer *more supportive* (`false→true`, `''→'maybe'`) for VP9 profile 0 / Opus in WebM that the browser really supports. Answers for every other codec stay 100% native.
3. **Verification & nudge** — after each stream loads, the actual codecs are read via `movie_player.getVideoData()` (`videoCoding`/`audioCoding`) and logged. If the codec does not match the preference while a VP9 variant exists for the same quality, a one-shot **best-effort** quality re-nudge is attempted (`setPlaybackQualityRange` with the current quality — the player may ignore it, it is a nudge and not a guarantee).
4. **Strict Audio Mode (optional, YT Music only by default)** — engages **per video** and only when an Opus audio variant actually exists in that video's player response. In addition, **Smart Mode** (`ALLOW_HIGH_AUDIO_AAC: true`, on by default) checks whether a **high-fidelity stream of any family** is available (`itag 141` AAC 256k, `itag 774` Opus 256k, or anything ≥ 200 kbps): if found, Strict Audio does not engage for that track, so a Premium 256k stream can play unhindered. Within a quality tier the sort compares the best bitrate per family: your `AUDIO_PREFER` family wins a tie, but a substantially higher bitrate (+20%) wins — `itag 141` (258k) beats `itag 251` (136k), while `774` (263k) vs `141` (258k) stays on your preferred codec. For standard/free tracks, Strict Audio engages and reports *known* non-Opus audio families (AAC/Vorbis/FLAC/MP3) as unsupported so the player picks the superior Opus variant. Unknown/future audio families fail **open** (never blocked), video-only codecs are never touched, and everything stays fully native when not engaged. Engagement is keyed by the video id reported by the live player, so a **prefetched response for another video can never block the current one**; when the player reports **no** video id at all (track transition, ad break, player API unavailable) nothing is blocked, because the only decision available would belong to a different video. A watchdog disengages + reloads playback once (per video) on a codec-related media error (`MEDIA_ERR_DECODE`/`MEDIA_ERR_SRC_NOT_SUPPORTED`) or genuinely stuck buffering (player state 3 *and* a playback position that did not advance), so worst case you are back to native behavior.

## Verification

1. Open a YouTube video → right-click the video → **Stats for nerds** → the *Codecs* row should show `vp9` / `opus`.
2. DevTools → **Network** tab → filter `videoplayback` → check the URL parameters: `mime=video%2Fwebm` (with `codecs=vp9|vp09...`) for video and `mime=audio%2Fwebm` (`codecs=opus`) for audio.
3. Console: logs prefixed with `[VP9-Opus]`, plus the commands:
   - `__VP9OPUS.dump()` — status summary (rewrites, SABR, last codecs, etc.)
   - `__VP9OPUS.trace()` — evidence: for each player response, whether Opus / 256k AAC (141) / 256k Opus (774) was offered, which decision was taken, the audio itags, how many capability probes were blocked, and (`checks`) the codec that was **actually playing**, read from Stats for nerds — YT Music's `getVideoData()` reports no codec at all. Use this first when a codec gets stuck; `__VP9OPUS.resetTrace()` clears it.
   - `__VP9OPUS.check()` — check the codecs of the video currently playing
   - `__VP9OPUS.audio()` — Strict Audio Mode diagnostics: engagement state, the per-video decision (`engagedNowForCurrentVideo`), available audio formats (itag/codec/bitrate), SABR flag, current codec
   - `__VP9OPUS.toggleStrictAudio()` — turn Strict Audio Mode on/off at runtime (takes effect immediately, no reload needed)
   - `__VP9OPUS.toggleVerbose()` — detailed per-format logging
4. `music.youtube.com` → play a song → the audio should be `opus` (see `__VP9OPUS.audio()` when in doubt; console also logs `Strict Audio Mode ENGAGED`).

## Configuration (edit the `CONFIG` object at the top of the userscript)

| Key | Default | Meaning |
|---|---|---|
| `VIDEO_PREFER` | `'vp9'` | preferred video codec family |
| `AUDIO_PREFER` | `'opus'` | preferred audio codec family |
| `ENABLE_CAPABILITY_PROMOTION` | `true` | non-blocking `isTypeSupported`/`canPlayType` promotion |
| `ENABLE_NUDGE` | `true` | best-effort quality re-nudge when the codec mismatches (the player may ignore it) |
| `STRICT_AUDIO` | `true` on `music.youtube.com`, `false` elsewhere | conditional blocking of known non-Opus audio while engaged (see "How it works" #4); can be toggled at runtime with `__VP9OPUS.toggleStrictAudio()` and takes effect immediately |
| `ALLOW_HIGH_AUDIO_AAC` | `true` | smart mode (YT Music only): skips strict blocking when any high-fidelity stream is available (`itag 141` AAC 256k, `itag 774` Opus 256k, ≥ 200 kbps) and sorts by bitrate inside a tier (your `AUDIO_PREFER` wins ties). Set `AUDIO_PREFER: 'aac'` to prefer `141` when both 256k streams exist |
| `DEBUG` / `VERBOSE` | `true` / `false` | console logging level |

> Note: Strict Audio Mode is always **Opus-based**. Changing `AUDIO_PREFER` (e.g. to `aac`) only changes the *prioritization* order; the strict blocking list stays AAC/Vorbis/FLAC/MP3.

## Opus vs AAC on YouTube Music

A common question when configuring `AUDIO_PREFER` or using Strict Audio Mode is whether **Opus** or **AAC** is better on YouTube Music:

| Scenario | Recommended Codec | Why |
|---|---|---|
| **Free / Standard Account** | **Opus** | At standard bitrates (~128 kbps), Opus is vastly superior to AAC-LC in detail, soundstage, and high-frequency retention. |
| **Premium ("Always High")** | **Opus (`itag 774`) or AAC (`itag 141`)** | Premium serves **both** families at ~256 kbps: AAC 256k (`itag 141`) and, on many tracks, Opus 256k (`itag 774`). Same bitrate, so the better codec (Opus, 48 kHz) is the sensible default; pick AAC if your chain prefers it. |
| **Bandwidth / Mobile Data Saver** | **Opus** | Reaches subjective transparency at ~35–40% lower bandwidth compared to 256 kbps AAC. |
| **Apple Devices (iOS / macOS)** | **AAC** | Fully hardware-accelerated on Apple Silicon and CoreAudio pipelines, optimizing battery efficiency. |

### Technical Details

1. **Bitrate Tiers on YouTube Music**:
   - **Free Users**:
     - **AAC**: ~128 kbps (`itag 140`)
     - **Opus**: ~128–160 kbps VBR (`itag 251`)
     - *Verdict*: **Opus wins hands down**. Opus's hybrid SILK + CELT/MDCT engine handles low-to-medium bitrates far better than older AAC-LC, preventing the muffled treble and compression artifacts typical of 128 kbps AAC.
   - **Premium Users ("High quality" audio setting)**:
     - **AAC**: **256 kbps** (`itag 141`, 44.1 kHz, stereo)
     - **Opus**: **~256 kbps VBR** (`itag 774`, 48 kHz, stereo) — *not* `itag 251` (~136–160 kbps), which is the standard tier
     - *Verdict*: at the same ~256 kbps, Opus 774 is the better stream (more efficient codec, 48 kHz). Not every track/route offers `774`: when it is missing, `141` (256k AAC) is the next best and smart mode keeps it playable. This is also why a track can look inconsistent when the server returns different format lists — see the note below.

2. **Codec Efficiency & Device Playback**:
   - **Opus**: Open IETF standard, dynamic VBR, ultra-low latency. Reaches transparent fidelity for most ears around 128–160 kbps. Decoded in software on most platforms, though modern CPUs handle it with near-zero overhead.
   - **AAC-LC**: Mature commercial standard. Requires higher bitrates (≥ 256 kbps) for complete transparency. Widely backed by dedicated hardware decoders across almost every mobile and desktop SoC.

### Userscript Configuration Advice
- **Default behavior (Smart Audio Mode, `ALLOW_HIGH_AUDIO_AAC: true`)**: Gives you the best of both worlds automatically without manual intervention:
  - If you have **Premium** and play a track offering 256 kbps AAC (`itag 141`), Strict Audio automatically stands down, allowing native 256 kbps AAC to play.
  - If you are on a **Free account** (or play a track without a 256 kbps tier), Strict Audio engages and forces Opus ~160 kbps over standard 128 kbps AAC.
- If you want to force Opus ~160 kbps at all times (even on Premium tracks), set `ALLOW_HIGH_AUDIO_AAC: false`.

## Known limitations

- **SABR (Server ABR)**: YouTube is gradually moving format selection to the server side. The script detects SABR and still prioritizes the client-side format list, but the final choice may be made by the server — verify with Stats for nerds. Because the script **must not block** other codecs, a 100% guarantee on every video is impossible; what is guaranteed is: no codec is ever blocked and the fallback always works.
- **Strict Audio Mode tradeoff**: with `ALLOW_HIGH_AUDIO_AAC: true` (default), tracks offering 256 kbps AAC are left unblocked so Premium users get maximum fidelity. If `ALLOW_HIGH_AUDIO_AAC` is set to `false`, strictly engaging means Opus ≈ 160 kbps instead of AAC 256 kbps (Opus is more efficient, but the *kbps* number will look lower). If anything goes wrong, the watchdog disengages and reloads once per video — worst case you are back to normal AAC playback. Video-sourced tracks on YT Music almost always have Opus audio variants; when a video genuinely has none, the mode does not engage at all. Only *known* non-Opus audio families are blocked, so an unknown/future codec fails open instead of breaking playback.
- **Format lists vary per request (server side)**: the same track can come back as `141`+`774`, `774` only, or (server downgrade) standard formats only. The script therefore decides per response and, in smart mode, keeps the highest-bitrate stream in front — but YouTube still owns the final choice, so a track can occasionally play a different 256k family than the time before. `__VP9OPUS.trace()` records exactly what each response offered, which is the fastest way to tell "the script blocked something" apart from "the server sent a different list".
- **Blocking is skipped when the playing video is unknown**: if `movie_player.getVideoData()` reports no `video_id` (track transition, ad break, player API unavailable), Strict Audio applies nothing rather than a decision that belonged to a different video. Worst case one track plays native AAC instead of Opus.
- **Re-nudge is best-effort**: re-requesting the current quality with `setPlaybackQualityRange` is often a no-op that the player ignores; the actual codec still depends on YouTube's ABR/SABR decisions.
- **XHR safety net**: because some consumers read `responseText` before any late listener could patch it, the XHR path rewrites the value lazily via own getters installed at `open()`. If an engine forbids redefining those properties, the XHR path degrades to pass-through (the `fetch` path and the `ytInitialPlayerResponse` trap are unaffected).
- **Live streams** usually only provide H.264/AAC — they will play normally (fallback), as required.
- **Tampermonkey/Violentmonkey** are recommended. Greasemonkey 4 (Firefox) uses an X-ray sandbox and is not fully tested.

## Running the unit tests

```powershell
npm test          # core unit tests + runtime smoke tests
node tests/core.test.mjs            # pure core logic only
node tests/runtime.smoke.test.mjs   # runtime behaviour (vm sandbox + browser stubs)
```

The core tests extract the `/* __CORE_START__ */ ... /* __CORE_END__ */` block from the userscript and verify: mimetype parsing, codec family classification, stable per-tier reordering (no dropped entries — proving there is no blocking), idempotency, SABR detection, Strict Audio engagement rules, the pure strict-blocking rules (including fail-open for unknown families), the promotion safety predicates, and safe handling of empty input.

The runtime smoke tests load the **whole** userscript into a `vm` sandbox with hand-rolled browser stubs (`window`, `document`, `location`, `MediaSource`, `HTMLMediaElement`, `XMLHttpRequest`) plus a virtual clock, and verify the behaviour that the pure core cannot cover: the `fetch` hook rewriting the response (nothing dropped, `url` preserved), the XHR `responseText` getter, per-video Strict Audio engagement (a prefetched response for another video must not block the current one), fail-open when the player reports no video id, smart-mode ordering (256k AAC stays ahead of Opus), the diagnostic trace, immediate effect of `toggleStrictAudio()`, and the watchdog/failsafe (numeric player state, stuck-vs-healthy buffering, network errors ignored, codec errors triggering recovery).

CI (`.github/workflows/test.yml`) runs the syntax check and both test files on Node 18/20/22 for every push and pull request.

## License

[MIT](LICENSE)
