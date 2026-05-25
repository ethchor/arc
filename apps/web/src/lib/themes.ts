export interface ThemePreset {
  /** value applied as `data-theme` (except "default", which clears it) */
  name: string;
  label: string;
  /** representative HSL (the `--primary`) for the swatch dot */
  swatch: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { name: "default", label: "Zinc", swatch: "240 5.9% 10%" },
  { name: "slate", label: "Slate", swatch: "222.2 47.4% 11.2%" },
  { name: "blue", label: "Blue", swatch: "221.2 83.2% 53.3%" },
  { name: "violet", label: "Violet", swatch: "262.1 83.3% 57.8%" },
  { name: "rose", label: "Rose", swatch: "346.8 77.2% 49.8%" },
  { name: "emerald", label: "Emerald", swatch: "142.1 76.2% 36.3%" },
  { name: "amber", label: "Amber", swatch: "24.6 95% 53.1%" },
];

export const DEFAULT_PRESET = "default";
export const PRESET_STORAGE_KEY = "arc-vault-preset";

/** Apply a color preset by toggling `data-theme` on <html>. */
export function applyPreset(name: string): void {
  if (typeof document === "undefined") return;
  if (name === DEFAULT_PRESET) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", name);
  }
}

/** Inline bootstrap (run before paint) that restores the saved preset without a flash. */
export const PRESET_BOOTSTRAP = `(function(){try{var p=localStorage.getItem('${PRESET_STORAGE_KEY}');if(p&&p!=='${DEFAULT_PRESET}')document.documentElement.setAttribute('data-theme',p);}catch(e){}})();`;
