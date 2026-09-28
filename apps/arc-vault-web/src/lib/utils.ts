import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's built-in font sizes, so it would read the HIG type-scale
 * utilities from tailwind.config.ts (`text-body`, `text-footnote`, …) as text *colors* and drop
 * them whenever a color class like `text-muted-foreground` follows. Register them as sizes.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["large-title", "title-1", "title-2", "title-3", "headline", "body", "callout", "subhead", "footnote", "caption"],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
