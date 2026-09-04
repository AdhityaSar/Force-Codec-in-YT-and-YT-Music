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
  '\nreturn { parseMimeType, codecFamily, primaryFamily, tierKey, prioritizeFormats, prioritizeStreamingData };'
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
t('idempotent (running twice gives the same result)', () => {
  const r2 = core.prioritizeFormats(r.list);
  eq(r2.list.map(f => f.itag), order);
  eq(r2.moved, 0);
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

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);


