// Keep one native media resource alive across sentence boundaries. Android
// background playback must not depend on restarting audio after every `ended`.
export class SentenceStream {
  static supported() {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
  }

  constructor(audio) {
    this.audio = audio;
    this.media = new MediaSource();
    this.url = URL.createObjectURL(this.media);
    this.parts = [];
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.media.addEventListener('sourceopen', () => {
        if (this.closed) return;
        try {
          this.buffer = this.media.addSourceBuffer('audio/mpeg');
          this.buffer.mode = 'sequence';
          resolve();
        } catch (error) { reject(error); }
      }, { once: true });
    });
    // Disposal can happen before a caller begins waiting for sourceopen.
    this.ready.catch(() => {});
    audio.src = this.url;
  }

  async append(blob, index) {
    await this.ready;
    const bytes = await blob.arrayBuffer();
    if (this.closed) throw new DOMException('Stream closed', 'AbortError');
    const start = this.parts.at(-1)?.end || 0;
    // Retain enough history for the rewind control without keeping a long
    // chapter's entire decoded buffer in mobile memory.
    const cutoff = this.audio.currentTime - 60;
    if (cutoff > 0 && this.buffer.buffered.length && this.buffer.buffered.start(0) < cutoff) {
      await this.updateBuffer(() => this.buffer.remove(0, cutoff));
    }
    await this.updateBuffer(() => this.buffer.appendBuffer(bytes));
    if (this.closed) throw new DOMException('Stream closed', 'AbortError');
    const ranges = this.buffer.buffered;
    if (!ranges.length) throw new Error('语音没有可播放内容');
    this.parts.push({ index, start, end: ranges.end(ranges.length - 1) });
  }

  updateBuffer(action) {
    return new Promise((resolve, reject) => {
      const clean = () => {
        this.buffer.removeEventListener('updateend', done);
        this.buffer.removeEventListener('error', failed);
        this.rejectAppend = null;
      };
      const done = () => { clean(); resolve(); };
      const failed = () => { clean(); reject(new Error('音频缓冲失败')); };
      this.rejectAppend = () => { clean(); reject(new DOMException('Stream closed', 'AbortError')); };
      this.buffer.addEventListener('updateend', done);
      this.buffer.addEventListener('error', failed);
      try { action(); } catch (error) { clean(); reject(error); }
    });
  }

  position() {
    const time = this.audio.currentTime || 0;
    const part = this.parts.find((item) => time < item.end) || this.parts.at(-1);
    return part ? { index: part.index, time: Math.max(0, time - part.start), duration: part.end - part.start } : null;
  }

  finish() {
    if (!this.closed && this.media.readyState === 'open') this.media.endOfStream();
  }

  destroy() {
    this.closed = true;
    this.rejectReady(new DOMException('Stream closed', 'AbortError'));
    this.rejectAppend?.();
    URL.revokeObjectURL(this.url);
  }
}
