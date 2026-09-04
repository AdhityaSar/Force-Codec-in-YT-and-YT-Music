// ==UserScript==
// @name         YouTube VP9 + Opus Prioritizer
// @namespace    https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music
// @version      0.2.0
// @description  Prioritize VP9 (video) & Opus (audio) on YouTube & YouTube Music. Does NOT block other codecs - only raises their priority; AVC/AAC/AV1 fallback keeps working. Optional Strict Audio Mode on YT Music (engages only when Opus exists, with auto-failsafe).
// @author       AdhityaSar
// @license      MIT
// @homepageURL  https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music
// @supportURL   https://github.com/AdhityaSar/Force-Codec-in-YT-and-YT-Music/issues
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
 *      with console logging, plus an optional one-shot quality re-nudge.
 *   4) Strict Audio Mode (OPTIONAL, on by default only on music.youtube.com):
 *      while engaged for a video, audio answers other than Opus (e.g. AAC)
 *      are reported as unsupported so the player picks the available Opus
 *      variant instead. It engages ONLY when an Opus variant exists in the
 *      response, and a watchdog auto-disengages + reloads playback once on
 *      any media error or stuck buffering. Video codecs are never blocked.
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
  var AUDIO_FAMILIES = ['opus', 'aac', 'flac', 'vorbis'];

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
    if (/mp4a|aac/.test(t)) return 'aac';             // mp4a.40.2, aac
    if (t.indexOf('flac') !== -1) return 'flac';
    if (t.indexOf('vorbis') !== -1) return 'vorbis';
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
  /* __CORE_END__ */


  // ===================================================================
  // RUNTIME (page context)
  // ===================================================================

  var state = {
    lastVideoId: null,
    sabr: false,
    vp9Heights: [],
    opusAvailable: false,
    nudgedFor: {},
    lastVideoData: null,
    lastSummary: null,
    rewrites: 0,
    lastAudioFormats: [],
    vp9Base: false,
    opusBase: false,
    strictEngaged: false,
    strictEngagedFor: {},
    strictDisengagedFor: {},
    strictEvents: [],
    strictWatch: {}
  };
  var warned = {};

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
    warned[key] = true;
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
      state.rewrites++;
      state.lastSummary = summary;
      rememberRewrite(json, summary);
      var vid = (json.videoDetails && json.videoDetails.videoId) || null;
      var allowStrict = !!CONFIG.STRICT_AUDIO && !!state.opusBase &&
        !(vid && state.strictDisengagedFor[vid]);
      setStrictEngagement(shouldEngageStrictAudio(json.streamingData, allowStrict), vid, srcLabel);
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

  /**
   * True when the given mimetype must be reported as unsupported because
   * Strict Audio Mode is engaged for the current video. Only audio codecs
   * other than Opus (e.g. AAC/MP4A) and MP4 muxed streams containing AAC
   * are affected; video codecs are never blocked.
   */
  function strictBlockMime(type) {
    if (!state.strictEngaged || typeof type !== 'string') return false;
    var parsed;
    try { parsed = parseMimeType(type); } catch (e) { return false; }
    if (!parsed) return false;
    if (parsed.kind === 'audio') return primaryFamily(parsed) !== 'opus';
    if (parsed.kind === 'video') return hasFamily(parsed, 'aac'); // MP4 muxed (avc+aac); pure video stays untouched
    return false;
  }

  function setStrictEngagement(engage, vid, srcLabel) {
    var next = !!engage;
    if (vid) state.strictEngagedFor[vid] = next;
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
    if (!state.strictEngaged) return;
    var key = vid || state.lastVideoId || 'unknown';
    if (state.strictDisengagedFor[key]) return;
    state.strictDisengagedFor[key] = true;
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

  /** Watchdog: while engaged, a stuck 'buffering' state triggers recovery. */
  function scheduleStrictWatchdog(vid) {
    try {
      if (state.strictWatch.__any) clearTimeout(state.strictWatch.__any);
      if (!state.strictEngaged) return;
      state.strictWatch.__any = setTimeout(function () {
        state.strictWatch.__any = null;
        try {
          var p = getPlayerEl();
          if (!p || typeof p.getPlayerState !== 'function') return;
          if (p.getPlayerState() === 'buffering') {
            var d = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
            strictFailureRecovery('stuck-buffering', (d && d.video_id) || vid);
          }
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
          return resp.clone().json().then(function (json) {
            var changed = processPlayerResponse(json, 'fetch');
            if (!changed) return resp;
            var headers = new Headers(resp.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(JSON.stringify(json), {
              status: resp.status,
              statusText: resp.statusText,
              headers: headers
            });
          }, function () { return resp; });
        } catch (e) { return resp; }
      });
    };
  }


  // ---- XMLHttpRequest hook (safety net; text responses only) ----
  try {
    var XHROpen = XMLHttpRequest.prototype.open;
    var XHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__ypfIsPlayer = isPlayerApiUrl(url); } catch (e) { this.__ypfIsPlayer = false; }
      return XHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (xhr.__ypfIsPlayer) {
        xhr.addEventListener('readystatechange', function () {
          try {
            if (xhr.readyState !== 4) return;
            var rt = xhr.responseType;
            if (rt && rt !== 'text') return;
            var text = rt === 'text' ? xhr.response : xhr.responseText;
            if (!text || text.charAt(0) !== '{') return;
            var json = JSON.parse(text);
            if (processPlayerResponse(json, 'xhr')) {
              var newText = JSON.stringify(json);
              Object.defineProperty(xhr, 'responseText', {
                get: function () { return newText; },
                configurable: true
              });
              Object.defineProperty(xhr, 'response', {
                get: function () { return newText; },
                configurable: true
              });
            }
          } catch (e) {}
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
      log('capability hooks skipped (browser does not support basic VP9/Opus)');
      return;
    }

    // VP9: only profile 0 (8-bit) is promoted (universally safe);
    // profile 2 (10-bit) keeps the native answer to avoid breaking playback.
    function safeVp9(t) {
      if (t.indexOf('video/webm') !== 0) return false;
      var m = /codecs\s*=\s*"([^"]*)"/i.exec(t);
      if (m && /^vp09\.02/.test(m[1].trim())) return false;
      return /vp0?9/i.test(t);
    }
    function safeOpus(t) { return t.indexOf('audio/webm') === 0 && t.indexOf('opus') !== -1; }

    try {
      var ms = window.MediaSource;
      var origITS = ms.isTypeSupported.bind(ms);
      ms.isTypeSupported = function (type) {
        try {
          if (strictBlockMime(type)) return false; // Strict Audio: conditional non-Opus audio block
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
          if (strictBlockMime(type)) return ''; // Strict Audio: conditional non-Opus audio block
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
      state.lastVideoData = {
        videoCoding: d.videoCoding || null,
        audioCoding: d.audioCoding || null,
        itag: d.itag || null,
        quality: d.quality || null,
        videoId: d.video_id || null
      };
      var vid = d.video_id || state.lastVideoId || '?';
      var vOk = !d.videoCoding || vfam === CONFIG.VIDEO_PREFER;
      var aOk = !d.audioCoding || afam === CONFIG.AUDIO_PREFER;
      if (CONFIG.VERBOSE || !vOk || !aOk) {
        log('verification(' + reason + ') video=' + vid +
          ' -> videoCoding=' + (d.videoCoding || '-') + ' [' + vfam + ']' +
          ', audioCoding=' + (d.audioCoding || '-') + ' [' + afam + ']' +
          ' | vp9: ' + (vOk ? 'OK' : 'NOT VP9') + ', opus: ' + (aOk ? 'OK' : 'NOT OPUS') +
          (state.strictEngaged ? ' | strict-audio: ENGAGED' : '') +
          (state.sabr ? ' | SABR active' : ''));
      }
      // Engaged but the player still reports AAC: the block did not reach it.
      if (state.strictEngaged && d.audioCoding && afam !== 'opus') {
        warnOnce('strict-aac-' + vid, 'player still on AAC despite Strict Audio Mode ' +
          '(block did not reach the player, or SABR decided server-side) - video=' + vid);
      }
      // Nudge: once per video, only when a VP9 variant exists for the same quality
      if (CONFIG.ENABLE_NUDGE && !vOk && d.videoCoding) {
        var h = currentHeight(d.quality);
        if (h != null && state.vp9Heights.indexOf(h) !== -1 && !state.nudgedFor[vid]) {
          state.nudgedFor[vid] = true;
          try {
            var q = typeof p.getPlaybackQuality === 'function' ? p.getPlaybackQuality() : null;
            if (q && typeof p.setPlaybackQualityRange === 'function') {
              log('nudge: requesting quality re-selection ' + q + ' for video=' + vid);
              p.setPlaybackQualityRange(q, q);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  var checkTimer = null;
  function scheduleCheck(reason) {
    if (checkTimer) return;
    checkTimer = setTimeout(function () {
      checkTimer = null;
      checkCurrentCodecs(reason);
    }, 1500);
  }

  try { document.addEventListener('loadeddata', function () { scheduleCheck('loadeddata'); }, true); } catch (e) {}
  try { document.addEventListener('yt-navigate-finish', function () { scheduleCheck('navigate'); }, true); } catch (e) {}
  // Strict Audio failsafe: any media element error while engaged triggers recovery
  try {
    document.addEventListener('error', function (ev) {
      try {
        if (!state.strictEngaged) return;
        var el = ev && ev.target;
        var tag = el && el.tagName;
        if (tag !== 'VIDEO' && tag !== 'AUDIO' && tag !== 'SOURCE') return;
        var d = null, p = getPlayerEl();
        if (p && typeof p.getVideoData === 'function') { try { d = p.getVideoData(); } catch (e2) {} }
        strictFailureRecovery('media-error' + (el && el.error ? ':' + el.error.code : ''), (d && d.video_id) || null);
      } catch (e) {}
    }, true);
  } catch (e) {}

  // ---- Debug API (use from the DevTools console) ----
  window.__VP9OPUS = {
    version: '0.2.0',
    config: CONFIG,
    state: state,
    toggleVerbose: function () { CONFIG.VERBOSE = !CONFIG.VERBOSE; log('VERBOSE =', CONFIG.VERBOSE); return CONFIG.VERBOSE; },
    toggleDebug: function () { CONFIG.DEBUG = !CONFIG.DEBUG; return CONFIG.DEBUG; },
    toggleStrictAudio: function () { CONFIG.STRICT_AUDIO = !CONFIG.STRICT_AUDIO; log('STRICT_AUDIO =', CONFIG.STRICT_AUDIO); return CONFIG.STRICT_AUDIO; },
    check: function () { checkCurrentCodecs('manual'); return state.lastVideoData; },
    audio: function () {
      return {
        strictAudioEnabled: !!CONFIG.STRICT_AUDIO,
        engaged: !!state.strictEngaged,
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
        version: '0.2.0',
        host: location.host,
        config: JSON.parse(JSON.stringify(CONFIG)),
        rewrites: state.rewrites,
        lastVideoId: state.lastVideoId,
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
