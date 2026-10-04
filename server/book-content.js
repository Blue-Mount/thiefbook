import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export function makeBookContentRouter({ booksDir, builtinBooksDir }) {
  const router = express.Router();
  const cache = new Map();

  function getBook(bookId) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(bookId || '')) return null;
    const uploaded = path.join(booksDir, `${bookId}.json`);
    const builtin = path.join(builtinBooksDir, `${bookId}.json`);
    const file = fs.existsSync(uploaded) ? uploaded : builtin;
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const cached = cache.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.book;
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(book.chapters)) throw new Error('invalid book');
    cache.set(file, { book, mtimeMs: stat.mtimeMs, size: stat.size });
    return book;
  }

  router.get('/:bookId/manifest', (req, res) => {
    try {
      const book = getBook(req.params.bookId);
      if (!book) return res.status(404).json({ error: '找不到书籍' });
      res.json({
        id: book.id,
        title: book.title,
        author: book.author,
        chapterCount: book.chapters.length,
        chapters: book.chapters.map(({ id, title, volume }, index) =>
          ({ id: id ?? index, title, volume })),
      });
    } catch {
      res.status(500).json({ error: '无法读取书籍目录' });
    }
  });

  router.get('/:bookId/chapters/:chapterIndex', (req, res) => {
    try {
      const book = getBook(req.params.bookId);
      const index = Number(req.params.chapterIndex);
      if (!book || !Number.isInteger(index) || index < 0 || index >= book.chapters.length)
        return res.status(404).json({ error: '找不到章节' });
      res.json(book.chapters[index]);
    } catch {
      res.status(500).json({ error: '无法读取章节' });
    }
  });

  return router;
}
