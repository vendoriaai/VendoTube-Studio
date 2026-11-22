import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last-resort error boundary: a render crash must never blank the studio —
 * it shows the error inline with a reload button instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI crashed:', error.message, info.componentStack?.slice(0, 300))
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', color: '#FF5D6C', background: '#0A0D14', height: '100%', overflow: 'auto' }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>UI crashed — the studio caught it</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#EAF0F7' }}>{this.state.error.message}</pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: '6px 14px', background: '#8B7CFF', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Reload UI
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
