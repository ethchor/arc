import { toast } from "sonner";

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Copy from a menu command (a row's context menu), where there's no CopyButton to show the
 * result. Confirms with a toast and, for secrets, wipes the clipboard after
 * `clearAfterSeconds`: the same policy as CopyButton, so a copied password doesn't linger.
 * `what` names the value in title case ("Password") for the toast.
 */
export async function copyText(value: string, what: string, clearAfterSeconds = 0): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`);
    return;
  }
  // A newer copy replaces whatever an earlier timer was waiting to clear.
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = undefined;
  if (clearAfterSeconds > 0) {
    clearTimer = setTimeout(() => {
      navigator.clipboard.writeText("").catch(() => {});
      clearTimer = undefined;
    }, clearAfterSeconds * 1000);
    toast.success(`${what} copied`, { description: `Clears from the clipboard in ${clearAfterSeconds} s.` });
  } else {
    toast.success(`${what} copied`);
  }
}
