import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tr } from '../i18n';

/** A rendering error in one view never blanks the application: the view shows the error and can be reloaded. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="content"><p className="note warn" role="alert">{tr('This view failed to render: {message}', { message: this.state.error.message })}</p>
      <button className="btn sm" onClick={() => window.location.reload()}>{tr('Reload')}</button></div>;
  }
}
