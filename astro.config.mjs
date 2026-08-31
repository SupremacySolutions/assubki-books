// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// Server-rendered rather than static: stock has to be correct at page load,
// per-book OG tags must exist for Telegram link previews, and a book added in
// the admin has to appear without a rebuild.
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  site: 'https://assubkibooks.co.uk',
  // Honour the port the harness assigns, so this can run alongside the other
  // Supremacy dev servers.
  server: { port: Number(process.env.PORT) || 4321 },
  /*
   * Astro writes `script-src` and `style-src` itself, hashing every script and
   * style it emits - including the small bundles it inlines into the page
   * rather than shipping as files. Our own nonce could not cover those: they
   * are generated at build time, after the page is written, so the middleware
   * never sees them and the dialogs stopped opening the moment
   * `'unsafe-inline'` was dropped.
   *
   * Everything a meta tag cannot carry - frame-ancestors, HSTS and the rest -
   * stays in src/middleware.ts.
   */
  vite: {
    plugins: [tailwindcss()],
    /*
     * Never inline a bundle into the page.
     *
     * Astro inlines small script bundles, and those cannot carry our nonce -
     * they are generated at build time, after the page is written. With
     * `'unsafe-inline'` dropped from the policy the browser refused them, and
     * the dialogs stopped opening. As separate files they are covered by
     * `'self'` like every other script.
     */
    build: { assetsInlineLimit: 0 },
  },
});
