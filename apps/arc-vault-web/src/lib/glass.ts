/**
 * Liquid Glass switch (docs/18 §2). Glass is on by default; the in-app "Reduce Transparency"
 * setting stores "1" under this key and sets `data-glass="off"` on <html>, which turns every
 * glass surface opaque (it doubles as the rollout kill switch).
 */
export const REDUCE_TRANSPARENCY_KEY = "arc-reduce-transparency";

/** Inline script for <head>: applies the saved setting before first paint (no glass flash). */
export const GLASS_BOOTSTRAP = `(function(){try{if(localStorage.getItem('${REDUCE_TRANSPARENCY_KEY}')==='1')document.documentElement.setAttribute('data-glass','off')}catch(e){}})();`;
