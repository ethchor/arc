/**
 * Motion tokens — easings, durations, and reusable variants.
 *
 * Every value here is mirrored in `globals.css` as a CSS custom property so motion
 * stays consistent whether it's driven by Tailwind classes (CSS) or motion/react
 * (JS animations). Update both sides together.
 */

/** Cubic-bezier curves. Stronger than the CSS built-ins; chosen per Emil Kowalski's framework. */
export const EASE = {
  outQuart: [0.23, 1, 0.32, 1] as const,
  outExpo: [0.16, 1, 0.3, 1] as const,
  outBack: [0.34, 1.56, 0.64, 1] as const,
  inOutQuart: [0.77, 0, 0.175, 1] as const,
  drawer: [0.32, 0.72, 0, 1] as const,
};

/** Durations in seconds (motion/react expects seconds, not ms). */
export const DUR = {
  instant: 0.08,
  fast: 0.16,
  base: 0.22,
  slow: 0.32,
  drawer: 0.44,
};

/** Reusable Motion variant — fade up. Pair with `Reveal` or any `motion.*` element. */
export const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE.outQuart } },
};

/** Plain fade — no movement. Best for crossfades. */
export const fadeIn = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DUR.base, ease: EASE.outQuart } },
};

/** Scale-in from 0.96 — never animate scale(0). Pair with opacity. */
export const scaleIn = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { duration: DUR.base, ease: EASE.outQuart } },
};

/** Stagger container — orchestrates children. Defaults to 50ms between items. */
export const staggerContainer = (stagger = 0.05, delayChildren = 0) => ({
  hidden: {},
  visible: { transition: { staggerChildren: stagger, delayChildren } },
});

/** Spring preset — Apple-style, low bounce. Use for drag, mouse-tracking, "alive" elements. */
export const SPRING_SOFT = { type: "spring" as const, duration: 0.5, bounce: 0.18 };
export const SPRING_SNAPPY = { type: "spring" as const, duration: 0.35, bounce: 0.1 };
