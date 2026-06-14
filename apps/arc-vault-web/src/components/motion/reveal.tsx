"use client";

import * as React from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { DUR, EASE } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface RevealProps extends Omit<HTMLMotionProps<"div">, "initial" | "whileInView" | "viewport" | "transition"> {
  /** Vertical offset distance in pixels. Default 12 — enough to read as motion, not as a lurch. */
  offset?: number;
  /** Delay before the reveal starts (seconds). */
  delay?: number;
  /** Duration of the reveal (seconds). Defaults to `DUR.slow`. */
  duration?: number;
  /** Render-once or re-trigger on re-entry. Defaults to once — secrets dashboards aren't decorative. */
  once?: boolean;
  /** Fraction of the element that must be visible before firing. */
  amount?: number;
  /** What kind of motion to use. `fade-up` is the default; `fade` is the calmest. */
  variant?: "fade-up" | "fade" | "scale";
}

/**
 * Fade-in / fade-up wrapper that triggers when the element enters the viewport.
 * Honours `prefers-reduced-motion` automatically.
 *
 * Use this around any block that benefits from "appearing" rather than "being there":
 * a hero block, a card grid, a docs page header. Don't wrap every list item — that's
 * what `Stagger` is for, with one shared parent driving the timing.
 */
export function Reveal({
  offset = 12,
  delay = 0,
  duration = DUR.slow,
  once = true,
  amount = 0.25,
  variant = "fade-up",
  className,
  children,
  ...rest
}: RevealProps) {
  const reduce = useReducedMotion();

  const initial =
    variant === "fade-up"
      ? { opacity: 0, y: offset }
      : variant === "scale"
        ? { opacity: 0, scale: 0.96 }
        : { opacity: 0 };
  const visible =
    variant === "fade-up"
      ? { opacity: 1, y: 0 }
      : variant === "scale"
        ? { opacity: 1, scale: 1 }
        : { opacity: 1 };

  return (
    <motion.div
      initial={reduce ? false : initial}
      whileInView={visible}
      viewport={{ once, amount }}
      transition={{ duration, delay, ease: EASE.outQuart }}
      className={cn(className)}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
