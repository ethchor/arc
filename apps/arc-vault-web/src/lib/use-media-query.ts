import * as React from "react";

/**
 * Whether a CSS media query matches, kept in sync as the viewport changes. Reads the real value
 * on the first client render (no flash of the wrong layout) and `false` on the server.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
