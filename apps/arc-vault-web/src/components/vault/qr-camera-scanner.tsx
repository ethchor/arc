"use client";

import * as React from "react";
import { decodeQr } from "@/lib/qr/decode";

/**
 * Live camera QR scanner. Opens the device camera (rear-facing where available), scans each
 * frame with jsQR, and calls `onResult` with the first decoded string — then the parent
 * unmounts it, which stops the camera via the effect cleanup. All decoding is on-device; no
 * frame is ever uploaded.
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
      const video = videoRef.current;
      if (cancelled) return;
      if (video && ctx && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const text = decodeQr(data, width, height);
        if (text) {
          onResultRef.current(text);
          return; // found — stop the loop; parent unmounts us and the cleanup stops the camera
        }
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
          video: { facingMode: "environment" },
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
    <div className="overflow-hidden rounded-md border bg-black/50">
      {/* muted + playsInline are required for autoplay on iOS Safari. */}
      <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
    </div>
  );
}
