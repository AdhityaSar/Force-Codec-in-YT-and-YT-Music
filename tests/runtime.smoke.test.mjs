/**
 * Runtime smoke tests for force-codec-in-yt-and-yt-music.user.js
 *
 * The CORE unit tests (core.test.mjs) only cover the pure block. This file
 * runs the *whole* userscript inside a `vm` sandbox with hand-rolled browser
 * stubs (window/document/location/MediaSource/HTMLMediaElement/XMLHttpRequest)
 * and a virtual clock, so the RUNTIME behaviour can be verified:
 *   - fetch hook rewrites the format order (nothing dropped)
 *   - XHR getter returns the rewritten text
 *   - Strict Audio engagement is per-video (a prefetched response for another
 *     video must not block audio of the video that is playing)
 *   - toggleStrictAudio() takes effect immediately
 *   - the buffering watchdog uses the numeric player state and only reloads
 *     when the playback position is genuinely stuck
 *   - the media-error failsafe ignores network errors and reacts to codec errors
 *
 * Run: node tests/runtime.smoke.test.mjs
 */
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(rootDir, 'force-codec-in-yt-and-yt-music.user.js'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch (e) { failed++; console.error('  \u2717 ' + name + ' :: ' + (e && e.message)); }
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((msg || 'eq') + ' -> ' + ja + ' !== ' + jb);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// --------------------------------------------------------------------------
// Browser stubs
// --------------------------------------------------------------------------

function makePlayer() {
  const player = {
    videoId: 'AAAAAAAAAAA',
    state: 1,          // 1 = playing
    time: 10,
    reloads: [],
    nudges: []
  };
  player.getVideoData = () => ({
    video_id: player.videoId,
    videoCoding: 'avc1.640028',
    audioCoding: 'mp4a.40.2',
    itag: 137,
    quality: 'hd1080'
  });
  player.getPlayerState = () => player.state;
  player.getCurrentTime = () => player.time;
  player.getPlaybackQuality = () => 'hd1080';
  player.setPlaybackQualityRange = (a, b) => player.nudges.push([a, b]);
  player.loadVideoById = (id, time) => player.reloads.push([id, time]);
  return player;
}

function makeXHRClass(bodyFor) {
  return class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.responseType = '';
      this.status = 200;
      this._text = '';
      this._listeners = {};
      this._url = '';
    }
    open(method, url) { this._url = url; this.readyState = 1; }
    send() {
      this.readyState = 4;
      this._text = bodyFor ? bodyFor(this._url) : '';
      (this._listeners.readystatechange || []).slice().forEach((fn) => fn());
    }
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    get responseText() { return this._text; }
    get response() { return this._text; }
  };
}

function makeEnv(host = 'music.youtube.com') {
  const player = makePlayer();
  const docListeners = {};
  const logs = [];
  const warns = [];
  const timers = [];
  const errors = [];
  let now = 0;
  let timerSeq = 0;
  let currentBody = '{}';
  let xhrBody = '';

  const mediaSource = {
    isTypeSupported(type) {
      const s = String(type);
      if (/opus/i.test(s)) return true;
      if (/vp0?9/i.test(s)) return true;
      if (/mp4a|aac/i.test(s)) return true;   // native "true" so a block is observable
      if (/av01|avc1/i.test(s)) return true;
      return false;
    }
  };

  const htmlMediaElement = {
    prototype: {
      canPlayType() { return 'probably'; }
    }
  };

  const windowObj = {
    MediaSource: mediaSource,
    HTMLMediaElement: htmlMediaElement,
    fetch(input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/youtubei/v1/player') === -1) {
        return Promise.resolve(new Response('not-player'));
      }
      // Emulate a real fetch response: carry the request url on the response.
      const resp = new Response(currentBody, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
      Object.defineProperty(resp, 'url', { value: url, configurable: true });
      Object.defineProperty(resp, 'redirected', { value: false, configurable: true });
      return Promise.resolve(resp);
    }
  };

  const documentObj = {
    getElementById(id) { return id === 'movie_player' ? player : null; },
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    }
  };

  const sandbox = {
    window: windowObj,
    document: documentObj,
    location: { host, pathname: '/watch', href: 'https://' + host + '/watch' },
    console: {
      log: (...a) => logs.push(a),
      warn: (...a) => warns.push(a),
      error: () => {}
    },
    Headers,
    Response,
    setTimeout(fn, delay) {
      const id = ++timerSeq;
      timers.push({ id, fn, at: now + (delay || 0), seq: id });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((x) => x.id === id);
      if (i !== -1) timers.splice(i, 1);
    }
  };
  sandbox.XMLHttpRequest = makeXHRClass(() => xhrBody);

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      now = due.at;
      timers.splice(timers.indexOf(due), 1);
      try { due.fn(); } catch (e) { errors.push(e); }
    }
    now = target;
  }

  function fireDocumentEvent(type, target) {
    (docListeners[type] || []).slice().forEach((fn) => {
      try { fn({ type, target }); } catch (e) { errors.push(e); }
    });
  }

  return {
    sandbox, player, mediaSource, logs, warns, errors, advance, fireDocumentEvent,
    setBody(json) { currentBody = typeof json === 'string' ? json : JSON.stringify(json); },
    setXhrBody(json) { xhrBody = typeof json === 'string' ? json : JSON.stringify(json); },
    run() { vm.runInNewContext(src, sandbox, { filename: 'force-codec-in-yt-and-yt-music.user.js' }); },
    api() { return sandbox.window.__VP9OPUS; }
  };
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const VID_A = 'AAAAAAAAAAA'; // AAC only (no Opus variant)
const VID_B = 'BBBBB'; // has an Opus variant

