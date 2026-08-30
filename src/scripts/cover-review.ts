/**
 * The portal's "look at it before it goes up" panel.
 *
 * A module rather than an inline script for two reasons: it is far too much
 * logic for a block Astro ships verbatim, and it has to import the geometry
 * from ./cover-clean, which an inline script cannot do. Being a module also
 * means it can be mounted against the real component outside the portal and
 * driven, which is the only way any of this gets looked at - the HTTP suite
 * cannot click and the portal needs a password.
 *
 * It hands itself to the page's uploader through `window.coverClean`. That is
 * the whole seam between them: the uploader asks for a file to send and gets
 * one back, or null if the owner cancelled.
 */
import { detectQuad, orderCorners, quadSize, warp, DETECT_EDGE } from './cover-clean';

export function mountCoverReview(): void {
  const panel = document.querySelector<HTMLElement>('#cleanPanel');
  const stage = document.querySelector<HTMLElement>('#cleanStage');
  const sourceCanvas = document.querySelector<HTMLCanvasElement>('#cleanSource');
  const overlay = document.querySelector<SVGSVGElement>('#cleanOverlay');
  const resultCanvas = document.querySelector<HTMLCanvasElement>('#cleanResult');
  const note = document.querySelector<HTMLElement>('#cleanNote');

  /** How big the photo is drawn while it is being adjusted. */
  const STAGE_EDGE = 320;
  /** The longest edge of the finished cover. The shop shows 800 at most. */
  const MAX_EDGE = 800;

  if (panel && stage && sourceCanvas && overlay && resultCanvas && note) {
    type Point = { x: number; y: number };

    let full: HTMLCanvasElement | null = null; // the photo at working size
    let corners: Point[] = [];
    let settle: ((file: File | null) => void) | null = null;

    /** Corner positions are in `full` pixels; the stage may be smaller. */
    const toStage = (p: Point) => ({
      x: (p.x / full!.width) * sourceCanvas.width,
      y: (p.y / full!.height) * sourceCanvas.height,
    });

    const paintOverlay = () => {
      const pts = corners.map(toStage);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z';
      overlay.setAttribute('viewBox', `0 0 ${sourceCanvas.width} ${sourceCanvas.height}`);
      overlay.innerHTML =
        `<path d="${d}" fill="rgba(24,68,133,0.12)" stroke="#184485" stroke-width="2"/>` +
        pts
          .map(
            (p, i) =>
              `<circle data-corner="${i}" cx="${p.x}" cy="${p.y}" r="9" fill="#fff" ` +
              `stroke="#184485" stroke-width="2.5" style="cursor:grab"/>`,
          )
          .join('');
    };

    /** Re-warp into the preview. Cheap enough to do on every drag frame. */
    const paintResult = () => {
      if (!full) return;
      const size = quadSize(corners, MAX_EDGE);
      const src = full.getContext('2d')!.getImageData(0, 0, full.width, full.height);
      const out = new ImageData(size.width, size.height);
      if (!warp(src, corners, out)) return;
      resultCanvas.width = size.width;
      resultCanvas.height = size.height;
      resultCanvas.getContext('2d')!.putImageData(out, 0, 0);
    };

    // Pointer events rather than mouse: the owner is usually on a phone,
    // where this is the only thing that reports a finger.
    let dragging: number | null = null;
    const at = (e: PointerEvent): Point => {
      const box = sourceCanvas.getBoundingClientRect();
      return {
        x: ((e.clientX - box.left) / box.width) * full!.width,
        y: ((e.clientY - box.top) / box.height) * full!.height,
      };
    };

    stage.addEventListener('pointerdown', (e) => {
      const target = e.target as Element;
      const index = target.getAttribute?.('data-corner');
      if (index === null || index === undefined) return;
      dragging = Number(index);
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    stage.addEventListener('pointermove', (e) => {
      if (dragging === null || !full) return;
      const p = at(e);
      // Clamped to the photo: a corner outside it warps in white, which
      // looks like a fault rather than a choice.
      corners[dragging] = {
        x: Math.min(full.width, Math.max(0, p.x)),
        y: Math.min(full.height, Math.max(0, p.y)),
      };
      paintOverlay();
      paintResult();
    });

    for (const event of ['pointerup', 'pointercancel'] as const) {
      stage.addEventListener(event, () => {
        dragging = null;
      });
    }

    const close = (file: File | null) => {
      panel.hidden = true;
      const done = settle;
      settle = null;
      full = null;
      done?.(file);
    };

    document.querySelector('#cleanCancel')?.addEventListener('click', () => close(null));

    document.querySelector('#cleanRaw')?.addEventListener('click', () => {
      // Their photo untouched, straight from the canvas it was drawn on.
      full?.toBlob((blob) => {
        close(blob ? new File([blob], 'photo.webp', { type: 'image/webp' }) : null);
      }, 'image/webp', 0.9);
    });

    document.querySelector('#cleanUse')?.addEventListener('click', () => {
      resultCanvas.toBlob((blob) => {
        close(blob ? new File([blob], 'photo.webp', { type: 'image/webp' }) : null);
      }, 'image/webp', 0.9);
    });

    /**
     * Show the panel for one photo and resolve with what to upload.
     *
     * Resolves rather than throws on every failure path: a photo the
     * browser cannot decode should fall through to the plain upload that
     * has always worked, not lose the owner their photo.
     */
    async function review(file: File): Promise<File | null> {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        return file; // let the existing uploader deal with it
      }

      const scale = Math.min(1, STAGE_EDGE / Math.max(bitmap.width, bitmap.height));
      full = document.createElement('canvas');
      full.width = Math.max(1, Math.round(bitmap.width * scale));
      full.height = Math.max(1, Math.round(bitmap.height * scale));
      full.getContext('2d')!.drawImage(bitmap, 0, 0, full.width, full.height);

      sourceCanvas.width = full.width;
      sourceCanvas.height = full.height;
      sourceCanvas.getContext('2d')!.drawImage(full, 0, 0);

      // Detection runs smaller again - it only needs to find a book, and
      // a quarter of a million pixels is enough for that.
      const detectScale = Math.min(1, DETECT_EDGE / Math.max(full.width, full.height));
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(full.width * detectScale));
      small.height = Math.max(1, Math.round(full.height * detectScale));
      small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height);

      const found = detectQuad(
        small.getContext('2d')!.getImageData(0, 0, small.width, small.height),
      );

      if (found) {
        corners = orderCorners(found).map((p) => ({
          x: (p.x / small.width) * full!.width,
          y: (p.y / small.height) * full!.height,
        }));
        note.textContent =
          'If the outline is not on the book, drag the corners onto it and this updates as you go.';
      } else {
        // The whole frame, so there is always something to drag.
        corners = [
          { x: 0, y: 0 },
          { x: full.width, y: 0 },
          { x: full.width, y: full.height },
          { x: 0, y: full.height },
        ];
        note.textContent =
          'Could not pick the book out of this one - drag the corners onto it, or use the photo as it is.';
      }

      paintOverlay();
      paintResult();
      panel.hidden = false;
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      return new Promise<File | null>((resolve) => {
        settle = resolve;
      });
    }

    (window as unknown as { coverClean?: unknown }).coverClean = { review };
  }
}
