/**
 * Unit tests for the CORE block of force-codec-in-yt-and-yt-music.user.js
 * Run: node tests/core.test.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(rootDir, 'force-codec-in-yt-and-yt-music.user.js');
const src = readFileSync(scriptPath, 'utf8');

const match = src.match(/\/\* __CORE_START__ \*\/([\s\S]*?)\/\* __CORE_END__ \*\//);
if (!match) throw new Error('Markers /* __CORE_START__ */ / /* __CORE_END__ */ not found in the userscript');

const core = new Function(
  '"use strict";\n' + match[1] +
  '\nreturn { parseMimeType, codecFamily, primaryFamily, tierKey, hasFamily, shouldEngageStrictAudio, prioritizeFormats, prioritizeStreamingData, strictBlockMime, isSafeVp9Promotion, isSafeOpusPromotion, STRICT_BLOCKED_AUDIO_FAMILIES };'
)();

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

console.log('parseMimeType');
t('vp09 webm', () => {
  const p = core.parseMimeType('video/webm; codecs="vp09.00.51.08"');
  eq(p.container, 'video/webm'); eq(p.kind, 'video'); eq(p.codecs, ['vp09.00.51.08']);
});
t('multi codec (muxed)', () => {
  const p = core.parseMimeType('video/mp4; codecs="avc1.640028, mp4a.40.2"');
  eq(p.kind, 'video'); eq(p.codecs, ['avc1.640028', 'mp4a.40.2']);
});
t('without codecs param', () => {
  const p = core.parseMimeType('audio/webm');
  eq(p.kind, 'audio'); eq(p.codecs, []);
});
t('invalid input -> null', () => eq(core.parseMimeType(undefined), null));

console.log('codecFamily');
t('vp9/vp09 -> vp9', () => { eq(core.codecFamily('vp9'), 'vp9'); eq(core.codecFamily('vp09.00.51.08'), 'vp9'); });
t('vp8 -> vp8', () => eq(core.codecFamily('vp8'), 'vp8'));
t('av01/av99 -> av1', () => { eq(core.codecFamily('av01.0.08M.08'), 'av1'); eq(core.codecFamily('av99'), 'av1'); });
t('avc1/h264 -> avc', () => { eq(core.codecFamily('avc1.640028'), 'avc'); eq(core.codecFamily('h264'), 'avc'); });
t('opus -> opus', () => eq(core.codecFamily('opus'), 'opus'));
t('mp4a.40.2 -> aac', () => eq(core.codecFamily('mp4a.40.2'), 'aac'));
t('mp3 -> mp3', () => eq(core.codecFamily('mp3'), 'mp3'));
t('unknown -> unknown', () => eq(core.codecFamily('ec-3'), 'unknown'));

console.log('primaryFamily');
t('muxed video/mp4 -> avc (not aac)', () =>
  eq(core.primaryFamily(core.parseMimeType('video/mp4; codecs="avc1.640028, mp4a.40.2"')), 'avc'));
t('audio/webm opus -> opus', () =>
  eq(core.primaryFamily(core.parseMimeType('audio/webm; codecs="opus"')), 'opus'));


console.log('prioritizeFormats');
const AF = [
  { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, fps: 30 },
  { itag: 251, mimeType: 'audio/webm; codecs="opus"', audioQuality: 'AUDIO_QUALITY_MEDIUM', bitrate: 160000 },
  { itag: 248, mimeType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, fps: 30 },
  { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: 'AUDIO_QUALITY_MEDIUM', bitrate: 130000 },
  { itag: 299, mimeType: 'video/mp4; codecs="avc1.64002a"', width: 1920, height: 1080, fps: 60 },
  { itag: 398, mimeType: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080, fps: 30 },
  { itag: 303, mimeType: 'video/webm; codecs="vp09.00.51.08"', width: 1920, height: 1080, fps: 60 }
];
const r = core.prioritizeFormats(AF);
const order = r.list.map(f => f.itag);
t('no entries dropped (proves nothing is blocked)', () => eq(r.list.length, AF.length));
t('itag multiset identical', () =>
  eq(order.slice().sort((a, b) => a - b), AF.map(f => f.itag).sort((a, b) => a - b)));
