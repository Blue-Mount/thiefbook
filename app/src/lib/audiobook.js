import { computed, reactive } from 'vue';
import { storage } from './storage.js';
import { SentenceStream } from './audio-stream.js';

export function formatAudioTime(value) {
  if (!Number.isFinite(value)) return '0:00';
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function useAudiobook({ api, book, chapterIndex, goChapter, readingParagraph, followParagraph, say }) {
  const saved = storage.getListening();
  const state = reactive({
    open: false,
    enabled: false,
    checking: false,
    voices: [],
    voice: saved.voice === 'longyuan_v3.1' ? 'xuyuyuan_v3.1' : saved.voice || 'xuyuyuan_v3.1',
    rate: Number(saved.rate) || 1,
    accessCode: saved.accessCode || '',
    segments: [],
    started: false,
    bookId: '',
    chapter: -1,
    segment: 0,
    playing: false,
    loading: false,
    currentTime: 0,
    duration: 0,
    cost: 0,
    sleep: 'off',
    sleepUntil: 0,
    remaining: 0,
    error: '',
  });
  const active = computed(() => state.segments.length > 0 && state.bookId === book.value?.id);
  const chapterProgress = computed(() => state.segments.length
    ? Math.round(100 * (state.segment + (state.duration ? state.currentTime / state.duration : 0)) / state.segments.length)
    : 0);
  const audio = new Audio();
  audio.preload = 'auto';
  let generation = 0;
  let currentAbort = null;
  let nextAbort = null;
  let nextPromise = null;
  let nextIndex = -1;
  let objectUrl = null;
  let stream = null;
  let streamAbort = null;
  let streamFill = null;
  let streamFailed = false;

  function bufferedAhead(target = stream) {
    return Math.max(0, (target?.parts.at(-1)?.end || 0) - audio.currentTime);
  }

  function savePreferences() {
    storage.setListening({ voice: state.voice, rate: state.rate, accessCode: state.accessCode });
  }

  function clearPrefetch() {
    nextAbort?.abort();
    nextAbort = null;
    nextPromise = null;
    nextIndex = -1;
  }

  function clearAudio() {
    streamAbort?.abort();
    streamAbort = null;
    streamFill = null;
    streamFailed = false;
    stream?.destroy();
    stream = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    state.playing = false;
    state.currentTime = 0;
    state.duration = 0;
  }

  function cancelLoad() {
    generation++;
    currentAbort?.abort();
    currentAbort = null;
    clearPrefetch();
    state.loading = false;
  }

  function stop(close = false) {
    cancelLoad();
    clearAudio();
    state.segments = [];
    state.started = false;
    state.bookId = '';
    state.chapter = -1;
    state.sleep = 'off';
    state.sleepUntil = 0;
    state.remaining = 0;
    if (close) state.open = false;
  }

  async function checkConfig() {
    state.checking = true;
    try {
      const config = await api.ttsConfig();
      state.enabled = config.enabled;
      state.voices = config.voices || [];
      if (!state.voices.some((item) => item.id === state.voice)) {
        state.voice = state.voices[0]?.id || state.voice;
      }
    } catch (error) {
      state.enabled = false;
      state.error = error.message;
    } finally {
      state.checking = false;
    }
  }

  async function loadChapter(index, fromReadingPosition = false) {
    const bookId = book.value?.id;
    if (!bookId) return false;
    const serial = ++generation;
    state.loading = true;
    state.error = '';
    try {
      const segments = await api.ttsSegments(bookId, index);
      if (serial !== generation || book.value?.id !== bookId) return false;
      state.segments = segments;
      state.bookId = bookId;
      state.chapter = index;
      const paragraph = fromReadingPosition ? readingParagraph() : -1;
      const saved = fromReadingPosition ? storage.getProgress(bookId) : null;
      state.segment = saved?.chapter === index && saved.mode === 'audio' &&
        Number.isInteger(saved.segment) && saved.segment >= 0 && saved.segment < segments.length
        ? saved.segment : Math.max(0, segments.findIndex((part) => part.paragraph >= paragraph));
      return segments.length > 0;
    } catch (error) {
      if (serial === generation) state.error = error.message;
      return false;
    } finally {
      if (serial === generation) state.loading = false;
    }
  }

  async function open() {
    state.open = true;
    state.error = '';
    await checkConfig();
    if (!active.value || state.chapter !== chapterIndex.value) await loadChapter(chapterIndex.value, true);
  }

  async function fetchSegment(index, signal) {
    const result = await api.ttsAudio(state.bookId, state.chapter, index, state.voice, state.accessCode, signal);
    state.cost += result.cost;
    return result.blob;
  }

  function prefetchNext() {
    if (stream) { fillStream(); return; }
    const index = state.segment + 1;
    if (nextPromise || index >= state.segments.length || !state.playing) return;
    nextIndex = index;
    nextAbort = new AbortController();
    nextPromise = fetchSegment(index, nextAbort.signal).catch(() => null);
  }

  function fillStream() {
    if (!stream || streamFill || streamFailed || !state.playing) return;
    const target = stream;
    const controller = new AbortController();
    streamAbort = controller;
    const task = (async () => {
      let index = target.parts.at(-1).index + 1;
      // Sentence counts are not a useful buffer budget: several short sentences
      // can run out before a background TTS request finishes.
      while (stream === target && state.playing && index < state.segments.length &&
          bufferedAhead(target) < 45 * state.rate && index <= state.segment + 24) {
        const blob = await fetchSegment(index, controller.signal);
        if (stream !== target || controller.signal.aborted) return;
        await target.append(blob, index++);
      }
      if (stream === target && index === state.segments.length) target.finish();
    })().catch((error) => {
      if (stream === target && error.name !== 'AbortError') {
        streamFailed = true;
        state.error = error.message;
      }
    }).finally(() => {
      if (streamFill === task) { streamFill = null; streamAbort = null; }
    });
    streamFill = task;
  }

  async function playSegment(index) {
    if (index < 0 || index >= state.segments.length) return;
    const serial = ++generation;
    currentAbort?.abort();
    currentAbort = new AbortController();
    const prefetched = nextIndex === index ? nextPromise : null;
    if (prefetched) {
      nextAbort = null;
      nextPromise = null;
      nextIndex = -1;
    } else {
      clearPrefetch();
    }
    clearAudio();
    state.segment = index;
    state.loading = true;
    state.error = '';
    try {
      const blob = await (prefetched ? prefetched.then((value) => value || fetchSegment(index, currentAbort.signal))
        : fetchSegment(index, currentAbort.signal));
      if (serial !== generation) return;
      if (!blob) throw new Error('语音预加载失败');
      if (SentenceStream.supported()) {
        const target = new SentenceStream(audio);
        stream = target;
        await target.append(blob, index);
        if (serial !== generation) return;
        // Establish a playable runway before handing playback to Android. This
        // also avoids starting very short audio before full media focus exists.
        let next = index + 1;
        while (next < state.segments.length && bufferedAhead(target) < 10 * state.rate && next <= index + 12) {
          const nextBlob = await fetchSegment(next, currentAbort.signal);
          if (serial !== generation) return;
          await target.append(nextBlob, next++);
          if (serial !== generation) return;
        }
        if (next === state.segments.length) target.finish();
      } else {
        objectUrl = URL.createObjectURL(blob);
        audio.src = objectUrl;
      }
      audio.playbackRate = state.rate;
      await audio.play();
      if (serial !== generation) return;
      state.started = true;
      state.playing = true;
      followParagraph(state.segments[index].paragraph);
      updateMediaSession();
      prefetchNext();
    } catch (error) {
      if (serial !== generation) return;
      state.error = error.name === 'NotAllowedError' ? '请再点一次播放，浏览器需要确认播放手势' : error.message;
      state.playing = false;
    } finally {
      if (serial === generation) state.loading = false;
    }
  }

  async function play() {
    savePreferences();
    if (!state.enabled) { state.error = '请先在服务端配置阿里云语音'; return; }
    if (!state.accessCode.trim()) { state.error = '请先填写听书密码'; return; }
    if (!active.value || state.chapter !== chapterIndex.value) {
      if (!await loadChapter(chapterIndex.value, true)) return;
    }
    if (audio.src && !audio.ended && audio.currentTime < audio.duration) {
      try {
        await audio.play();
        state.playing = true;
        state.error = '';
        streamFailed = false;
        prefetchNext();
      } catch (error) {
        state.error = error.message;
      }
      return;
    }
    await playSegment(state.segment);
  }

  function pause() {
    if (state.loading) {
      cancelLoad();
      clearAudio();
    }
    audio.pause();
    streamAbort?.abort();
    clearPrefetch();
    state.playing = false;
  }

  async function toggle() {
    if (state.playing || state.loading) pause();
    else await play();
  }

  async function seekSegment(index) {
    if (!state.segments.length) return;
    if (!state.enabled || !state.accessCode.trim()) { state.error = '请先配置语音服务并填写听书密码'; return; }
    await playSegment(Math.max(0, Math.min(state.segments.length - 1, index)));
  }

  async function startAtPosition(paragraph, offset) {
    state.open = true;
    if (!state.voices.length) await checkConfig();
    if (!active.value || state.chapter !== chapterIndex.value) {
      if (!await loadChapter(chapterIndex.value)) return;
    }
    const index = state.segments.findIndex((part) =>
      part.paragraph === paragraph && part.start <= offset && offset < part.end);
    if (index < 0) { state.error = '找不到这句的朗读内容'; return; }
    state.segment = index;
    if (!state.enabled || !state.accessCode.trim()) {
      state.error = !state.enabled ? '请先在服务端配置阿里云语音' : '请先填写听书密码，再点播放';
      return;
    }
    await playSegment(index);
  }

  function skipSeconds(amount) {
    const end = stream?.parts.at(-1)?.end ?? audio.duration;
    const start = stream?.buffer?.buffered.length ? stream.buffer.buffered.start(0) : 0;
    if (!audio.src || !Number.isFinite(end)) return;
    audio.currentTime = Math.max(start, Math.min(Math.max(start, end - 0.1), audio.currentTime + amount));
  }

  async function jumpChapter(delta) {
    if (!state.enabled || !state.accessCode.trim()) { state.error = '请先配置语音服务并填写听书密码'; return; }
    const next = state.chapter + delta;
    if (next < 0 || next >= (book.value?.chapters.length || 0)) return;
    cancelLoad();
    clearAudio();
    if (!await goChapter(next, 0, true, true, true)) return;
    if (await loadChapter(next)) await playSegment(0);
  }

  async function advance() {
    if (state.sleep === 'chapter' && state.segment === state.segments.length - 1) {
      pause();
      say('本章播完，已停止朗读');
      return;
    }
    if (state.segment < state.segments.length - 1) await playSegment(state.segment + 1);
    else if (state.chapter < (book.value?.chapters.length || 0) - 1) await jumpChapter(1);
    else {
      pause();
      say('全书播完了');
    }
  }

  function setRate(value) {
    state.rate = Math.max(0.75, Math.min(2, Number(value) || 1));
    audio.playbackRate = state.rate;
    savePreferences();
  }

  function setVoice(value) {
    if (!state.voices.some((item) => item.id === value)) return;
    if (state.voice === value) return;
    state.voice = value;
    savePreferences();
    if (state.playing || state.loading) void playSegment(state.segment);
    else { cancelLoad(); clearAudio(); }
  }

  function setAccessCode(value) {
    state.accessCode = value;
    savePreferences();
  }

  function setSleep(value) {
    state.sleep = value;
    state.sleepUntil = Number(value) ? Date.now() + Number(value) * 60000 : 0;
    state.remaining = Number(value) ? Number(value) * 60 : 0;
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.value?.chapters[state.chapter]?.title || '听书',
      artist: book.value?.author || book.value?.title || '摸鱼看书',
      album: book.value?.title || '摸鱼看书',
    });
    navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
  }

  audio.addEventListener('timeupdate', () => {
    const position = stream?.position();
    if (position) {
      if (state.segment !== position.index) {
        state.segment = position.index;
        followParagraph(state.segments[position.index].paragraph);
      }
      state.currentTime = position.time;
      state.duration = position.duration;
      prefetchNext();
    } else {
      state.currentTime = audio.currentTime || 0;
      state.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (state.duration && state.currentTime / state.duration > 0.45) prefetchNext();
    }
  });
  audio.addEventListener('ended', () => {
    if (stream) state.segment = stream.parts.at(-1)?.index ?? state.segment;
    void advance();
  });
  audio.addEventListener('pause', () => {
    // pause/load queue events. An old event can arrive after a replacement
    // source is already playing; it must not stop background buffer refill.
    if (!audio.paused) return;
    state.playing = false;
    updateMediaSession();
  });
  audio.addEventListener('play', () => {
    if (audio.paused) return;
    state.playing = true;
    updateMediaSession();
  });
  audio.addEventListener('error', () => {
    if (audio.src) state.error = '音频播放失败，请重试本段';
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => { void play(); });
    navigator.mediaSession.setActionHandler('pause', pause);
    navigator.mediaSession.setActionHandler('previoustrack', () => { void jumpChapter(-1); });
    navigator.mediaSession.setActionHandler('nexttrack', () => { void jumpChapter(1); });
    navigator.mediaSession.setActionHandler('seekbackward', () => skipSeconds(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => skipSeconds(15));
  }

  const timer = setInterval(() => {
    if (!state.sleepUntil) return;
    state.remaining = Math.max(0, Math.ceil((state.sleepUntil - Date.now()) / 1000));
    if (!state.remaining) {
      pause();
      state.sleep = 'off';
      state.sleepUntil = 0;
      say('定时结束，已暂停朗读');
    }
  }, 1000);

  function destroy() {
    clearInterval(timer);
    stop(true);
  }

  return { state, active, chapterProgress, open, play, pause, toggle, stop, seekSegment, startAtPosition,
    skipSeconds, jumpChapter, setRate, setVoice, setAccessCode, setSleep, destroy };
}
