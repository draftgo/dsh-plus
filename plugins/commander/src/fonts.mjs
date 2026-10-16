import { readFile } from 'node:fs/promises';

/** Fixed asset allowlist; same owner authentication as the existing Connection routes. */
export async function mountFonts(ctx) {
  const root = new URL('../assets/fonts/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  for (const { file } of manifest) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/commander-fonts/' + file, methods: ['GET'], requestBody: 'buffered',
      async fetch() {
        return new Response(new Uint8Array(await readFile(new URL('web/' + file, root))), {
          headers: { 'content-type': 'font/woff2', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
        });
      },
    }));
  }
}
