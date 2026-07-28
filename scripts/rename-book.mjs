// 修改服务器持久书库中的书名，不重建正文。
// 用法: DATA_DIR=/path/to/data node scripts/rename-book.mjs <bookId> <新书名>
import fs from 'node:fs';
import path from 'node:path';

const [bookId, newTitle] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(bookId || '') || !newTitle?.trim()) {
  console.error('用法: node scripts/rename-book.mjs <bookId> <新书名>');
  process.exit(1);
}
const booksDir = path.join(process.env.DATA_DIR || path.resolve('server/data'), 'books');
const bookFile = path.join(booksDir, `${bookId}.json`);
const indexFile = path.join(booksDir, 'index.json');
const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
book.title = newTitle.trim();
fs.writeFileSync(bookFile, JSON.stringify(book));
const library = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const item = library.find((entry) => entry.id === bookId);
if (item) item.title = book.title;
fs.writeFileSync(indexFile, JSON.stringify(library, null, 2));
console.log(`已将 ${bookId} 重命名为《${book.title}》`);
