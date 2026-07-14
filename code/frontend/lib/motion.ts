import type { Transition, Variants } from "framer-motion";

/**
 * One motion vocabulary for the whole app.
 *
 * Before this, every animated surface picked its own duration and easing — 0.2s here,
 * 0.4s easeOut there, a 1.4s linear spin somewhere else — so nothing felt like it came
 * from the same hand. Import from here instead of hand-rolling a `transition` prop.
 *
 * `SWIFT` is the decelerate curve mirrored in tailwind's `ease-swift`, so CSS transitions
 * and framer-motion transitions land on the same feel.
 */
export const SWIFT = [0.32, 0.72, 0, 1] as const;

export const transition = {
  fast: { duration: 0.12, ease: SWIFT },
  base: { duration: 0.18, ease: SWIFT },
  slow: { duration: 0.28, ease: SWIFT },
} satisfies Record<string, Transition>;

/** Content arriving in place: a short rise, never a slide across the screen. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: transition.slow },
  exit: { opacity: 0, y: -6, transition: transition.fast },
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: transition.base },
  exit: { opacity: 0, transition: transition.fast },
};

/**
 * Parent of a list that should arrive as a wave rather than all at once. Cap the stagger
 * so a 200-row list doesn't take twelve seconds to finish appearing.
 */
export function stagger(step = 0.04, max = 8): Variants {
  return {
    hidden: {},
    show: {
      transition: { staggerChildren: step, delayChildren: 0, staggerDirection: 1 },
    },
    exit: { transition: { staggerChildren: Math.min(step, max / 100) / 2 } },
  };
}
