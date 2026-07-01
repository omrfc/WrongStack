import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';

interface Props {
  children: ReactNode;
  /** Optional callback when an error is caught — useful for telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary for the entire app. Catches rendering errors in
 * any descendent component and shows a fallback UI instead of a white screen.
 * A single crash in a leaf component (e.g. a malformed markdown render) must
 * not take down the entire chat session.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[100dvh] items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
            <AlertTriangle className="h-12 w-12 text-destructive" />
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              A rendering error occurred. Your session is still active on the server — reloading
              will pick up where you left off.
            </p>
            <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded p-3 max-h-32 overflow-auto w-full text-left">
              {this.state.error.message}
            </pre>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Reload page
              </Button>
              <Button size="sm" onClick={this.handleReset}>
                Try again
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
