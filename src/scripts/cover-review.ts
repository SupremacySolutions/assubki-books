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
import {
  detectQuad,
  orderCorners,
  quadSize,
  warp,
  DETECT_EDGE,
  MASK_EDGE,
  maskFit,
  toTensor,
  checkMask,
  eraseBackground,
} from './cover-clean';

export function mountCoverReview(): void {
  const panel = document.querySelector<HTMLDialogElement>('#cleanPanel');
  const stage = document.querySelector<HTMLElement>('#cleanStage');
  const sourceCanvas = document.querySelector<HTMLCanvasElement>('#cleanSource');
  const overlay = document.querySelector<SVGSVGElement>('#cleanOverlay');
  const resultCanvas = document.querySelector<HTMLCanvasElement>('#cleanResult');
  const note = document.querySelector<HTMLElement>('#cleanNote');
  const erase = document.querySelector<HTMLInputElement>('#cleanErase');
  const eraseNote = document.querySelector<HTMLElement>('#cleanEraseNote');

  /** How big the photo is drawn while it is being adjusted. */
  const STAGE_EDGE = 420;
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

    /**
     * The straightened cover, before anything is erased from it.
     *
     * Kept so the erase can be undone by unticking the box without re-warping,
     * and so a failed erase has something to fall back to that is not the
     * original photo.
     */
    let cropped: ImageData | null = null;

    /** Re-warp into the preview. Cheap enough to do on every drag frame. */
    const paintResult = () => {
      if (!full) return;
      const size = quadSize(corners, MAX_EDGE);
      const src = full.getContext('2d')!.getImageData(0, 0, full.width, full.height);
      const out = new ImageData(size.width, size.height);
      if (!warp(src, corners, out)) return;
      cropped = out;
      resultCanvas.width = size.width;
      resultCanvas.height = size.height;
      resultCanvas.getContext('2d')!.putImageData(out, 0, 0);
    };

    /*
     * The model, loaded the first time the box is ticked and never before.
     *
     * onnxruntime-web and the weights are about 18MB between them. An owner who
     * never touches this never downloads any of it, and one who does pays for
     * it once - both are served from this origin with a year's caching.
     *
     * Run directly rather than through a wrapper library: this model is a
     * plain U²-Net with a custom processor, which the usual pipeline library
     * does not know how to read. The preprocessing it needs is four lines and
     * it is written down in the model's own config.
     */
    let session: unknown = null;
    let loading: Promise<unknown> | null = null;

    const loadModel = () => {
      if (!loading) {
        loading = (async () => {
          // The wasm-only entry point, not the default one: the default
          // bundles WebGPU and asks for a separate JSEP build of the runtime,
          // which is more to host for a backend this does not need.
          const ort = await import('onnxruntime-web/wasm');
          // No `wasmPaths`: the bundler already emits the runtime as a hashed
          // asset on this origin and the runtime resolves it from its own
          // module URL. Pointing it elsewhere only meant hosting a second copy
          // of a file that was being shipped anyway.
          // Threads need cross-origin isolation headers the site does not send;
          // without this it would try, fail, and fall back noisily.
          ort.env.wasm.numThreads = 1;
          session = await ort.InferenceSession.create('/model/models/u2netp/model.onnx');
          return session;
        })().catch((err) => {
          loading = null; // let them try again rather than being stuck
          throw err;
        });
      }
      return loading;
    };

    /**
     * Paints everything that is not the book white.
     *
     * Every failure here keeps the crop and says so. A model that will not
     * load, a browser that cannot run it, or a mask with no range in it are
     * all reasons to leave the photo alone, never to paint over it.
     */
    const applyErase = async () => {
      if (!cropped || !erase || !eraseNote) return;

      const showing = (text: string) => {
        eraseNote.hidden = false;
        eraseNote.textContent = text;
      };

      try {
        showing(session ? 'Working…' : 'Fetching the model, about 18MB - this happens once…');
        const ort = await import('onnxruntime-web/wasm');
        await loadModel();

        // The crop, letterboxed into the square the model expects.
        const fit = maskFit(cropped.width, cropped.height);
        const square = document.createElement('canvas');
        square.width = MASK_EDGE;
        square.height = MASK_EDGE;
        const sctx = square.getContext('2d')!;
        sctx.fillStyle = '#000';
        sctx.fillRect(0, 0, MASK_EDGE, MASK_EDGE);
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropped.width;
        cropCanvas.height = cropped.height;
        cropCanvas.getContext('2d')!.putImageData(cropped, 0, 0);
        sctx.drawImage(cropCanvas, 0, 0, fit.width, fit.height);

        const input = new ort.Tensor(
          'float32',
          toTensor(sctx.getImageData(0, 0, MASK_EDGE, MASK_EDGE)),
          [1, 3, MASK_EDGE, MASK_EDGE],
        );
        const run = session as {
          inputNames: string[];
          outputNames: string[];
          run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
        };
        const result = await run.run({ [run.inputNames[0]]: input });
        const raw = result[run.outputNames[0]]?.data;

        const mask = raw ? checkMask(Float32Array.from(raw), fit) : null;
        if (!mask) {
          showing('Nothing here it could separate from the book - the photo is unchanged.');
          erase.checked = false;
          return;
        }

        const out = new ImageData(
          new Uint8ClampedArray(cropped.data),
          cropped.width,
          cropped.height,
        );
        eraseBackground(out, mask, fit);
        resultCanvas.getContext('2d')!.putImageData(out, 0, 0);
        eraseNote.hidden = true;
      } catch (err) {
        console.error('background removal failed', err);
        showing('Could not do that here - the cropped photo is unchanged.');
        erase.checked = false;
        if (cropped) resultCanvas.getContext('2d')!.putImageData(cropped, 0, 0);
      }
    };

    erase?.addEventListener('change', () => {
      if (erase.checked) {
        void applyErase();
      } else if (cropped) {
        if (eraseNote) eraseNote.hidden = true;
        resultCanvas.getContext('2d')!.putImageData(cropped, 0, 0);
      }
    });

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
      // Back to the plain crop while they drag: the erased version belongs to
      // the corners it was made from, not to wherever they have got to.
      paintResult();
    });

    for (const event of ['pointerup', 'pointercancel'] as const) {
      stage.addEventListener(event, () => {
        const wasDragging = dragging !== null;
        dragging = null;
        // Re-erase once they let go. Without this the box stays ticked while
        // the preview quietly shows the un-erased crop, which is the preview
        // telling them something that is not true.
        if (wasDragging && erase?.checked) void applyErase();
      });
    }

    /**
     * Settle the promise and shut the dialog. Safe to call twice.
     *
     * Every way out goes through here, and it does not depend on the dialog's
     * own `close` event to do the settling. That event is specified, but it
     * does not fire in every engine - it does not fire in the browser this is
     * verified in - and a modal that can be dismissed without resolving leaves
     * the uploader waiting on it for the life of the page. So the promise is
     * settled directly and `close`/`cancel` are wired as extra ways in rather
     * than as the mechanism.
     */
    const close = (file: File | null) => {
      const done = settle;
      settle = null;
      full = null;
      if (panel.open) panel.close();
      done?.(file);
    };

    // Esc, in engines that report it. Prevented so the dialog is closed by the
    // line above instead, keeping one path out rather than two.
    panel.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });

    // Esc, in engines that do not. Harmless where `cancel` already handled it,
    // because close() is idempotent.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
    });

    // Closed by something other than a button - settle rather than strand.
    panel.addEventListener('close', () => close(null));

    // A click landing on the dialog itself rather than on its contents is a
    // click on the backdrop. Treated as Cancel, like Esc.
    panel.addEventListener('click', (e) => {
      if (e.target === panel) close(null);
    });

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
        // The header already says to drag the corners; repeating it here just
        // fills the footer with something nobody needs to read.
        note.textContent = '';
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

      // Each photo starts from the crop. Carrying the tick over would put an
      // 18MB download and a wait in front of somebody who only wanted to
      // straighten the next one.
      if (erase) erase.checked = false;
      if (eraseNote) eraseNote.hidden = true;

      paintOverlay();
      paintResult();
      panel.showModal();

      return new Promise<File | null>((resolve) => {
        settle = resolve;
      });
    }

    (window as unknown as { coverClean?: unknown }).coverClean = { review };
  }
}
