"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();
  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // On compact screens toasts float above the tab bar (--toast-offset-bottom, globals.css).
      offset={{ bottom: "var(--toast-offset-bottom, 32px)" }}
      mobileOffset={{ bottom: "var(--toast-offset-bottom, 16px)" }}
      // Toasts are glass capsules (docs/18 §4.4). Sonner reads its surface from these vars.
      style={
        {
          "--normal-bg": "var(--glass-fill-strong)",
          "--normal-border": "var(--glass-edge)",
          "--normal-text": "hsl(var(--foreground))",
          "--border-radius": "var(--radius-xl)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "group toast glass-toast group-[.toaster]:text-foreground group-[.toaster]:shadow-[var(--glass-shadow)]",
          description: "group-[.toast]:text-muted-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
