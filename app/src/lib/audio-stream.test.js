import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SentenceStream } from './audio-stream.js';
import { useAudiobook } from './audiobook.js';

const original = globalThis.MediaSource;
class FakeBuffer extends EventTarget {
  end = 0;
  start = 0;
  buffered = { length: 1, start: () => this.start, end: () => this.end };
  remove(_start, end) {
    this.start = end;
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
  appendBuffer() {
    this.end += 5;
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
}
class FakeMediaSource extends Blob {
  constructor() { super(); FakeMediaSource.latest = this; }
  events = new EventTarget();
  readyState = 'open';
  static isTypeSupported(type) { return type === 'audio/mpeg'; }
  addEventListener(...args) { this.events.addEventListener(...args); }
  addSourceBuffer() { return this.buffer = new FakeBuffer(); }
  endOfStream() { this.readyState = 'ended'; }
  open() { this.events.dispatchEvent(new Event('sourceopen')); }
}
globalThis.MediaSource = FakeMediaSource;
after(() => {
  if (original === undefined) delete globalThis.MediaSource;
  else globalThis.MediaSource = original;
});

test('sentences share one media source and advance without restarting playback', async () => {
  let sourceChanges = 0;
  const audio = {
    currentTime: 0,
    set src(value) { sourceChanges++; this.source = value; },
    play() { assert.fail('sentence transitions must not call play'); },
    pause() { assert.fail('sentence transitions must not pause'); },
  };
  const stream = new SentenceStream(audio);
  stream.media.open();
  await stream.append(new Blob(['first']), 7);
  await stream.append(new Blob(['second']), 8);
  await stream.append(new Blob(['third']), 9);
  assert.equal(sourceChanges, 1);
  assert.equal(stream.buffer.mode, 'sequence');
  assert.deepEqual(stream.position(), { index: 7, time: 0, duration: 5 });
  audio.currentTime = 5;
  assert.deepEqual(stream.position(), { index: 8, time: 0, duration: 5 });
  audio.currentTime = 12;
  assert.deepEqual(stream.position(), { index: 9, time: 2, duration: 5 });
  stream.finish();
  assert.equal(stream.media.readyState, 'ended');
  stream.destroy();
});

test('stopping before sourceopen cancels pending initialization', async () => {
  const stream = new SentenceStream({});
  const pending = stream.append(new Blob(['sentence']), 0);
  stream.destroy();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('long playback removes old buffered audio while preserving sentence timestamps', async () => {
  const audio = { currentTime: 0 };
  const stream = new SentenceStream(audio);
  stream.media.open();
  for (let index = 0; index < 20; index++) await stream.append(new Blob(['mp3']), index);
  audio.currentTime = 90;
  await stream.append(new Blob(['next']), 20);
  assert.equal(stream.buffer.buffered.start(0), 30);
  assert.deepEqual(stream.parts.at(-1), { index: 20, start: 100, end: 105 });
  assert.deepEqual(stream.position(), { index: 18, time: 0, duration: 5 });
  stream.destroy();
});

test('browsers without MPEG MediaSource support can use the existing player', () => {
  assert.equal(SentenceStream.supported(), true);
  globalThis.MediaSource = undefined;
  assert.equal(SentenceStream.supported(), false);
  globalThis.MediaSource = FakeMediaSource;
});

test('reader prebuffers sentences, follows native playback and resumes without replacing source', async () => {
  const previousAudio = globalThis.Audio;
  const previousStorage = globalThis.localStorage;
  let player;
  class FakeAudio extends EventTarget {
    currentTime = 0;
    duration = Infinity;
    ended = false;
    paused = true;
    plays = 0;
    sourceChanges = 0;
    constructor() { super(); player = this; }
    set src(value) {
      this.source = value;
      this.sourceChanges++;
      this.currentTime = 0;
      queueMicrotask(() => FakeMediaSource.latest.open());
    }
    get src() { return this.source; }
    async play() {
      assert.ok(FakeMediaSource.latest.buffer.end >= 10, 'buffer short sentences before starting playback');
      this.paused = false;
      this.plays++;
      this.dispatchEvent(new Event('play'));
    }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    removeAttribute() { this.source = ''; }
    load() {}
  }
  globalThis.Audio = FakeAudio;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const requested = [];
  const followed = [];
  const segments = Array.from({ length: 20 }, (_, paragraph) => ({ paragraph }));
  let releaseNext;
  const slowNext = new Promise((resolve) => { releaseNext = resolve; });
  const reader = useAudiobook({
    api: {
      ttsConfig: async () => ({ enabled: true, voices: [{ id: 'xuyuyuan_v3.1' }] }),
      ttsSegments: async () => segments,
      ttsAudio: async (_book, _chapter, index) => {
        requested.push(index);
        if (index === 1) await slowNext;
        return { blob: new Blob(['mp3']), cost: 0 };
      },
    },
    book: { value: { id: 'sample', chapters: [{}] } }, chapterIndex: { value: 0 },
    readingParagraph: () => 0, followParagraph: (index) => followed.push(index), say() {},
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await reader.open();
    reader.setAccessCode('test');
    const starting = reader.play();
    await settle();
    assert.deepEqual(requested, [0, 1]);
    assert.equal(player.plays, 0, 'slow TTS must not start with only one short sentence');
    releaseNext();
    await starting;
    await settle();
    assert.deepEqual(requested, Array.from({ length: 9 }, (_, index) => index));
    // A previously queued pause event must not mark a currently playing source
    // paused or prevent its rolling buffer from being replenished.
    player.dispatchEvent(new Event('pause'));
    assert.equal(reader.state.playing, true);
    player.currentTime = 11;
    player.dispatchEvent(new Event('timeupdate'));
    await settle();
    assert.equal(reader.state.segment, 2);
    assert.equal(reader.state.currentTime, 1);
    assert.equal(reader.state.duration, 5);
    assert.equal(player.plays, 1);
    assert.equal(player.sourceChanges, 1);
    assert.deepEqual(followed, [0, 2]);
    assert.deepEqual(requested, Array.from({ length: 12 }, (_, index) => index));
    reader.pause();
    assert.equal(reader.state.playing, false);
    await reader.play();
    await settle();
    assert.equal(player.sourceChanges, 1);
    reader.skipSeconds(15);
    assert.equal(player.currentTime, 26);
    await reader.seekSegment(6);
    await settle();
    assert.equal(reader.state.segment, 6);
    assert.equal(player.sourceChanges, 2);
    assert.equal(reader.state.error, '');
  } finally {
    reader.destroy();
    globalThis.Audio = previousAudio;
    globalThis.localStorage = previousStorage;
  }
});