t('1080p60: vp9 (303) before avc (299)', () => ok(order.indexOf(303) < order.indexOf(299)));
t('1080p30: vp9 (248) before avc (137) & av1 (398)', () =>
  ok(order.indexOf(248) < order.indexOf(137) && order.indexOf(248) < order.indexOf(398)));
t('audio: opus (251) before aac (140)', () => ok(order.indexOf(251) < order.indexOf(140)));
t('entry objects identical (not cloned/modified)', () =>
  ok(r.list.every(f => AF.indexOf(f) !== -1)));
t('changed ordering returns a replacement array', () => ok(r.list !== AF));
t('idempotent (running twice gives the same result)', () => {
  const r2 = core.prioritizeFormats(r.list);
  eq(r2.list.map(f => f.itag), order);
  eq(r2.moved, 0);
  ok(r2.list === r.list, 'unchanged ordering should return the original array');
  eq([r2.videoMoved, r2.audioMoved, r2.groups], [0, 0, r.groups]);
});
t('stable when the preferred codec is absent in a tier', () => {
  const noVp9 = [
    { itag: 1, mimeType: 'video/mp4; codecs="av01.0.08M.08"', height: 720, fps: 30 },
    { itag: 2, mimeType: 'video/mp4; codecs="avc1.64001f"', height: 720, fps: 30 },
    { itag: 3, mimeType: 'video/mp4; codecs="av01.0.05M.08"', height: 720, fps: 30 }
  ];
  eq(core.prioritizeFormats(noVp9).list.map(f => f.itag), [1, 2, 3]);
});
t('short/invalid arrays are safe', () => {
  eq(core.prioritizeFormats([]).list, []);
  eq(core.prioritizeFormats(null).list, []);
});