const RESPONSE_A = {
  videoDetails: { videoId: VID_A },
  streamingData: {
    adaptiveFormats: [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, fps: 30 },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: 'AUDIO_QUALITY_MEDIUM' }
    ]
  }
};

const RESPONSE_B = {
  videoDetails: { videoId: VID_B },
  streamingData: {
    adaptiveFormats: [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, fps: 30 },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
      { itag: 248, mimeType: 'video/webm; codecs="vp9"', height: 1080, fps: 30 },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', audioQuality: 'AUDIO_QUALITY_MEDIUM' }
    ]
  }
};

const PLAYER_URL = 'https://music.youtube.com/youtubei/v1/player?prettyPrint=false';
const AAC = 'audio/mp4; codecs="mp4a.40.2"';
const OPUS = 'audio/webm; codecs="opus"';
const MUXED = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
const PURE_VIDEO = 'video/mp4; codecs="avc1.640028"';

// --------------------------------------------------------------------------
// fetch hook
// --------------------------------------------------------------------------

console.log('fetch hook');
{
  const env = makeEnv();
  env.run();
  const api = env.api();
  ok(api, 'debug API must be exposed');
  env.setBody(RESPONSE_B);

  const resp = await env.sandbox.window.fetch(PLAYER_URL);
  const json = await resp.json();
  const order = json.streamingData.adaptiveFormats.map((f) => f.itag);
  const otherText = await (await env.sandbox.window.fetch('https://music.youtube.com/other')).text();

  t('response body is rewritten in place', () => {
    eq(order, [248, 251, 137, 140], 'vp9/opus must come first inside each tier');
    eq(json.streamingData.adaptiveFormats.length, 4, 'no entry may be dropped');
  });
  t('url/redirected are preserved', () => {
    ok(resp.url === PLAYER_URL, 'url should survive the rewrite, got ' + resp.url);
    eq(resp.redirected, false);
  });
  t('summary counters are updated', () => {
    const d = api.dump();
    eq(d.responsesProcessed, 1);
    eq(d.rewritesApplied, 1);
    eq(d.opusAvailable, true);
    eq(d.vp9Heights, [1080]);
  });
  t('non-player requests are forwarded untouched', () => eq(otherText, 'not-player'));

  // A player response without a streaming format list is passed through
  // untouched (the cheap "streamingData" pre-filter skips it entirely).
  env.setBody({ videoDetails: { videoId: VID_A } });
  const resp2 = await env.sandbox.window.fetch(PLAYER_URL);
  const d2 = api.dump();
  t('response without streamingData is forwarded untouched & not counted', async () => {
    eq(d2.responsesProcessed, 1, 'the cheap pre-filter must skip it entirely');
    eq(d2.rewritesApplied, 1);
  });
  ok(resp2.ok, 'response should still be ok');
}

// --------------------------------------------------------------------------
// ytInitialPlayerResponse trap
// --------------------------------------------------------------------------

