/** App state, shared across middleware, handlers and page components. */
export interface State {
  tenant: string;
  requestId: string;
  isSessionEntry?: boolean;
}
