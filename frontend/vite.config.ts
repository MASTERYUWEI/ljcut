import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    // Tauri 需要 clearScreen: false
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        host: true,
        // Web-only dev mode: proxy 轉發到 Python 後端
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
            '/uploads': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
            '/outputs': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
        },
    },
})
