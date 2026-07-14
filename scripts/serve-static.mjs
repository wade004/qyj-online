import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mime = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
});

export function startStaticServer(port = 8080, rootPath = '.') {
  const root = path.resolve(rootPath);

  function resolveRequest(url) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname); }
    catch { return null; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const absolute = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return absolute;
  }

  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method Not Allowed');
      return;
    }
    const file = resolveRequest(request.url || '/');
    const info = file ? await stat(file).catch(() => null) : null;
    if (!info?.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      console.log(`静态服务：http://127.0.0.1:${boundPort}（${root}）`);
      resolve();
    });
  });
  ready.catch(() => {});

  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    server.closeAllConnections?.();
    closePromise = new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(resolve);
    });
    return closePromise;
  };

  return {
    server,
    ready,
    close,
    get url() {
      const address = server.address();
      if (typeof address !== 'object' || !address) return null;
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

const directEntry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (directEntry === import.meta.url) {
  const instance = startStaticServer(Number(process.argv[2]) || 8080, process.argv[3] || '.');
  instance.ready.catch(() => { process.exitCode = 1; });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await instance.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
