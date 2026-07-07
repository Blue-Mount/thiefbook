import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '摸鱼看书',
        short_name: '看书',
        description: '跨端小说阅读器，进度云同步',
        theme_color: '#1f2430',
        background_color: '#1f2430',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // 书籍 JSON 较大（约 9MB），提高单文件缓存上限，实现离线可读
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,json}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.json'),
            handler: 'CacheFirst',
            options: { cacheName: 'books', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
});