console.log('prioritizeStreamingData');
t('reorders adaptiveFormats (in-place) + summary', () => {
  const sd = {
    adaptiveFormats: AF.slice(),
    formats: [{ itag: 22, mimeType: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"', height: 720 }]
  };
  const s = core.prioritizeStreamingData(sd);
  ok(s.touched === true, 'touched must be true');
  eq(sd.adaptiveFormats.map(f => f.itag), [248, 251, 137, 140, 303, 398, 299]);
  eq(sd.formats.length, 1);
});
t('SABR detection via serverAbrStreamingUrl', () => {
  const sd = { serverAbrStreamingUrl: 'https://example/sabr', adaptiveFormats: [{ itag: 303, mimeType: 'video/webm; codecs="vp09.00.51.08"' }] };
  eq(core.prioritizeStreamingData(sd).sabr, true);
});
t('SABR detection via formats without url', () => {
  const sd = { adaptiveFormats: [
    { itag: 303, mimeType: 'video/webm; codecs="vp09.00.51.08"', height: 1080 },
    { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080 }
  ] };
  const s = core.prioritizeStreamingData(sd);
  eq(s.sabr, true);
  eq(sd.adaptiveFormats[0].itag, 303);
});
t('no SABR when url is present', () => {
  const sd = { adaptiveFormats: [
    { itag: 303, url: 'https://x', mimeType: 'video/webm; codecs="vp09.00.51.08"', height: 1080 },
    { itag: 137, url: 'https://y', mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080 }
  ] };
  eq(core.prioritizeStreamingData(sd).sabr, false);
});
t('null/empty object safe', () => {
  eq(core.prioritizeStreamingData(null).touched, false);
  eq(core.prioritizeStreamingData({}).touched, false);
});

console.log('strict audio engagement');
t('engages when an Opus variant exists', () =>
  eq(core.shouldEngageStrictAudio({
    adaptiveFormats: [
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"' }
    ]
  }, true), true));
t('does not engage without any Opus variant', () =>
  eq(core.shouldEngageStrictAudio({
    adaptiveFormats: [
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"' }
    ]
  }, true), false));
t('does not engage when strict audio is disabled', () =>
  eq(core.shouldEngageStrictAudio({ adaptiveFormats: [{ itag: 251, mimeType: 'audio/webm; codecs="opus"' }] }, false), false));
t('null/empty safe', () => {
  eq(core.shouldEngageStrictAudio(null, true), false);
  eq(core.shouldEngageStrictAudio({}, true), false);
});

console.log('hasFamily');
t('detects aac inside muxed codecs', () =>
  eq(core.hasFamily(core.parseMimeType('video/mp4; codecs="avc1.640028, mp4a.40.2"'), 'aac'), true));
t('pure video has no aac', () =>
  eq(core.hasFamily(core.parseMimeType('video/mp4; codecs="avc1.640028"'), 'aac'), false));
t('opus not aac', () =>
  eq(core.hasFamily(core.parseMimeType('audio/webm; codecs="opus"'), 'aac'), false));
t('null parsed safe', () => eq(core.hasFamily(null, 'aac'), false));

console.log('strictBlockMime (pure)');
t('blocks AAC audio while engaged', () =>
  eq(core.strictBlockMime('audio/mp4; codecs="mp4a.40.2"', true), true));
t('allows Opus audio while engaged', () =>
  eq(core.strictBlockMime('audio/webm; codecs="opus"', true), false));
t('blocks MP4 muxed streams containing AAC', () =>
  eq(core.strictBlockMime('video/mp4; codecs="avc1.640028, mp4a.40.2"', true), true));
t('never blocks pure video', () => {
  eq(core.strictBlockMime('video/mp4; codecs="avc1.640028"', true), false);
  eq(core.strictBlockMime('video/webm; codecs="vp9"', true), false);
});
t('fail-open for unknown audio families', () => {
  eq(core.strictBlockMime('audio/mp4; codecs="alac"', true), false);
  eq(core.strictBlockMime('audio/mp4; codecs="ec-3"', true), false);
});
t('blocks other known non-Opus families', () => {
  eq(core.strictBlockMime('audio/webm; codecs="vorbis"', true), true);
  eq(core.strictBlockMime('audio/ogg; codecs="flac"', true), true);
  eq(core.strictBlockMime('audio/mpeg; codecs="mp3"', true), true);
});
t('no blocking while not engaged', () => {
  eq(core.strictBlockMime('audio/mp4; codecs="mp4a.40.2"', false), false);
  eq(core.strictBlockMime('video/mp4; codecs="avc1.640028, mp4a.40.2"', false), false);
});
t('invalid input safe', () => {
  eq(core.strictBlockMime(null, true), false);
  eq(core.strictBlockMime(undefined, true), false);
  eq(core.strictBlockMime('audio/mp4', true), false);
});
t('blocked family list is explicit (no unknown)', () =>
  ok(core.STRICT_BLOCKED_AUDIO_FAMILIES.indexOf('unknown') === -1));

console.log('promotion safety (pure)');
t('vp9 webm is promotable', () => {
  eq(core.isSafeVp9Promotion('video/webm; codecs="vp9"'), true);
  eq(core.isSafeVp9Promotion('video/webm; codecs="vp09.00.51.08"'), true);
});
t('vp9 profile 2 (10-bit) is not promoted', () =>
  eq(core.isSafeVp9Promotion('video/webm; codecs="vp09.02.51.10"'), false));
t('vp9 outside webm is not promoted', () =>
  eq(core.isSafeVp9Promotion('video/mp4; codecs="vp09.00.51.08"'), false));
t('non-vp9 is not promoted', () => {
  eq(core.isSafeVp9Promotion('video/webm; codecs="av01.0.08M.08"'), false);
  eq(core.isSafeVp9Promotion(''), false);
  eq(core.isSafeVp9Promotion(null), false);
});
t('opus webm is promotable', () =>
  eq(core.isSafeOpusPromotion('audio/webm; codecs="opus"'), true));
t('opus outside webm is not promoted', () => {
  eq(core.isSafeOpusPromotion('audio/mp4; codecs="opus"'), false);
  eq(core.isSafeOpusPromotion('audio/webm; codecs="vorbis"'), false);
  eq(core.isSafeOpusPromotion(null), false);
});

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

