import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Last line of defence: a render error shows a message instead of a blank window.
class CrashGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h2>Something went wrong in the window</h2>
        <p>Sharing and the bot keep running in the background.</p>
        <pre>{error.message}</pre>
        <button className="btn" onClick={() => location.reload()}>
          Reload window
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashGuard>
      <App />
    </CrashGuard>
  </StrictMode>
)
