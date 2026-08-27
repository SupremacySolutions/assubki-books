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
  vite: {
    plugins: [tailwindcss()],
  },
});
