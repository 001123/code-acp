import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Drawn in place of `children` after they throw; `retry` renders them again. */
  fallback: (message: string, retry: () => void) => ReactNode;
  /** Renders `children` again when one of these changes: what threw may be fine with new data. */
  resetKeys?: readonly unknown[];
}

interface State {
  failed?: { message: string };
}

const changed = (a: readonly unknown[] = [], b: readonly unknown[] = []) =>
  a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));

/** Keeps a render error from unmounting the whole webview, which would leave it blank. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { failed: { message: error instanceof Error ? error.message : String(error) } };
  }

  // Only a failure from before this update: the keys that came with the failing render don't count as new.
  override componentDidUpdate(prevProps: Props, prevState: State): void {
    if (prevState.failed && changed(prevProps.resetKeys, this.props.resetKeys)) this.retry();
  }

  private retry = () => this.setState({ failed: undefined });

  override render(): ReactNode {
    const { failed } = this.state;
    return failed ? this.props.fallback(failed.message, this.retry) : this.props.children;
  }
}
