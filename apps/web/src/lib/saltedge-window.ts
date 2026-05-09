const SALT_EDGE_WINDOW_FEATURES = "popup,width=540,height=760,resizable=yes,scrollbars=yes";

export function openSaltEdgeWindow() {
  return window.open("", "_blank", SALT_EDGE_WINDOW_FEATURES);
}

export function navigateSaltEdgeWindow(target: Window, url: string) {
  target.location.href = url;
  target.focus?.();
}

export function closeSaltEdgeWindow(target: Window | null | undefined) {
  if (!target || target.closed) {
    return;
  }

  target.close();
}
