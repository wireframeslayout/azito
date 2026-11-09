import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; fallback: ReactNode }
interface State { failed: boolean }
export class PreviewErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Preview failed', error, info.componentStack); }
  render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children; }
}
