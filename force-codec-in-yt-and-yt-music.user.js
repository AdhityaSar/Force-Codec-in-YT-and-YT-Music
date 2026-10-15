// ==UserScript==
// @name         YouTube VP9 + Opus Prioritizer
// @namespace    https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music
// @version      0.2.1
// @description  Prioritize VP9 (video) & Opus (audio) on YouTube & YouTube Music. Does NOT block other codecs - only raises their priority; AVC/AAC/AV1 fallback keeps working. Optional Strict Audio Mode on YT Music (engages only when Opus exists, with auto-failsafe).
// @author       AdhityaSar
// @license      MIT
// @homepageURL  https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music
// @supportURL   https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music/issues
// @updateURL    https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music/raw/main/force-codec-in-yt-and-yt-music.user.js
// @downloadURL  https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music/raw/main/force-codec-in-yt-and-yt-music.user.js
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @match        https://www.youtube-nocookie.com/embed/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * HOW IT WORKS (100% non-blocking):
 *   1) Network hooks (fetch + XHR) & a `window.ytInitialPlayerResponse` trap
 *      reorder (stable sort) `streamingData.adaptiveFormats` and
 *      `streamingData.formats` so that VP9 (video) & Opus (audio) variants
 *      come first WITHIN each quality tier. No entry is ever removed or
 *      modified  ->  no codec is ever blocked.
 *   2) Capability promotion: `MediaSource.isTypeSupported` & `canPlayType`
 *      may only UPGRADE answers (false -> true, '' -> 'maybe') for VP9/Opus
 *      that the browser genuinely supports; answers for all other codecs
 *      are 100% native.
 *   3) Post-playback verification through the player API (getVideoData)
 *      with console logging, plus an optional best-effort quality re-nudge.
 *   4) Strict Audio Mode (OPTIONAL, on by default only on music.youtube.com):
 *      while engaged for the current video, *known* non-Opus audio answers
 *      (AAC/Vorbis/FLAC/MP3) are reported as unsupported so the player picks
 *      the available Opus variant instead. Unknown/future audio families are
 *      left alone (fail-open). It engages ONLY when an Opus variant exists in
 *      the response, and a watchdog auto-disengages + reloads playback once
 *      on any codec-related media error or genuinely stuck buffering.
 *      Video *codecs* are never blocked, but MP4 muxed streams that contain
 *      AAC are also reported unsupported while engaged (they carry AAC audio).
 *
 * Quick debug (DevTools console):
 *   __VP9OPUS.dump()            -> status summary
 *   __VP9OPUS.toggleVerbose()   -> verbose per-format logging
 *   __VP9OPUS.check()           -> check codecs of the currently playing video
 *   __VP9OPUS.audio()           -> strict audio mode & audio format diagnostics
 */

