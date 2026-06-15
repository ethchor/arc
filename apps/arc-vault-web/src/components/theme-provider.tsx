"use client";

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes";
import { MotionConfig } from "motion/react";

/**
 * Wraps next-themes + framer's MotionConfig. `reducedMotion="user"` makes every motion
 * component honour the OS reduced-motion setting at the animation level — applied
 * post-mount, so it never changes the server-rendered structure (the motion wrappers
 * keep a deterministic `initial`, which is what keeps hydration stable).
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </NextThemesProvider>
  );
}
