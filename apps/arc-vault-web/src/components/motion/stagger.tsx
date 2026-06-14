"use client";

import * as React from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { DUR, EASE } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface StaggerProps extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants"> {
  /** Seconds between each child. 30-80ms is the sweet spot per Emil Kowalski's guidance. */
  stagger?: number;
  /** Initial delay before the first child animates. */
  delayChildren?: number;
  /** Trigger on mount (default) or on viewport entry. */
  on?: "mount" | "in-view";
  /** When `on="in-view"`, fraction of the element that must be visible. */
  amount?: number;
}

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE.outQuart } },
};

type ItemProps = Omit<HTMLMotionProps<"div">, "variants">;

const StaggerItem: React.FC<ItemProps> = ({ className, children, ...rest }) => (
  <motion.div variants={itemVariants} className={cn(className)} {...rest}>
    {children}
  </motion.div>
);
StaggerItem.displayName = "Stagger.Item";

const StaggerImpl: React.FC<StaggerProps> = ({
  stagger = 0.05,
  delayChildren = 0,
  on = "mount",
  amount = 0.2,
  className,
  children,
  ...rest
}) => {
  const reduce = useReducedMotion();

  const containerVariants = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: reduce ? 0 : stagger,
        delayChildren: reduce ? 0 : delayChildren,
      },
    },
  };

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      {...(on === "mount"
        ? { animate: "visible" }
        : { whileInView: "visible", viewport: { once: true, amount } })}
      className={cn(className)}
      {...rest}
    >
      {children}
    </motion.div>
  );
};
StaggerImpl.displayName = "Stagger";

/**
 * Container that orchestrates child stagger animations. Pair with `<Stagger.Item>` children.
 *
 * Honours `prefers-reduced-motion` — children render instantly in their final state.
 *
 * Example:
 *   <Stagger>
 *     <Stagger.Item><Card /></Stagger.Item>
 *     <Stagger.Item><Card /></Stagger.Item>
 *   </Stagger>
 */
export const Stagger = Object.assign(StaggerImpl, { Item: StaggerItem });