(function () {
  'use strict';

  // Prevent double injection
  if (window.__VP9_OPUS_PRIORITIZER__) return;
  window.__VP9_OPUS_PRIORITIZER__ = true;

  var CONFIG = {
    VIDEO_PREFER: 'vp9',                 // preferred video codec family
    AUDIO_PREFER: 'opus',                // preferred audio codec family
    ENABLE_CAPABILITY_PROMOTION: true,   // non-blocking isTypeSupported/canPlayType promotion
    ENABLE_NUDGE: true,                  // one-shot quality re-nudge when the codec mismatches
    STRICT_AUDIO: location.host === 'music.youtube.com', // conditional AAC blocking (YT Music only by default)
    DEBUG: true,                         // concise console logging
    VERBOSE: false                       // detailed per-format logging
  };

  /* __CORE_START__ */
  // ===================================================================
  // CORE (pure - no window/document access).
  // This block is extracted & tested by tests/core.test.mjs:
  // do not use browser APIs inside this block.
  // ===================================================================

  var CORE_DEFAULTS = { videoPrefer: 'vp9', audioPrefer: 'opus' };

  var VIDEO_FAMILIES = ['vp9', 'vp8', 'av1', 'avc', 'hevc'];
  var AUDIO_FAMILIES = ['opus', 'aac', 'flac', 'vorbis', 'mp3'];

  /** 'video/webm; codecs="vp09.00.51.08"' -> {container, kind, codecs[]} */
  function parseMimeType(mime) {
    if (typeof mime !== 'string' || mime.indexOf('/') === -1) return null;
    var semi = mime.indexOf(';');
    var container = (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
    var kind = container.indexOf('video/') === 0 ? 'video'
      : (container.indexOf('audio/') === 0 ? 'audio' : 'other');
    var codecs = [];
    var m = /codecs\s*=\s*"([^"]*)"/i.exec(mime);
    if (m) {
      m[1].split(',').forEach(function (c) {
        var t = c.trim();
        if (t) codecs.push(t);
      });
    }
    return { container: container, kind: kind, codecs: codecs };
  }

  /** Map any codec string (profile string) to a simple family. */
  function codecFamily(type) {
    var t = String(type || '').toLowerCase();
    if (!t) return 'unknown';
    if (/vp0?9/.test(t)) return 'vp9';                // vp9, vp09.00.51.08
    if (t.indexOf('vp8') !== -1) return 'vp8';
    if (/av0?1|av99/.test(t)) return 'av1';           // av01.0.08M.08, av1, av99
    if (/avc[13]|h264|h\.264/.test(t)) return 'avc';  // avc1.640028, avc3, h264
    if (/hvc1|hev1|hevc/.test(t)) return 'hevc';
    if (t.indexOf('opus') !== -1) return 'opus';
    if (/mp4a|aac/.test(t)) return 'aac';
    if (t.indexOf('flac') !== -1) return 'flac';
    if (t.indexOf('vorbis') !== -1) return 'vorbis';
    if (t.indexOf('mp3') !== -1) return 'mp3';       // literal "mp3" (rare on YouTube)
    return 'unknown';
  }

  /** Primary family of a format: first codec that matches its kind. */
  function primaryFamily(parsed) {
    if (!parsed || !parsed.codecs || !parsed.codecs.length) return 'unknown';
    var families = parsed.kind === 'audio' ? AUDIO_FAMILIES : VIDEO_FAMILIES;
    for (var i = 0; i < parsed.codecs.length; i++) {
      var fam = codecFamily(parsed.codecs[i]);
      if (families.indexOf(fam) !== -1) return fam;
    }
    return codecFamily(parsed.codecs[0]);
  }

  /** Quality tier key: video = (height, fps); audio = audioQuality. */
  function tierKey(f, parsed) {
    if (!f) return 'null';
    if (parsed && parsed.kind === 'audio') return 'a:' + (f.audioQuality || 'n/a');
    var h = (f.height != null) ? f.height : (f.width != null ? f.width : null);
    var q = (h != null) ? h : String(f.qualityLabel || f.quality || '?');
    return 'v:' + q + ':f' + (f.fps != null ? f.fps : '?');
  }

  /** True when any codec in the mimetype belongs to the given family. */
  function hasFamily(parsed, family) {
    if (!parsed || !parsed.codecs || !parsed.codecs.length) return false;
    for (var i = 0; i < parsed.codecs.length; i++) {
      if (codecFamily(parsed.codecs[i]) === family) return true;
    }
    return false;
  }

  /**
   * Strict Audio Mode engagement decision for one player response:
   * engages only when allowed AND at least one Opus audio variant
   * exists in adaptiveFormats (so AAC can never be the only option).
   */
  function shouldEngageStrictAudio(sd, allowStrict) {
    if (!allowStrict) return false;
    if (!sd || typeof sd !== 'object') return false;
    var af = sd.adaptiveFormats;
    if (!Array.isArray(af)) return false;
    for (var i = 0; i < af.length; i++) {
      var parsed = parseMimeType(af[i] && af[i].mimeType);
      if (parsed && parsed.kind === 'audio' && primaryFamily(parsed) === 'opus') return true;
    }
    return false;
  }

  /**
   * Stable reorder: within each quality tier, the preferred codec variant
   * is moved to the front; the relative order of all other entries is
   * preserved. Never removes or modifies any entry.
   */
  function prioritizeFormats(arr, opts) {
    var o = {};
    for (var k in CORE_DEFAULTS) o[k] = (opts && opts[k] != null) ? opts[k] : CORE_DEFAULTS[k];
    if (!Array.isArray(arr) || arr.length < 2) {
      return { list: arr || [], moved: 0, videoMoved: 0, audioMoved: 0, groups: 0 };
    }
    var infos = arr.map(function (f, i) {
      var parsed = parseMimeType(f && f.mimeType);
      return {
        i: i,
        f: f,
        parsed: parsed,
        family: primaryFamily(parsed),
        prefer: (parsed && parsed.kind === 'audio') ? o.audioPrefer : o.videoPrefer,
        tier: tierKey(f, parsed)
      };
    });

    // Group entries by tier in order of first appearance.
    var groups = [];
    var idxOfTier = {};
    infos.forEach(function (info) {
      var gi = idxOfTier[info.tier];
      if (gi == null) { gi = groups.length; idxOfTier[info.tier] = gi; groups.push([]); }
      groups[gi].push(info);
    });

    var result = new Array(arr.length);
    infos.forEach(function (info) { result[info.i] = info.f; });

    var moved = 0, videoMoved = 0, audioMoved = 0, groupCount = 0;
    groups.forEach(function (g) {
      if (g.length < 2) return;
      groupCount++;
      var preferred = g.filter(function (x) { return x.family === x.prefer; });
      var others = g.filter(function (x) { return x.family !== x.prefer; });
      var merged = preferred.concat(others); // filter() preserves order -> stable
      for (var j = 0; j < g.length; j++) {
        result[g[j].i] = merged[j].f;
        if (merged[j] !== g[j]) {
          moved++;
          if (g[j].parsed && g[j].parsed.kind === 'audio') audioMoved++; else videoMoved++;
        }
      }
    });
    return { list: result, moved: moved, videoMoved: videoMoved, audioMoved: audioMoved, groups: groupCount };
  }

  /**
   * Apply the priority to a single streamingData object (in-place mutation).
   * Returns a summary; sabr=true when stream selection is partly done
   * server-side (Server ABR).
   */
  function prioritizeStreamingData(sd, opts) {
    var summary = { touched: false, videoMoved: 0, audioMoved: 0, sabr: false, dash: false, hls: false, adaptive: 0, muxed: 0 };
    if (!sd || typeof sd !== 'object') return summary;
    var af = sd.adaptiveFormats;
    var fm = sd.formats;
    summary.adaptive = Array.isArray(af) ? af.length : 0;
    summary.muxed = Array.isArray(fm) ? fm.length : 0;
    summary.dash = typeof sd.dashManifestUrl === 'string' && sd.dashManifestUrl.length > 0;
    summary.hls = typeof sd.hlsManifestUrl === 'string' && sd.hlsManifestUrl.length > 0;
    summary.sabr = (typeof sd.serverAbrStreamingUrl === 'string' && sd.serverAbrStreamingUrl.length > 0) ||
      (summary.adaptive > 0 && af.every(function (f) { return f && !f.url; }));
    if (summary.adaptive > 1) {
      var r1 = prioritizeFormats(af, opts);
      if (r1.moved > 0) {
        sd.adaptiveFormats = r1.list;
        summary.touched = true;
        summary.videoMoved += r1.videoMoved;
        summary.audioMoved += r1.audioMoved;
      }
    }
    if (summary.muxed > 1) {
      var r2 = prioritizeFormats(fm, opts);
      if (r2.moved > 0) {
        sd.formats = r2.list;
        summary.touched = true;
        summary.videoMoved += r2.videoMoved;
      }
    }
    return summary;
  }

  /**
   * Audio families that Strict Audio Mode may report as unsupported while
   * engaged. Only *known* non-Opus families are blocked on purpose: a future
   * or unknown codec (family === 'unknown') is left alone (fail-open), so a
   * new YouTube audio codec can never break playback.
   */
  var STRICT_BLOCKED_AUDIO_FAMILIES = ['aac', 'vorbis', 'flac', 'mp3'];

  /**
   * True when the given mimetype must be reported as unsupported because
   * Strict Audio Mode is engaged (pure: `engaged` is passed in explicitly).
   * Only audio codecs in STRICT_BLOCKED_AUDIO_FAMILIES (e.g. AAC/MP4A) and
   * MP4 muxed streams containing AAC are affected; video-only codecs are
   * never blocked, and unknown audio families fail open.
   */
  function strictBlockMime(type, engaged) {
    if (!engaged || typeof type !== 'string') return false;
    var parsed;
    try { parsed = parseMimeType(type); } catch (e) { return false; }
    if (!parsed) return false;
    if (parsed.kind === 'audio') {
      return STRICT_BLOCKED_AUDIO_FAMILIES.indexOf(primaryFamily(parsed)) !== -1;
    }
    if (parsed.kind === 'video') return hasFamily(parsed, 'aac'); // MP4 muxed (avc+aac); pure video stays untouched
    return false;
  }

  /**
   * VP9 promotion safety: only WebM and only profile 0 (8-bit) may be
   * promoted (universally safe). Profile 2 (10-bit) and non-WebM keep the
   * native answer to avoid breaking playback.
   */
  function isSafeVp9Promotion(type) {
    if (typeof type !== 'string') return false;
    var t = type.toLowerCase();
    if (t.indexOf('video/webm') !== 0) return false;
    var m = /codecs\s*=\s*"([^"]*)"/i.exec(t);
    if (m && /^vp09\.02/.test(m[1].trim())) return false;
    return /vp0?9/i.test(t);
  }

  /** Opus promotion safety: only Opus inside WebM may be promoted. */
  function isSafeOpusPromotion(type) {
    if (typeof type !== 'string') return false;
    var t = type.toLowerCase();
    return t.indexOf('audio/webm') === 0 && t.indexOf('opus') !== -1;
  }
  /* __CORE_END__ */


  // ===================================================================
  // RUNTIME (page context)
  // ===================================================================

  var state = {
    lastVideoId: null,
    currentVideoId: null,      // video id reported by the live player (per-video strict decision)
    sabr: false,
    vp9Heights: [],
    opusAvailable: false,
    nudgedFor: {},
    lastVideoData: null,
    lastSummary: null,
    responsesProcessed: 0,     // player responses seen (not necessarily changed)
    rewritesApplied: 0,        // player responses whose format order actually changed
    lastAudioFormats: [],
    vp9Base: false,
    opusBase: false,
    strictEngaged: false,      // cache/fallback (see isStrictEngagedNow)
    strictEngagedFor: {},
    strictDisengagedFor: {},
    strictEvents: [],
    strictWatch: {}
  };
  var warned = {};

  // Bounded string-keyed map helpers (keeps long sessions from leaking keys).
  var MAX_TRACKED_KEYS = 200;
  function trackKey(map, key) {
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      var keys = Object.keys(map);
      if (keys.length >= MAX_TRACKED_KEYS) delete map[keys[0]];
    }
    map[key] = true;
  }

  function log() {
    if (!CONFIG.DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('%c[VP9-Opus]', 'background:#032610;color:#35e06b;padding:1px 5px;border-radius:3px;font-weight:700');
    console.log.apply(console, args);
  }
  function verbose() {
    if (CONFIG.VERBOSE) log.apply(null, arguments);
  }
  function warnOnce(key) {
    if (warned[key]) return;
    trackKey(warned, key);
    var args = Array.prototype.slice.call(arguments, 1);
    console.warn.apply(console, ['[VP9-Opus]'].concat(args));
  }

  function isPlayerApiUrl(input) {
    try {
      var s = (typeof input === 'string') ? input
        : (input && (input.url || input.href)) || '';
      return typeof s === 'string' && s.indexOf('/youtubei/v1/player') !== -1;
    } catch (e) { return false; }
  }

  /** Process one player response object; returns true when the order changed. */
  function processPlayerResponse(json, srcLabel) {
    try {
      if (!json || typeof json !== 'object' || !json.streamingData) return false;
      var summary = prioritizeStreamingData(json.streamingData, {
        videoPrefer: CONFIG.VIDEO_PREFER,
        audioPrefer: CONFIG.AUDIO_PREFER
      });
      state.responsesProcessed++;
      if (summary.touched) state.rewritesApplied++;
      state.lastSummary = summary;
      rememberRewrite(json, summary);
      var vid = (json.videoDetails && json.videoDetails.videoId) || null;
      var allowStrict = !!CONFIG.STRICT_AUDIO && !!state.opusBase &&
        !(vid && state.strictDisengagedFor[vid]);
      var shouldEngage = shouldEngageStrictAudio(json.streamingData, allowStrict);
      // Per-video decision is always recorded; the global flag is only used as
      // a fallback when the live player has not reported a video id yet (see
      // isStrictEngagedNow), so a prefetched response for another video can
      // never block audio of the video that is actually playing.
      setStrictEngagement(shouldEngage, vid, srcLabel);
      log('player response [' + srcLabel + '] video=' + (vid || '?') +
        ' -> moved: ' + summary.videoMoved + ' video / ' + summary.audioMoved + ' audio' +
        ' (adaptive=' + summary.adaptive + ', muxed=' + summary.muxed + ')' +
        (summary.sabr ? ' [SABR]' : '') + (summary.dash ? ' [dash]' : '') + (summary.hls ? ' [hls]' : ''));
      if (summary.sabr) {
        warnOnce('sabr', 'SABR detected: stream selection is partly done on the server. ' +
          'The priority is still applied to the format list, but the final result may differ. ' +
          'Check Stats for nerds for the actual codecs.');
      }
      return summary.touched;
    } catch (e) {
      warnOnce('proc', 'processPlayerResponse failed (forwarding the original response):', e && e.message);
      return false;
    }
  }

  function rememberRewrite(json, summary) {
    try {
      state.lastVideoId = (json.videoDetails && json.videoDetails.videoId) || state.lastVideoId;
      state.sabr = !!summary.sabr;
      var heights = [];
      var opus = false;
      var audioFormats = [];
      var af = (json.streamingData && json.streamingData.adaptiveFormats) || [];
      af.forEach(function (f) {
        var parsed = parseMimeType(f && f.mimeType);
        if (!parsed) return;
        if (parsed.kind === 'audio') {
          var fam = primaryFamily(parsed);
          if (fam === CONFIG.AUDIO_PREFER) opus = true;
          audioFormats.push({
            itag: f.itag != null ? f.itag : null,
            codec: parsed.codecs.join(','),
            family: fam,
            bitrate: f.bitrate != null ? f.bitrate : null,
            quality: f.audioQuality || null
          });
        } else if (parsed.kind === 'video') {
          if (primaryFamily(parsed) === CONFIG.VIDEO_PREFER && f.height != null) heights.push(f.height);
        }
      });
      state.vp9Heights = heights;
      state.opusAvailable = opus;
      state.lastAudioFormats = audioFormats;
    } catch (e) {}
  }

  // ---- Strict Audio Mode (conditional, failsafe-protected) ----

  /** Video id reported by the live player, or null. */
  function currentPlayingId() {
    try {
      var p = getPlayerEl();
      if (!p || typeof p.getVideoData !== 'function') return null;
      var d = p.getVideoData();
      return (d && d.video_id) || null;
    } catch (e) { return null; }
  }

  /**
   * Is Strict Audio Mode engaged for the video that is *actually playing*?
   * The per-video map is authoritative; the global flag is only a fallback for
   * the short window before the player reports a video id (or when the player
   * API is unavailable). This prevents a prefetched player response for a
   * different video from blocking audio of the current one.
   */
  function isStrictEngagedNow() {
    if (!CONFIG.STRICT_AUDIO) return false;
    var vid = currentPlayingId();
    if (vid) {
      if (Object.prototype.hasOwnProperty.call(state.strictEngagedFor, vid)) {
        return !!state.strictEngagedFor[vid];
      }
      // A response for this video was already seen and rejected -> stay native.
      if (Object.prototype.hasOwnProperty.call(state.strictDisengagedFor, vid)) return false;
    }
    return !!state.strictEngaged;
  }

  /**
   * True when the given mimetype must be reported as unsupported because
   * Strict Audio Mode is engaged for the current video (delegates to the pure
   * CORE helper `strictBlockMime`). Video-only codecs are never blocked; only
   * known non-Opus audio families and MP4 muxed streams containing AAC are.
   */
  function shouldStrictBlock(type) {
    var engaged;
    try { engaged = isStrictEngagedNow(); } catch (e) { return false; }
    if (!engaged) return false;
    return strictBlockMime(type, true);
  }

  function setStrictEngagement(engage, vid, srcLabel) {
    var next = !!engage;
    if (vid) {
      trackKey(state.strictEngagedFor, vid);
      state.strictEngagedFor[vid] = next;
    }
    if (state.strictEngaged === next) return;
    state.strictEngaged = next;
    state.strictEvents.push({
      t: Date.now(),
      video: vid || '?',
      engaged: next,
      src: srcLabel || ''
    });
    if (state.strictEvents.length > 50) state.strictEvents.shift();
    log('Strict Audio Mode ' + (next ? 'ENGAGED' : 'disengaged') +
      (vid ? ' for video=' + vid : '') + ' [' + (srcLabel || '') + ']' +
      (next && state.sabr ? ' (note: SABR active - the server may ignore client hints)' : ''));
    scheduleStrictWatchdog(vid);
  }

  /** Auto-disengage + one reload per video when playback fails while engaged. */
  function strictFailureRecovery(reason, vid) {
    // Use the per-video decision: the global cache can be stale when a
    // prefetched response for another video toggled it in the meantime.
    var engaged = false;
    try { engaged = isStrictEngagedNow(); } catch (e) { engaged = !!state.strictEngaged; }
    if (!engaged) return;
    var key = vid || currentPlayingId() || state.lastVideoId || 'unknown';
    if (state.strictDisengagedFor[key]) return;
    trackKey(state.strictDisengagedFor, key);
    setStrictEngagement(false, key, 'failsafe:' + reason);
    try {
      var p = getPlayerEl();
      if (p && typeof p.loadVideoById === 'function' && typeof p.getCurrentTime === 'function' &&
          typeof p.getVideoData === 'function') {
        var d = p.getVideoData();
        var id = (d && d.video_id) || key;
        var t = p.getCurrentTime();
        log('Strict Audio failsafe: reloading playback at ' + t.toFixed(1) + 's');
        p.loadVideoById(id, t);
      } else {
        warnOnce('strict-reload', 'player API for reload not available - strict mode disabled for ' + key);
      }
    } catch (e) {
      warnOnce('strict-reload', 'failsafe reload failed:', e && e.message);
    }
  }

  /**
   * Watchdog: while engaged, a *stuck* buffering state triggers recovery.
   * YouTube's player API returns a number (-1 unstarted, 0 ended, 1 playing,
   * 2 paused, 3 buffering, 5 cued), but some player builds expose the string
   * form, so both are accepted. A buffer is only considered "stuck" when the
   * playback position did not advance at all during the window (avoids a
   * needless reload on a slow but healthy connection).
   */
  function scheduleStrictWatchdog(vid) {
    try {
      if (state.strictWatch.__any) clearTimeout(state.strictWatch.__any);
      if (!state.strictEngaged) return;
      var p0 = getPlayerEl();
      var t0 = null;
      try { if (p0 && typeof p0.getCurrentTime === 'function') t0 = p0.getCurrentTime(); } catch (e) {}
      state.strictWatch.__any = setTimeout(function () {
        state.strictWatch.__any = null;
        try {
          var p = getPlayerEl();
          if (!p || typeof p.getPlayerState !== 'function') return;
          var ps = p.getPlayerState();
          if (ps !== 3 && ps !== 'buffering') return;
          var d = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
          var id = (d && d.video_id) || vid || null;
          // Another video took over meanwhile -> this watchdog is stale.
          if (vid && id && id !== vid) return;
          if (t0 != null && typeof p.getCurrentTime === 'function') {
            var t1 = p.getCurrentTime();
            if (t1 > t0 + 0.25) return; // position advanced -> healthy buffer
          }
          strictFailureRecovery('stuck-buffering', id);
        } catch (e) {}
      }, 9000);
    } catch (e) {}
  }

  // ---- fetch hook (main Innertube path) ----
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (!isPlayerApiUrl(input)) return origFetch.apply(this, arguments);
      var promise = origFetch.apply(this, arguments);
      return promise.then(function (resp) {
        try {
          if (!resp || !resp.ok || typeof resp.clone !== 'function') return resp;
          var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
          if (ct && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return resp;
          // Read as text first: a cheap substring check avoids JSON.parse +
          // JSON.stringify (the expensive part) on player responses that do
          // not carry a streaming format list at all.
          return resp.clone().text().then(function (text) {
            if (typeof text !== 'string' || text.indexOf('"streamingData"') === -1) return resp;
            var json;
            try { json = JSON.parse(text); } catch (e) { return resp; }
            var changed = processPlayerResponse(json, 'fetch');
            if (!changed) return resp;
            var headers = new Headers(resp.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            var body = JSON.stringify(json);
            // Preserve as much of the original response as the platform allows.
            // NOTE: `Response` ignores the `url`/`redirected` init options, so
            // these are re-applied explicitly via own accessors (best effort;
            // silently skipped if the engine forbids it).
            var out;
            try {
              out = new Response(body, {
                status: resp.status,
                statusText: resp.statusText,
                headers: headers
              });
              try {
                Object.defineProperty(out, 'url', { value: resp.url, configurable: true });
                Object.defineProperty(out, 'redirected', { value: resp.redirected, configurable: true });
              } catch (e) {}
            } catch (e) {
              return resp;
            }
            return out;
          }, function () { return resp; });
        } catch (e) { return resp; }
      });
    };
  }


  // ---- XMLHttpRequest hook (safety net; text responses only) ----
  //
  // Ordering note: a listener registered inside send() runs *after* listeners
  // the caller registered before send(), so patching the response from such a
  // listener is too late. Instead the rewrite is applied lazily inside the
  // `responseText` / `response` getters (installed at open() time, before
  // send()), so whoever reads first always reads the rewritten text.
  try {
    var XHROpen = XMLHttpRequest.prototype.open;
    var XHRSend = XMLHttpRequest.prototype.send;
    var descResponseText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    var descResponse = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');

    /** Read the *native* value, bypassing the patched getters. */
    function nativeRead(xhr, prop) {
      var d = prop === 'responseText' ? descResponseText : descResponse;
      if (d && typeof d.get === 'function') return d.get.call(xhr);
      return undefined;
    }

    function ensureProcessed(xhr) {
      if (xhr.__ypfDone) return;
      try { if (xhr.readyState !== 4) return; } catch (e) { return; }
      xhr.__ypfDone = true;
      try {
        var rt = xhr.responseType;
        if (rt && rt !== 'text') return;
        var text = nativeRead(xhr, 'responseText');
        if (typeof text !== 'string' || text.charAt(0) !== '{') return;
        if (text.indexOf('"streamingData"') === -1) return; // cheap pre-filter
        var json = JSON.parse(text);
        if (processPlayerResponse(json, 'xhr')) xhr.__ypfText = JSON.stringify(json);
      } catch (e) {}
    }

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (isPlayerApiUrl(url)) {
          this.__ypfIsPlayer = true;
          var self = this;
          Object.defineProperty(this, 'responseText', {
            configurable: true,
            get: function () {
              var rt = self.responseType;
              if (rt && rt !== 'text') return nativeRead(self, 'responseText');
              ensureProcessed(self);
              return self.__ypfText != null ? self.__ypfText : nativeRead(self, 'responseText');
            }
          });
          Object.defineProperty(this, 'response', {
            configurable: true,
            get: function () {
              var rt = self.responseType;
              if (rt && rt !== 'text') return nativeRead(self, 'response');
              ensureProcessed(self);
              return self.__ypfText != null ? self.__ypfText : nativeRead(self, 'response');
            }
          });
        }
      } catch (e) { this.__ypfIsPlayer = false; }
      return XHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (xhr.__ypfIsPlayer) {
        // Backup path for consumers that never read responseText/response.
        xhr.addEventListener('readystatechange', function () {
          try { if (xhr.readyState === 4) ensureProcessed(xhr); } catch (e) {}
        });
      }
      return XHRSend.apply(this, arguments);
    };
  } catch (e) { warnOnce('xhr', 'XHR hook failed:', e && e.message); }

  // ---- window.ytInitialPlayerResponse trap (first page load) ----
  try {
    var _yipr;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get: function () { return _yipr; },
      set: function (v) {
        try {
          if (v && typeof v === 'object' && v.streamingData) {
            processPlayerResponse(v, 'inline ' + location.pathname);
          }
        } catch (e) {}
        _yipr = v;
      }
    });
  } catch (e) { warnOnce('yipr', 'ytInitialPlayerResponse trap failed:', e && e.message); }

  // ---- Capability hooks: promotion (upgrade-only) + optional strict blocking ----
  function installCapabilityPromotion() {
    var vp9Base = false, opusBase = false;
    try {
      var ms0 = window.MediaSource;
      if (ms0 && typeof ms0.isTypeSupported === 'function') {
        vp9Base = !!(ms0.isTypeSupported('video/webm; codecs="vp9"') ||
                     ms0.isTypeSupported('video/webm; codecs="vp09"'));
        opusBase = !!ms0.isTypeSupported('audio/webm; codecs="opus"');
      }
    } catch (e) {}
    state.vp9Base = vp9Base;
    state.opusBase = opusBase;
    if (!CONFIG.ENABLE_CAPABILITY_PROMOTION && !CONFIG.STRICT_AUDIO) return;
    if (!vp9Base && !opusBase) {
      // MediaSource missing at document-start (or the browser really has no
      // VP9/Opus): nothing to promote and Strict Audio must not engage.
      warnOnce('nobase', 'capability hooks skipped (MediaSource/VP9/Opus unavailable at document-start) ' +
        '- prioritization still active, promotion & strict audio disabled');
      return;
    }

    // VP9: only profile 0 (8-bit) is promoted (universally safe); profile 2
    // (10-bit) keeps the native answer to avoid breaking playback. The pure
    // predicates live in the CORE block so they can be unit tested.
    function safeVp9(t) { return isSafeVp9Promotion(t); }
    function safeOpus(t) { return isSafeOpusPromotion(t); }

    try {
      var ms = window.MediaSource;
      var origITS = ms.isTypeSupported.bind(ms);
      ms.isTypeSupported = function (type) {
        try {
          if (shouldStrictBlock(type)) return false; // Strict Audio: conditional non-Opus audio block
        } catch (e) {}
        var res = false;
        try { res = !!origITS(type); } catch (e) { res = false; }
        if (CONFIG.ENABLE_CAPABILITY_PROMOTION && !res && typeof type === 'string') {
          var t = type.toLowerCase();
          if (vp9Base && safeVp9(t)) return true;   // promotion: false -> true
          if (opusBase && safeOpus(t)) return true; // promotion: false -> true
        }
        return res;
      };
    } catch (e) { warnOnce('mse', 'isTypeSupported override failed:', e && e.message); }

    try {
      var proto = window.HTMLMediaElement.prototype;
      var origCPT = proto.canPlayType;
      proto.canPlayType = function (type) {
        try {
          if (shouldStrictBlock(type)) return ''; // Strict Audio: conditional non-Opus audio block
        } catch (e) {}
        var res = '';
        try { res = origCPT.call(this, type); } catch (e) { res = ''; }
        if (CONFIG.ENABLE_CAPABILITY_PROMOTION && res === '' && typeof type === 'string') {
          var t2 = type.toLowerCase();
          if (vp9Base && safeVp9(t2)) return 'maybe';  // promotion: '' -> 'maybe'
          if (opusBase && safeOpus(t2)) return 'maybe';
        }
        return res;
      };
    } catch (e) { warnOnce('cpt', 'canPlayType override failed:', e && e.message); }

    log('capability hooks active (vp9=' + vp9Base + ', opus=' + opusBase +
      ', promotion=' + !!CONFIG.ENABLE_CAPABILITY_PROMOTION +
      ', strict-audio=' + !!CONFIG.STRICT_AUDIO + ')');
  }


  // ---- Post-playback verification + optional nudge ----
  function getPlayerEl() {
    try { return document.getElementById('movie_player'); } catch (e) { return null; }
  }

  function currentHeight(qualityStr) {
    var m = /(\d{3,4})/.exec(String(qualityStr || ''));
    return m ? parseInt(m[1], 10) : null;
  }

  function checkCurrentCodecs(reason) {
    try {
      var p = getPlayerEl();
      if (!p || typeof p.getVideoData !== 'function') return;
      var d = p.getVideoData();
      if (!d) return;
      var vfam = codecFamily(d.videoCoding);
      var afam = codecFamily(d.audioCoding);
      if (d.video_id) state.currentVideoId = d.video_id;
      state.lastVideoData = {
        videoCoding: d.videoCoding || null,
        audioCoding: d.audioCoding || null,
        itag: d.itag || null,
        quality: d.quality || null,
        videoId: d.video_id || null
      };
      // Stable per-video key: never fall back to a shared '?' bucket, or the
      // once-per-video bookkeeping would collapse into a single global slot.
      var vid = d.video_id || state.lastVideoId || 'nokey';
      var strictNow = false;
      try { strictNow = isStrictEngagedNow(); } catch (e) {}
      var vOk = !d.videoCoding || vfam === CONFIG.VIDEO_PREFER;
      var aOk = !d.audioCoding || afam === CONFIG.AUDIO_PREFER;
      if (CONFIG.VERBOSE || !vOk || !aOk) {
        log('verification(' + reason + ') video=' + vid +
          ' -> videoCoding=' + (d.videoCoding || '-') + ' [' + vfam + ']' +
          ', audioCoding=' + (d.audioCoding || '-') + ' [' + afam + ']' +
          ' | vp9: ' + (vOk ? 'OK' : 'NOT VP9') + ', opus: ' + (aOk ? 'OK' : 'NOT OPUS') +
          (strictNow ? ' | strict-audio: ENGAGED' : '') +
          (state.sabr ? ' | SABR active' : ''));
      }
      // Engaged but the player still reports AAC: the block did not reach it.
      if (strictNow && d.audioCoding && afam !== 'opus') {
        warnOnce('strict-aac-' + vid, 'player still on AAC despite Strict Audio Mode ' +
          '(block did not reach the player, or SABR decided server-side) - video=' + vid);
      }
      // Nudge (best effort): once per video, only when a VP9 variant exists for
      // the same quality. NOTE: re-requesting the current quality is often a
      // no-op; the player may ignore it entirely.
      if (CONFIG.ENABLE_NUDGE && !vOk && d.videoCoding && !state.nudgedFor[vid]) {
        var h = currentHeight(d.quality);
        if (h != null && state.vp9Heights.indexOf(h) !== -1) {
          trackKey(state.nudgedFor, vid);
          try {
            var q = typeof p.getPlaybackQuality === 'function' ? p.getPlaybackQuality() : null;
            if (q && typeof p.setPlaybackQualityRange === 'function') {
              log('nudge: requesting quality re-selection ' + q + ' for video=' + vid +
                ' (best effort, may be a no-op)');
              p.setPlaybackQualityRange(q, q);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  var checkTimer = null;
  var pendingCheckReason = null;
  function scheduleCheck(reason) {
    // Trailing throttle: keep the latest reason and reschedule instead of
    // silently dropping triggers that arrive during the wait window.
    // (setTimeout returns a number in browsers, so the reason is kept in a
    // separate variable - attaching it to the handle would throw in strict mode.)
    if (checkTimer) {
      pendingCheckReason = reason;
      return;
    }
    pendingCheckReason = reason;
    checkTimer = setTimeout(function () {
      var r = pendingCheckReason;
      checkTimer = null;
      pendingCheckReason = null;
      checkCurrentCodecs(r || reason);
    }, 1500);
  }

  try { document.addEventListener('loadeddata', function () { scheduleCheck('loadeddata'); }, true); } catch (e) {}
  try { document.addEventListener('yt-navigate-finish', function () { scheduleCheck('navigate'); }, true); } catch (e) {}
  // Strict Audio failsafe: a *codec-related* media error while engaged triggers
  // recovery. Network/abort errors are ignored so a flaky connection does not
  // needlessly reload playback or permanently disable strict mode.
  try {
    document.addEventListener('error', function (ev) {
      try {
        if (!isStrictEngagedNow()) return;
        var el = ev && ev.target;
        var tag = el && el.tagName;
        if (tag !== 'VIDEO' && tag !== 'AUDIO' && tag !== 'SOURCE') return;
        var err = el && el.error;
        var code = err ? err.code : null;
        // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED.
        // 1 = aborted, 2 = network -> not codec related, let the player recover.
        if (code != null && code !== 3 && code !== 4) return;
        var d = null, p = getPlayerEl();
        if (p && typeof p.getVideoData === 'function') { try { d = p.getVideoData(); } catch (e2) {} }
        strictFailureRecovery('media-error' + (code != null ? ':' + code : ''), (d && d.video_id) || null);
      } catch (e) {}
    }, true);
  } catch (e) {}

  // ---- Debug API (use from the DevTools console) ----
  window.__VP9OPUS = {
    version: '0.2.1',
    config: CONFIG,
    state: state,
    toggleVerbose: function () { CONFIG.VERBOSE = !CONFIG.VERBOSE; log('VERBOSE =', CONFIG.VERBOSE); return CONFIG.VERBOSE; },
    toggleDebug: function () { CONFIG.DEBUG = !CONFIG.DEBUG; return CONFIG.DEBUG; },
    toggleStrictAudio: function () {
      CONFIG.STRICT_AUDIO = !CONFIG.STRICT_AUDIO;
      var vid = currentPlayingId();
      if (!CONFIG.STRICT_AUDIO) {
        // Apply immediately: the blocking check reads the engagement state, so
        // flipping the config alone would keep blocking until the next response.
        setStrictEngagement(false, vid, 'toggle-off');
      } else {
        // Re-engage right away when the last player response for this video
        // actually offered Opus (otherwise wait for the next response).
        if (vid) delete state.strictDisengagedFor[vid];
        var sameVideo = !vid || !state.lastVideoId || vid === state.lastVideoId;
        setStrictEngagement(!!(state.opusAvailable && sameVideo), vid, 'toggle-on');
      }
      log('STRICT_AUDIO =', CONFIG.STRICT_AUDIO, vid ? '(video=' + vid + ')' : '');
      return CONFIG.STRICT_AUDIO;
    },
    check: function () { checkCurrentCodecs('manual'); return state.lastVideoData; },
    audio: function () {
      var vid = currentPlayingId();
      var engagedNow = false;
      try { engagedNow = isStrictEngagedNow(); } catch (e) {}
      return {
        strictAudioEnabled: !!CONFIG.STRICT_AUDIO,
        engaged: !!state.strictEngaged,
        engagedNowForCurrentVideo: engagedNow,
        currentVideoId: vid,
        engagedFor: Object.keys(state.strictEngagedFor).filter(function (k) { return state.strictEngagedFor[k]; }),
        disengagedFor: Object.keys(state.strictDisengagedFor),
        opusSupport: state.opusBase,
        vp9Support: state.vp9Base,
        sabr: state.sabr,
        current: state.lastVideoData,
        audioFormats: (state.lastAudioFormats || []).slice(),
        events: state.strictEvents.slice(-10)
      };
    },
    dump: function () {
      return {
        version: '0.2.1',
        host: location.host,
        config: JSON.parse(JSON.stringify(CONFIG)),
        responsesProcessed: state.responsesProcessed,
        rewritesApplied: state.rewritesApplied,
        lastVideoId: state.lastVideoId,
        currentVideoId: state.currentVideoId,
        sabr: state.sabr,
        opusAvailable: state.opusAvailable,
        vp9Heights: state.vp9Heights.slice(),
        current: state.lastVideoData,
        lastSummary: state.lastSummary,
        nudged: Object.keys(state.nudgedFor)
      };
    }
  };

  log('active on ' + location.host + ' | preference: video=' + CONFIG.VIDEO_PREFER + ', audio=' + CONFIG.AUDIO_PREFER);
  installCapabilityPromotion();
})();
