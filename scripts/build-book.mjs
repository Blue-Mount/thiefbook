// 把 GBK 编码的 txt 小说转成前端可用的 UTF-8 JSON，并按章节切分。
// 用法: node scripts/build-book.mjs "<txt路径>" [bookId]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const srcArg = process.argv[2] || path.join(root, '《覆汉》作者：榴弹怕水.txt');
const bookId = process.argv[3] || 'fuhan';
const outDir = path.join(root, 'app', 'public', 'books');

// 识别章节标题的正则：第X章 / 第X卷 / 楔子 / 序章 / 番外 / 尾声 等
const CHAPTER_RE = /^\s*第[零〇一二三四五六七八九十百千万两0-9]+章(?:\s|[　]|$|[^\S\r\n]|.)?/;
const VOLUME_RE = /^\s*第[零〇一二三四五六七八九十百千万两0-9]+卷/;
const SPECIAL_RE = /^\s*(楔子|序章|序|引子|尾声|后记|番外|终章)\s*$/;

// 自动识别编码：BOM > 严格 UTF-8 校验 > 回退 GBK
function decodeAuto(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8 (BOM)' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' };
  try {
    // fatal 模式：遇到非法 UTF-8 序列会抛错，说明多半是 GBK
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' };
  }
}

function cleanLine(l) {
  // 去掉全角空格缩进和首尾空白，段落缩进交给前端 CSS 处理
  return l.replace(/[　\s]+$/g, '').replace(/^[　\s]+/g, '').trim();
}

function main() {
  const buf = fs.readFileSync(srcArg);
  const { text, encoding } = decodeAuto(buf);
  console.log(`   识别编码: ${encoding}`);
  const rawLines = text.split(/\r?\n/);

  const meta = { title: '', author: '' };
  const chapters = [];
  let current = null;
  let currentVolume = '';

  const pushChapter = (title) => {
    current = { id: chapters.length, title: title.trim(), volume: currentVolume, paragraphs: [] };
    chapters.push(current);
  };

  // 先取书名/作者（前两行通常是 书名 / 作者：xxx）
  for (let i = 0; i < Math.min(rawLines.length, 5); i++) {
    const l = rawLines[i].trim();
    if (!meta.title && l && !/[:：]/.test(l)) meta.title = l;
    const m = l.match(/作者[:：]\s*(.+)/);
    if (m) meta.author = m[1].trim();
  }

  for (const raw of rawLines) {
    const line = cleanLine(raw);
    if (VOLUME_RE.test(raw)) {
      currentVolume = line;
      // 卷标题本身不单独成章，附到下一章的 volume 字段
      continue;
    }
    if (CHAPTER_RE.test(raw) || SPECIAL_RE.test(raw)) {
      pushChapter(line);
      continue;
    }
    if (!current) {
      // 第一章之前的内容（简介等）归入“卷首”
      pushChapter('卷首·内容简介');
    }
    if (line) current.paragraphs.push(line);
  }

  // 去掉完全空的章节
  const cleaned = chapters.filter((c) => c.paragraphs.length > 0);
  cleaned.forEach((c, i) => (c.id = i));

  const book = {
    id: bookId,
    title: meta.title || bookId,
    author: meta.author || '',
    chapterCount: cleaned.length,
    // 轻量目录（不含正文），前端可快速渲染章节列表
    toc: cleaned.map((c) => ({ id: c.id, title: c.title, volume: c.volume })),
    chapters: cleaned,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${bookId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(book));

  const bytes = fs.statSync(outFile).size;
  console.log(`✅ 生成: ${outFile}`);
  console.log(`   书名: ${book.title} / 作者: ${book.author}`);
  console.log(`   章节数: ${book.chapterCount}`);
  console.log(`   文件大小: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   前3章: ${cleaned.slice(0, 3).map((c) => c.title).join(' | ')}`);
  console.log(`   末3章: ${cleaned.slice(-3).map((c) => c.title).join(' | ')}`);
}

main();