console.log('ytInitialPlayerResponse trap');
{
  const env = makeEnv();
  // Pre-populate before run() to verify it is not lost and is immediately processed
  env.sandbox.window.ytInitialPlayerResponse = {
    videoDetails: { videoId: 'PRE_EXISTING' },
    streamingData: {
      adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, fps: 30 },
        { itag: 248, mimeType: 'video/webm; codecs="vp9"', height: 1080, fps: 30 }
      ]
    }
  };
  env.run();
  const yipr = env.sandbox.window.ytInitialPlayerResponse;
  t('pre-existing ytInitialPlayerResponse is preserved and prioritized', () => {
    ok(yipr != null, 'must not be undefined');
    eq(yipr.videoDetails.videoId, 'PRE_EXISTING');
    eq(yipr.streamingData.adaptiveFormats.map((f) => f.itag), [248, 137]);
  });
}

// --------------------------------------------------------------------------
// XHR hook
// --------------------------------------------------------------------------

console.log('XHR hook');
{
  const env = makeEnv();
  env.run();
  env.setXhrBody(RESPONSE_B);

  const xhr = new env.sandbox.XMLHttpRequest();
  xhr.open('POST', PLAYER_URL);
  xhr.send();
  const text = xhr.responseText;

  t('rewritten text is returned by responseText', () => {
    const json = JSON.parse(text);
    eq(json.streamingData.adaptiveFormats.map((f) => f.itag), [248, 251, 137, 140]);
  });
  t('response mirrors responseText', () => eq(xhr.response, text));
  t('no runtime error was thrown', () => eq(env.errors.map((e) => e.message), []));
}

// --------------------------------------------------------------------------
// Strict Audio: per-video engagement (H2) + toggle (H3)
// --------------------------------------------------------------------------

console.log('strict audio per-video');
{
  const env = makeEnv();
  env.run();
  const api = env.api();
  env.setBody(RESPONSE_A);
  await env.sandbox.window.fetch(PLAYER_URL); // response for VID_A (no Opus)

  t('not engaged for a video without Opus', () => {
    eq(api.audio().engagedNowForCurrentVideo, false);
    ok(env.mediaSource.isTypeSupported(AAC), 'AAC must stay playable');
  });

  // A prefetched response for another video (which has Opus) must not block
  // audio of the video that is actually playing.
  env.setBody(RESPONSE_B);
  await env.sandbox.window.fetch(PLAYER_URL);
  t('prefetched Opus response does not block the playing video', () => {
    eq(env.player.videoId, VID_A, 'player is still on the AAC-only video');
    eq(api.audio().engagedNowForCurrentVideo, false, 'must stay native for VID_A');
    ok(env.mediaSource.isTypeSupported(AAC), 'AAC of VID_A must not be blocked');
    eq(api.audio().engaged, true, 'global cache may be engaged');
  });

  // Now the player actually switches to the Opus-capable video.
  env.player.videoId = VID_B;
  t('engages for the video that has Opus', () => {
    eq(api.audio().engagedNowForCurrentVideo, true);
    eq(env.mediaSource.isTypeSupported(AAC), false, 'AAC must be blocked while engaged');
    eq(env.mediaSource.isTypeSupported(MUXED), false, 'muxed MP4 with AAC must be blocked');
    ok(env.mediaSource.isTypeSupported(OPUS), 'Opus must stay supported');
    ok(env.mediaSource.isTypeSupported(PURE_VIDEO), 'video-only codecs are never blocked');
  });

  t('canPlayType is blocked consistently', () => {
    const proto = env.sandbox.window.HTMLMediaElement.prototype;
    eq(proto.canPlayType(AAC), '');
    eq(proto.canPlayType(PURE_VIDEO), 'probably');
  });

  t('toggleStrictAudio(false) releases the block immediately', () => {
    eq(api.toggleStrictAudio(), false);
    eq(api.audio().engagedNowForCurrentVideo, false);
    ok(env.mediaSource.isTypeSupported(AAC), 'AAC must be playable again');
  });

  t('toggleStrictAudio(true) re-engages immediately', () => {
    eq(api.toggleStrictAudio(), true);
    eq(api.audio().engagedNowForCurrentVideo, true);
    eq(env.mediaSource.isTypeSupported(AAC), false);
  });
}

