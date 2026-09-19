import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Pilot',
    description: 'Chat with an agent that drives the page you’re on, and records actions as skills.',
    version: '1.1.0',
    permissions: ['sidePanel', 'storage', 'activeTab', 'scripting', 'tabs', 'tabGroups', 'alarms', 'offscreen', 'debugger'],
    // captureVisibleTab needs a host grant; <all_urls> lets it work on any page.
    host_permissions: ['<all_urls>'],
    // Open the side panel when the toolbar icon is clicked.
    action: {
      default_title: 'Open Pilot',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
  vite: () => ({
    // cast: @tailwindcss/vite returns a plugin array; WXT bundles its own Vite
    // types, so the Plugin identities differ. Harmless — Vite flattens plugins.
    plugins: [tailwindcss() as any],
    build: {
      // Force pure-ASCII output so Chromium never rejects a content script
      // because of stray non-ASCII bytes (UTF-8 BOM, CJK comments in deps, etc).
      target: 'es2022',
    },
    esbuild: {
      charset: 'ascii',
    },
  }),
});
