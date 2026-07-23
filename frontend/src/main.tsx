import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initApiBase } from './api'

// 立即渲染 App（顯示啟動畫面）；後端位址解析在背景進行，就緒後由 onApiReady 通知
initApiBase()
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
)
