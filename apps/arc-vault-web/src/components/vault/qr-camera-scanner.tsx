"use client";

import * as React from "react";
import { decodeQr } from "@/lib/qr/decode";

/** Max edge (px) the frame is downscaled to before decoding. jsQR is both faster AND more
 *  reliable on a smaller image — finder-pattern detection degrades on noisy full-res frames. */
const MAX_SCAN_EDGE = 640;

/**
 * Live camera QR scanner. Opens the device camera (rear-facing where available) and **auto-scans
 * every frame** with jsQR — no capture button. On the first decode it calls `onResult`, and the
 * parent unmounts it, which stops the camera via the effect cleanup. All decoding is on-device;
 * no frame is ever uploaded.
 *
 * `getUserMedia` requires a secure context (HTTPS, or localhost in dev). Permission denial /
 * no-camera / insecure-context are surfaced through `onError` rather than thrown.
 */
export function QrCameraScanner({
  onResult,
  onError,
}: {
  onResult: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  // Keep the latest callbacks in refs so the camera effect runs exactly once (it must not
  // restart — and tear the stream down — just because the parent passed new inline closures).
  const onResultRef = React.useRef(onResult);
  const onErrorRef = React.useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  React.useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      try {
        if (video && ctx && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
          const scale = Math.min(1, MAX_SCAN_EDGE / Math.max(video.videoWidth, video.videoHeight));
          const w = Math.max(1, Math.round(video.videoWidth * scale));
          const h = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, w, h);
          const text = decodeQr(data, w, h);
          if (text) {
            onResultRef.current(text);
            return; // found — stop the loop; parent unmounts us and the cleanup stops the camera
          }
        }
      } catch {
        // A transient per-frame error (a getImageData hiccup, a frame mid-resize) must never
        // kill the scan loop — just skip this frame and try the next one.
      }
      raf = requestAnimationFrame(tick);
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onErrorRef.current?.("Camera isn't available in this browser.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        raf = requestAnimationFrame(tick);
      } catch (err) {
        const name = (err as { name?: string })?.name;
        const message =
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera permission denied."
            : name === "NotFoundError"
              ? "No camera found on this device."
              : "Couldn't start the camera.";
        if (!cancelled) onErrorRef.current?.(message);
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded-md border bg-black/50">
      {/* muted + playsInline are required for autoplay on iOS Safari. */}
      <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
      {/* Reticle + hint: shows the scan is live and guides framing (clipped finder patterns are
          the usual reason a QR won't decode). pointer-events-none so it never blocks the video. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
        <div className="h-40 w-40 max-w-[60%] rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        <span className="rounded bg-black/60 px-2 py-1 text-xs text-white/90">
          Point your camera at the QR code
        </span>
      </div>
    </div>
  );
}
