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
  quadSize,
  warp,
  DETECT_EDGE,
  MASK_EDGE,
  maskFit,
  toTensor,
  checkMask,
  refineMask,
  eraseBackground,
} from './cover-clean';
import { IMAGE_PRESETS } from '../lib/image-presets';
import { BOX, framePlan, edgeSpread, edgeGap } from '../lib/cover-frame.mjs';

export function mountCoverReview(): void {
  const panel = document.querySelector<HTMLDialogElement>('#cleanPanel');
  const stage = document.querySelector<HTMLElement>('#cleanStage');
  const sourceCanvas = document.querySelector<HTMLCanvasElement>('#cleanSource');
  const overlay = document.querySelector<SVGSVGElement>('#cleanOverlay');
  const resultCanvas = document.querySelector<HTMLCanvasElement>('#cleanResult');
  const note = document.querySelector<HTMLElement>('#cleanNote');
  const erase = document.querySelector<HTMLInputElement>('#cleanErase');
  const eraseNote = document.querySelector<HTMLElement>('#cleanEraseNote');
  const qualityRow = document.querySelector<HTMLElement>('#cleanQualityRow');

  /** How big the photo is drawn while it is being adjusted. */
  const STAGE_EDGE = 420;
  /**
   * The photo kept back for the export warp.
   *
   * Dragging has to stay cheap, so the corners are placed against a 420px copy
   * and the live preview is warped from it. The upload must not be: warping the
   * preview was sending a 420px cover to a shop whose largest variant is 1176
   * tall, so every listing added through the portal arrived already softened
   * and no amount of processing afterwards could put the detail back.
   *
   * Capped rather than unbounded for two reasons. A modern phone photo is
   * 12MP, and `getImageData` on that is close to 50MB before anything has been
   * warped. And the warp samples bilinearly - one reading per output pixel -
   * so a source far larger than the output is not extra quality, it is
   * undersampling: 4000px reduced to 1400 that way skips most of what it
   * passes over and aliases the fine work on a cover. Sitting just above
   * MAX_EDGE means the browser does the big reduction, with a proper filter,
   * when the photo is first drawn.
   */
  const SOURCE_EDGE = 1600;
  /**
   * The longest edge of the finished cover.
   *
   * Has to clear the biggest variant the shop makes, which is the 840x1176
   * detail; below that the site would be enlarging its own upload. 1400 leaves
   * room for the crop to take a slice off without falling under it.
   */
  const MAX_EDGE = 1400;
  /**
   * What the upload route will take, mirrored from `api/admin/upload.ts`.
   *
   * Only used to decide whether the owner's own file can be passed through
   * untouched. A phone photo that arrives as HEIC, or a 12MP JPEG over the
   * limit, has to be re-encoded here or the upload comes back a 415 or a 413.
   */
  const UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const UPLOAD_MAX = 8 * 1024 * 1024;

  if (panel && stage && sourceCanvas && overlay && resultCanvas && note) {
    type Point = { x: number; y: number };

    let full: HTMLCanvasElement | null = null; // the photo at working size
    let source: HTMLCanvasElement | null = null; // the same photo, kept large
    let chosen: File | null = null; // exactly what the owner picked
    /** The last mask the erase produced, so the export can apply it again. */
    let erased: Float32Array | null = null;
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
      /*
       * Two circles per corner: the one that is seen, and a bigger invisible
       * one that catches the touch. A 9px handle is comfortable under a mouse
       * and far too small under a fingertip, and this is mostly used on a
       * phone.
       *
       * The hit radius is worked back from how large the canvas is actually
       * drawn, so it stays about 40 real pixels whatever the screen. Fixed in
       * the viewBox it shrank with the stage - 32px on a phone, which is where
       * it mattered most.
       */
      const drawnWidth = sourceCanvas.getBoundingClientRect().width || sourceCanvas.width;
      const perPixel = sourceCanvas.width / drawnWidth;
      const grab = Math.max(12, 20 * perPixel);
      overlay.innerHTML =
        `<path d="${d}" fill="rgba(24,68,133,0.12)" stroke="#184485" stroke-width="2"/>` +
        pts
          .map(
            (p, i) =>
              `<circle data-corner="${i}" cx="${p.x}" cy="${p.y}" r="${grab.toFixed(1)}" ` +
              `fill="transparent" style="cursor:grab"/>` +
              `<circle data-corner="${i}" cx="${p.x}" cy="${p.y}" r="9" fill="#fff" ` +
              `stroke="#184485" stroke-width="2.5" style="cursor:grab;pointer-events:none"/>`,
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

    /**
     * The quad, warped out of whichever copy of the photo is asked for.
     *
     * The corners are held in `full`'s pixels, so they are scaled into the
     * canvas being read - the same quad, measured on a different-sized print
     * of the same picture.
     */
    const warpFrom = (canvas: HTMLCanvasElement, cap: number): ImageData | null => {
      if (!full) return null;
      const scale = canvas.width / full.width;
      const corner = corners.map((p) => ({ x: p.x * scale, y: p.y * scale }));
      const size = quadSize(corner, cap);
      const src = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const out = new ImageData(size.width, size.height);
      return warp(src, corner, out) ? out : null;
    };

    /**
     * Re-warp into the preview.
     *
     * Two speeds, because the pane is labelled "On the listing" and has to
     * earn that. Warping the small copy is cheap enough to redo on every drag
     * frame but it is a resample of an already-small picture, so it came out
     * visibly softer than the photo beside it - the pane claiming to show the
     * result was the worst-looking thing in the dialog, and the result itself
     * was fine. So: the quick one only while a corner is actually moving, and
     * the real one - the very warp the upload uses - the moment it stops.
     */
    const paintResult = (fine = true) => {
      if (!full) return;
      const out = fine && source ? warpFrom(source, MAX_EDGE) : warpFrom(full, STAGE_EDGE);
      if (!out) return;
      cropped = out;
      resultCanvas.width = out.width;
      resultCanvas.height = out.height;
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
    /**
     * Which weights to use.
     *
     * The two are the same network at two sizes - identical input, output and
     * preprocessing, so switching is only a different file. Quick is 4MB and
     * good enough for a cover on a plain surface; Better is 168MB and worth it
     * when the first one leaves a mess. Remembered, so it is answered once
     * rather than on every photo, and defaulting to Quick because 168MB over a
     * phone connection is not something to spend on somebody's behalf.
     */
    const MODELS: Record<string, string> = {
      quick: '/model/models/u2netp/model.onnx',
      better: '/model/models/u2net/model.onnx',
    };

    const chosenQuality = (): string => {
      const picked = document.querySelector<HTMLInputElement>('input[name="cleanQuality"]:checked');
      return picked?.value === 'better' ? 'better' : 'quick';
    };

    try {
      const remembered = localStorage.getItem('coverEraseQuality');
      if (remembered === 'better') {
        const better = document.querySelector<HTMLInputElement>('input[name="cleanQuality"][value="better"]');
        if (better) better.checked = true;
      }
    } catch {
      // Private browsing, or storage refused. The default is fine.
    }

    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="cleanQuality"]')) {
      radio.addEventListener('change', () => {
        try {
          localStorage.setItem('coverEraseQuality', chosenQuality());
        } catch {
          /* not worth failing over */
        }
        // A different model means a different mask, so redo it rather than
        // leaving the picture from the one they just switched away from.
        if (erase?.checked) void applyErase();
      });
    }

    // One session per model, so switching back and forth does not re-download.
    const sessions: Record<string, unknown> = {};
    let session: unknown = null;
    let loading: Promise<unknown> | null = null;
    let loadedQuality: string | null = null;

    const loadModel = (quality: string) => {
      if (sessions[quality]) {
        session = sessions[quality];
        loadedQuality = quality;
        return Promise.resolve(session);
      }
      if (!loading || loadedQuality !== quality) {
        loadedQuality = quality;
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
          session = await ort.InferenceSession.create(MODELS[quality]);
          sessions[quality] = session;
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

      const quality = chosenQuality();
      try {
        showing(
          sessions[quality]
            ? 'Working…'
            : quality === 'better'
              ? 'Fetching the better model, 168MB - this happens once…'
              : 'Fetching the model, a few megabytes - this happens once…',
        );
        const ort = await import('onnxruntime-web/wasm');
        await loadModel(quality);

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
          erased = null;
          return;
        }

        const out = new ImageData(
          new Uint8ClampedArray(cropped.data),
          cropped.width,
          cropped.height,
        );
        // Tightened before it is applied, or the soft boundary leaves a fringe
        // of whatever was behind the book smeared along every edge.
        const tightened = refineMask(mask);
        eraseBackground(out, tightened, fit);
        // Held on to rather than recomputed: the export warps the same corners
        // out of a larger copy, and the mask is addressed by relative position,
        // so the one already approved on screen is the right one to apply.
        erased = tightened;
        resultCanvas.getContext('2d')!.putImageData(out, 0, 0);
        eraseNote.hidden = true;
      } catch (err) {
        console.error('background removal failed', err);
        showing('Could not do that here - the cropped photo is unchanged.');
        erase.checked = false;
        erased = null;
        if (cropped) resultCanvas.getContext('2d')!.putImageData(cropped, 0, 0);
      }
    };

    erase?.addEventListener('change', () => {
      if (qualityRow) qualityRow.hidden = !erase.checked;
      if (erase.checked) {
        void applyErase();
      } else if (cropped) {
        if (eraseNote) eraseNote.hidden = true;
        erased = null;
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
      // the corners it was made from, not to wherever they have got to. Quick,
      // because this runs on every frame a finger moves.
      paintResult(false);
    });

    for (const event of ['pointerup', 'pointercancel'] as const) {
      stage.addEventListener(event, () => {
        const wasDragging = dragging !== null;
        dragging = null;
        if (!wasDragging) return;
        // Redraw properly now the corners have settled, so what is on the
        // right is the file that will be uploaded rather than an approximation
        // of it.
        paintResult(true);
        // Re-erase once they let go. Without this the box stays ticked while
        // the preview quietly shows the un-erased crop, which is the preview
        // telling them something that is not true.
        if (erase?.checked) void applyErase();
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
      source = null;
      chosen = null;
      erased = null;
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

    /*
     * Keeps a copy of one that came out wrong, and changes nothing else.
     *
     * Deliberately not an exit: the dialog stays open on the same photo with
     * the same three choices, because reporting a bad cut-out is not the same
     * as giving up on the upload - the owner may still want the crop, or the
     * photo as it is.
     */
    const report = document.querySelector<HTMLButtonElement>('#cleanReport');
    report?.addEventListener('click', async () => {
      if (!full || !note) return;
      const label = report.textContent;
      report.disabled = true;
      report.textContent = 'Saving…';
      try {
        const asBlob = (canvas: HTMLCanvasElement) =>
          new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.9));
        const [before, after] = await Promise.all([asBlob(full), asBlob(resultCanvas)]);
        if (!before || !after) throw new Error('could not read the pictures back');

        const body = new FormData();
        body.append('original', new File([before], 'original.webp', { type: 'image/webp' }));
        body.append('result', new File([after], 'result.webp', { type: 'image/webp' }));
        body.append(
          'note',
          JSON.stringify({
            photo: { width: full.width, height: full.height },
            result: { width: resultCanvas.width, height: resultCanvas.height },
            corners,
            erased: Boolean(erase?.checked),
            quality: chosenQuality(),
          }),
        );

        const res = await fetch('/api/admin/report-cover', { method: 'POST', body });
        if (!res.ok) throw new Error(await res.text());
        note.textContent = 'Saved, thank you - this one will be looked at.';
        report.textContent = 'Reported';
      } catch (err) {
        console.error('report failed', err);
        note.textContent = 'Could not save that report. The photo is unaffected.';
        report.textContent = label ?? 'Report this one';
        report.disabled = false;
      }
    });

    document.querySelector('#cleanRaw')?.addEventListener('click', () => {
      closeUncropped();
    });

    /**
     * "Use the photo as it is" - their file, if their file can be used.
     *
     * This used to hand back the working canvas re-encoded, so the button that
     * promises to change nothing quietly shrank the photo to 420px and put it
     * through WebP a second time. Passing the original through is the only
     * reading of "as it is" that is true, and it costs nothing - but only when
     * the route will actually take it. A HEIC from an iPhone, or a 12MP JPEG
     * over the size limit, still has to be re-encoded, and then it is re-encoded
     * from the large copy rather than the small one.
     */
    function closeUncropped(): void {
      if (chosen && UPLOAD_TYPES.has(chosen.type) && chosen.size <= UPLOAD_MAX) {
        close(chosen);
        return;
      }
      if (!source) {
        close(chosen);
        return;
      }
      source.toBlob((blob) => {
        close(blob ? new File([blob], 'photo.webp', { type: 'image/webp' }) : chosen);
      }, 'image/webp', 0.9);
    }

    document.querySelector('#cleanUse')?.addEventListener('click', () => {
      const out = exportCover();
      if (!out) {
        // Nothing to warp from. Better their own photo than an empty upload.
        closeUncropped();
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = out.width;
      canvas.height = out.height;
      canvas.getContext('2d')!.putImageData(out, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) close(new File([blob], 'photo.webp', { type: 'image/webp' }));
        else closeUncropped();
      }, 'image/webp', 0.9);
    });

    /**
     * The finished cover, cut from the large copy rather than the small one.
     *
     * The corners were placed against the working canvas, so they are scaled
     * into the source's coordinates before the warp - the same quad, measured
     * on a bigger picture. Everything the owner approved on screen is
     * reproduced here at size: the same crop, and the same erase mask, which
     * is addressed by relative position and so does not care how large the
     * image it lands on is.
     */
    function exportCover(): ImageData | null {
      if (!source) return null;
      const out = warpFrom(source, MAX_EDGE);
      if (!out) return null;
      if (erased) eraseBackground(out, erased, maskFit(out.width, out.height));
      return out;
    }

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

      chosen = file;

      // Two copies of the same photo. The working one is small enough to warp
      // on every drag frame; the source one is what the finished cover is
      // actually cut from, so the upload carries the detail the owner gave us.
      const draw = (edge: number) => {
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas;
      };
      full = draw(STAGE_EDGE);
      source = draw(SOURCE_EDGE);

      /*
       * The photo pane is drawn from the large copy, not the working one.
       *
       * The dialog puts these two side by side and invites the comparison, so
       * they have to be a fair one. Drawn from the 420px copy this pane was
       * soft in its own right, and on a phone - where the canvas is stretched
       * to the column width - visibly so. Its backing store is independent of
       * the coordinates the corners live in: `toStage` scales into it and the
       * overlay takes its viewBox from it, so this only makes the picture
       * sharper and moves nothing.
       */
      // Checked once here rather than asserted at each use: if the dialog's
      // canvas is not in the document there is nothing to review, and handing
      // the file straight to the uploader is the behaviour that has always
      // worked.
      const pane = sourceCanvas;
      if (!pane) return file;
      const paneScale = Math.min(1, (STAGE_EDGE * 2) / Math.max(source.width, source.height));
      pane.width = Math.max(1, Math.round(source.width * paneScale));
      pane.height = Math.max(1, Math.round(source.height * paneScale));
      pane.getContext('2d')!.drawImage(source, 0, 0, pane.width, pane.height);

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
        // Already clockwise from the top left - the detector settles that, and
        // sorting them again here would only give the answer a second author.
        corners = found.map((p) => ({
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
      if (qualityRow) qualityRow.hidden = true;
      if (report) {
        report.disabled = false;
        report.textContent = 'Report this one';
      }

      paintOverlay();
      paintResult();
      panel.showModal();

      // Painted again now it is on screen. The handles size themselves from
      // how large the canvas is actually drawn, and before `showModal` it has
      // no layout to measure - so the first paint fell back to a fixed size
      // and the touch targets came out smaller on a phone, which is the one
      // place they had to be bigger.
      paintOverlay();

      return new Promise<File | null>((resolve) => {
        settle = resolve;
      });
    }

    (window as unknown as { coverClean?: unknown }).coverClean = { review, dress };
  }
}

/**
 * A chosen photo, framed to the shop's box and cut into the sizes it serves.
 *
 * This is the step that was missing. The portal stored what the owner picked
 * and nothing else, so a new listing had no variants at all: `?p=card` fell
 * back to the full-size original, the browser cropped it with whatever
 * `object-fit` decided, and the framing rule this shop actually follows only
 * arrived later, if somebody remembered to run `scripts/resize-covers.mjs`.
 *
 * The rule itself is `framePlan`'s, shared with that script, so a cover added
 * here is framed exactly as one put through the batch. What is deliberately
 * not shared is the border trimming: the owner has just cropped this photo by
 * hand, so there is no scanner margin left to find, and the script keeps that
 * for the catalogue it inherited.
 *
 * Best effort throughout. Every failure returns what it was given rather than
 * refusing the upload - a cover with no variants still displays, which is how
 * this behaved before and is far better than turning the photo away.
 */
export async function dress(
  file: File,
): Promise<{ master: File; width: number; height: number; variants: Map<string, File> }> {
  const bare = { master: file, width: 0, height: 0, variants: new Map<string, File>() };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return bare;
  }

  const framed = frameToBox(bitmap);
  if (!framed) return bare;
  const master = await toWebp(framed, 0.92);
  if (!master) return bare;

  const variants = new Map<string, File>();
  for (const [name, preset] of Object.entries(IMAGE_PRESETS)) {
    const width = preset.width * preset.scale;
    const height = preset.height * preset.scale;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) continue;

    if (name === 'social') {
      /*
       * The one square well, Telegram's. A cover goes into it whole rather
       * than cropped, because a square crop of a book is a fragment of one.
       */
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      const scale = Math.min(width / framed.width, height / framed.height);
      const w = Math.round(framed.width * scale);
      const h = Math.round(framed.height * scale);
      context.drawImage(framed, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
    } else {
      // Already the shape of the box, so edge to edge is exact.
      context.drawImage(framed, 0, 0, width, height);
    }

    const variant = await toWebp(canvas, 0.82, `${name}.webp`);
    if (variant) variants.set(name, variant);
  }

  return { master, width: framed.width, height: framed.height, variants };
}

/** The photo on a canvas of the shop's shape, widened or cropped per the rule. */
function frameToBox(bitmap: ImageBitmap): HTMLCanvasElement | null {
  const source = document.createElement('canvas');
  source.width = bitmap.width;
  source.height = bitmap.height;
  const from = source.getContext('2d', { willReadFrequently: true });
  if (!from) return null;
  from.drawImage(bitmap, 0, 0);

  // Measured on the outermost column of each side, which is what decides
  // whether widening would be seamless or would show its join.
  const columnAt = (x: number) => {
    const strip = from.getImageData(x, 0, 1, bitmap.height).data;
    return (y: number): [number, number, number] => [
      strip[y * 4],
      strip[y * 4 + 1],
      strip[y * 4 + 2],
    ];
  };
  const inset = Math.max(2, Math.round(bitmap.width * 0.02));
  const plan = framePlan({
    width: bitmap.width,
    height: bitmap.height,
    leftSpread: edgeSpread(columnAt(0), bitmap.height),
    rightSpread: edgeSpread(columnAt(bitmap.width - 1), bitmap.height),
    // Compared with a column a little inside, so a line the warp left behind
    // is not mistaken for the cover's own edge and stretched into a band.
    leftGap: edgeGap(columnAt(0), columnAt(inset), bitmap.height),
    rightGap: edgeGap(
      columnAt(bitmap.width - 1), columnAt(bitmap.width - 1 - inset), bitmap.height,
    ),
  });

  const out = document.createElement('canvas');
  const to = out.getContext('2d');
  if (!to) return null;

  if (plan.mode === 'extend') {
    out.width = plan.width;
    out.height = plan.height;
    if (plan.left) to.drawImage(source, 0, 0, 1, bitmap.height, 0, 0, plan.left, plan.height);
    if (plan.right) {
      to.drawImage(
        source, bitmap.width - 1, 0, 1, bitmap.height,
        plan.left + bitmap.width, 0, plan.right, plan.height,
      );
    }
    to.drawImage(source, plan.left, 0);
    return out;
  }

  const ratio = bitmap.width / bitmap.height;
  if (ratio < BOX) {
    out.width = bitmap.width;
    out.height = Math.round(bitmap.width / BOX);
    const spare = bitmap.height - out.height;
    to.drawImage(source, 0, plan.anchor === 'north' ? 0 : -Math.round(spare / 2));
  } else {
    out.height = bitmap.height;
    out.width = Math.round(bitmap.height * BOX);
    to.drawImage(source, -Math.round((bitmap.width - out.width) / 2), 0);
  }
  return out;
}

function toWebp(
  canvas: HTMLCanvasElement,
  quality: number,
  name = 'photo.webp',
): Promise<File | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob ? new File([blob], name, { type: 'image/webp' }) : null),
      'image/webp',
      quality,
    );
  });
}
