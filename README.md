# Force Codec in YT & YT Music

A Tampermonkey/Violentmonkey userscript that **prioritizes** the **VP9** (video) and **Opus** (audio) codecs on YouTube & YouTube Music — **without blocking any other codec**. If VP9/Opus is not available for a stream (e.g. live streams that only offer H.264/AAC), playback continues normally through the fallback.

## Files

| File | Description |
|---|---|
| `force-codec-in-yt-and-yt-music.user.js` | The userscript |
| `tests/core.test.mjs` | Unit tests for the core logic (Node.js) |

## Installation

1. Install **Tampermonkey** (Chrome/Edge) or **Violentmonkey** (Firefox).
2. Install the script:
   - **One click**: open [`force-codec-in-yt-and-yt-music.user.js` raw link](https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music/raw/main/force-codec-in-yt-and-yt-music.user.js), or
   - **Manual**: dashboard → create new script → paste the full contents of `force-codec-in-yt-and-yt-music.user.js` → save.
3. Keep `@run-at document-start` and `@grant none` untouched (both matter: the trap must be installed before YouTube's page scripts run, and the script must run in page context for the hooks to be effective).

## How it works (why "prioritize" instead of "block")

1. **Player response rewrite** — hooks `fetch` + `XMLHttpRequest` for `/youtubei/v1/player`, plus a `window.ytInitialPlayerResponse` trap (first page load). `streamingData.adaptiveFormats` is reordered **stably within each quality tier**: the VP9 (video) and Opus (audio) variants move to the front of their tier. No entry is removed → no codec is blocked, the fallback always stays intact.
2. **Capability promotion (upgrade-only)** — `MediaSource.isTypeSupported` / `canPlayType` may only make an answer *more supportive* (`false→true`, `''→'maybe'`) for VP9 profile 0 / Opus in WebM that the browser really supports. Answers for every other codec stay 100% native.
3. **Verification & nudge** — after each stream loads, the actual codecs are read via `movie_player.getVideoData()` (`videoCoding`/`audioCoding`) and logged. If the codec does not match the preference while a VP9 variant exists for the same quality, a one-shot `setPlaybackQualityRange` re-nudge is attempted.

## Verification

1. Open a YouTube video → right-click the video → **Stats for nerds** → the *Codecs* row should show `vp9` / `opus`.
2. DevTools → **Network** tab → filter `videoplayback` → check the URL parameters: `mime=video%2Fwebm` (with `codecs=vp9|vp09...`) for video and `mime=audio%2Fwebm` (`codecs=opus`) for audio.
3. Console: logs prefixed with `[VP9-Opus]`, plus the commands:
   - `__VP9OPUS.dump()` — status summary (rewrites, SABR, last codecs, etc.)
   - `__VP9OPUS.check()` — check the codecs of the video currently playing
   - `__VP9OPUS.toggleVerbose()` — detailed per-format logging
4. `music.youtube.com` → play a song → the audio should be `opus`.

## Configuration (edit the `CONFIG` object at the top of the userscript)

| Key | Default | Meaning |
|---|---|---|
| `VIDEO_PREFER` | `'vp9'` | preferred video codec family |
| `AUDIO_PREFER` | `'opus'` | preferred audio codec family |
| `ENABLE_CAPABILITY_PROMOTION` | `true` | non-blocking `isTypeSupported`/`canPlayType` promotion |
| `ENABLE_NUDGE` | `true` | one-shot quality re-nudge when the codec mismatches |
| `DEBUG` / `VERBOSE` | `true` / `false` | console logging level |

## Known limitations

- **SABR (Server ABR)**: YouTube is gradually moving format selection to the server side. The script detects SABR and still prioritizes the client-side format list, but the final choice may be made by the server — verify with Stats for nerds. Because the script **must not block** other codecs, a 100% guarantee on every video is impossible; what is guaranteed is: no codec is ever blocked and the fallback always works.
- **Live streams** usually only provide H.264/AAC — they will play normally (fallback), as required.
- **Tampermonkey/Violentmonkey** are recommended. Greasemonkey 4 (Firefox) uses an X-ray sandbox and is not fully tested.

## Running the unit tests

```powershell
node tests/core.test.mjs
```

The tests extract the `/* __CORE_START__ */ ... /* __CORE_END__ */` block from the userscript and verify: mimetype parsing, codec family classification, stable per-tier reordering (no dropped entries — proving there is no blocking), idempotency, SABR detection, and safe handling of empty input.

## License

[MIT](LICENSE)
