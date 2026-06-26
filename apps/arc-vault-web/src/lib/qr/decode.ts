import jsQR from "jsqr";

/**
 * QR decoding for TOTP import — runs **entirely in the browser**. A scanned/uploaded QR for
 * an authenticator is just an `otpauth://…` (or bare base32) string; the decoded text is fed
 * straight into the dialog's existing `maybeApplyOtpauth` parser. The image bytes never leave
 * the device, consistent with arc's zero-knowledge posture.
 */

/** Decode a QR from raw RGBA pixel data. Returns the encoded text, or null if none was found. */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  // `attemptBoth` also tries the inverted image, so light-on-dark QRs (and many screenshots)
  // decode too.
  const result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return result?.data ?? null;
}

/**
 * Decode a QR from an uploaded image file. Resolves to the encoded text, or null if the file
 * has no readable QR. Rejects only if the file isn't a decodable image.
 */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decodeQr(data, width, height);
  } finally {
    bitmap.close();
  }
}
