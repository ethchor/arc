import * as React from "react";

/**
 * Open state for a dialog that renders its own trigger but can also be opened from somewhere
 * else, such as a row's context menu. It manages its own state unless `open` is passed.
 */
export function useControllableOpen(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
): [boolean, (open: boolean) => void] {
  const [own, setOwn] = React.useState(false);
  const controlled = open !== undefined;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setOwn(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  return [controlled ? open : own, setOpen];
}
