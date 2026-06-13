import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initApiBase } from './api'

// 先解析後端 sidecar 位址（並等待就緒），再渲染 App
initApiBase().finally(() => {
    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <App />
        </StrictMode>,
    )
})