// Per-video engagement history is bounded to avoid growing for the lifetime
// of a long-running YouTube tab.
{
  const env = makeEnv();
  env.run();
  for (let i = 0; i < 205; i++) {
    env.sandbox.window.ytInitialPlayerResponse = {
      videoDetails: { videoId: 'VIDEO' + i },
      streamingData: {
        adaptiveFormats: [{ itag: 251, mimeType: 'audio/webm; codecs="opus"' }]
      }
    };
  }
  const tracked = Object.keys(env.api().state.strictEngagedFor);
  t('per-video engagement history stays bounded', () => {
    eq(tracked.length, 200);
    ok(!tracked.includes('VIDEO0'), 'oldest video id should be evicted');
    ok(tracked.includes('VIDEO204'), 'most recent video id should be retained');
  });
}

// --------------------------------------------------------------------------
// Watchdog (H1) + media-error failsafe (M2)
// --------------------------------------------------------------------------

console.log('watchdog & failsafe');

/** Fresh env engaged for VID_B with the playback position frozen at `time`. */
async function engagedEnv(time) {
  const env = makeEnv();
  env.run();
  env.player.videoId = VID_B;
  env.player.time = time;      // must be set *before* the response schedules the watchdog
  env.setBody(RESPONSE_B);
  await env.sandbox.window.fetch(PLAYER_URL);
  ok(env.api().audio().engagedNowForCurrentVideo, 'precondition: engaged for VID_B');
  return env;
}

{
  // Numeric player state 3 (buffering) with a frozen position -> recovery.
  const env = await engagedEnv(42);
  env.player.state = 3;
  env.advance(9100);
  t('stuck buffering (numeric state) triggers recovery', () => {
    eq(env.player.reloads.length, 1, 'playback must be reloaded once');
    eq(env.player.reloads[0], [VID_B, 42]);
    eq(env.api().audio().engagedNowForCurrentVideo, false, 'strict must be released');
  });
  t('failsafe disengages only once per video', () => {
    env.advance(20000);
    eq(env.player.reloads.length, 1);
  });
}
{
  // String player state is accepted too.
  const env = await engagedEnv(30);
  env.player.state = 'buffering';
  env.advance(9100);
  t('string player state is also accepted', () => eq(env.player.reloads.length, 1));
}
{
  // Buffering but the position keeps advancing -> healthy, no reload.
  const env = await engagedEnv(10);
  env.player.state = 3;
  env.advance(4000);
  env.player.time = 18;
  env.advance(6000);
  t('healthy buffering does not trigger a reload', () => eq(env.player.reloads.length, 0));
}
{
  // Playing (state 1) with a frozen position must never trigger a reload.
  const env = await engagedEnv(7);
  env.player.state = 1;
  env.advance(20000);
  t('playing state never triggers the watchdog', () => eq(env.player.reloads.length, 0));
}
{
  const env = await engagedEnv(5);

  t('network errors are ignored by the failsafe', () => {
    env.fireDocumentEvent('error', { tagName: 'VIDEO', error: { code: 2 } });
    eq(env.player.reloads.length, 0);
  });
  t('codec errors trigger recovery', () => {
    env.fireDocumentEvent('error', { tagName: 'VIDEO', error: { code: 4 } });
    eq(env.player.reloads.length, 1);
  });
}

// --------------------------------------------------------------------------
// Verification & nudge for SD named quality levels
// --------------------------------------------------------------------------

console.log('verification & nudge');
{
  const env = makeEnv();
  env.run();
  const api = env.api();
  // Player response offering 480p VP9
  env.setBody({
    videoDetails: { videoId: 'SD_VID' },
    streamingData: {
      adaptiveFormats: [
        { itag: 244, mimeType: 'video/webm; codecs="vp9"', height: 480, fps: 30 },
        { itag: 135, mimeType: 'video/mp4; codecs="avc1.4d401e"', height: 480, fps: 30 }
      ]
    }
  });
  await env.sandbox.window.fetch(PLAYER_URL);
  eq(api.state.vp9Heights, [480]);

  // Player playing AVC at "large" (standard YouTube name for 480p)
  env.player.videoId = 'SD_VID';
  env.player.getVideoData = () => ({
    video_id: 'SD_VID',
    videoCoding: 'avc1.4d401e',
    audioCoding: 'opus',
    quality: 'large'
  });
  env.player.getPlaybackQuality = () => 'large';

  api.check();
  t('nudge fires for named SD quality level (large -> 480p)', () => {
    eq(env.player.nudges.length, 1);
    eq(env.player.nudges[0], ['large', 'large']);
  });
}

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
