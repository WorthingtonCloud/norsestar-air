// Serves this folder exactly as it is hosted: static files plus the headers in vercel.json,
// nothing else. No API routes, no keys, no .env.
//   node serve.mjs   ->   http://localhost:4411
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4411);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.gif': 'image/gif' };
const headers = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers[0].headers.map((h) => [h.key, h.value]),
);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.normalize(path.join(root, url.pathname === '/' ? '/index.html' : url.pathname));
  if (req.method !== 'GET' || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, headers); res.end('not found'); return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`NorseStar Air -> http://localhost:${PORT}`));
