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
import { BOX, framePlan, edgeSpread } from '../lib/cover-frame.mjs';

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

    /** The same crop with the mask applied, when there is one. */
    let erasedImage: ImageData | null = null;

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
      // A new crop is a new picture; whatever was erased belonged to the old one.
      erased = null;
      erasedImage = null;
      eraseRun++;
      showResult();
    };

    /**
     * Put the current state of the cover into the pane, framed as it will be
     * stored.
     *
     * The framing is the part that was missing, and it made the pane a liar.
     * It showed the warp; `dress` then put that warp through `frameToBox` on
     * its way to R2, which for a cover narrower than 5:7 either continues its
     * outer columns sideways or - far more often, because artwork rarely
     * reaches the edge in a flat colour - takes about eight percent off the
     * height. So the owner approved one picture and the listing got another,
     * with a slice off the top and bottom he was never shown. Running the same
     * plan here means the pane is labelled "On the listing" and is.
     */
    const showResult = () => {
      const shown = erasedImage ?? cropped;
      if (!shown) return;
      const flat = document.createElement('canvas');
      flat.width = shown.width;
      flat.height = shown.height;
      flat.getContext('2d')!.putImageData(shown, 0, 0);
      // Falls back to the unframed crop rather than showing nothing: a pane
      // that cannot frame is still a useful look at the cover.
      const framed = frameToBox(flat, shown.width, shown.height) ?? flat;
      resultCanvas.width = framed.width;
      resultCanvas.height = framed.height;
      resultCanvas.getContext('2d')!.drawImage(framed, 0, 0);
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

    /**
     * One in-flight load per model, and the session comes back through the
     * promise.
     *
     * There used to be a single `session` variable that every load wrote to
     * and every run read afterwards. Two loads in flight - which is one tick
     * of the Quick/Better radio - meant the second one landed in that variable
     * while the first was still awaiting, and whichever run resumed next used
     * whichever model had written last. Keyed promises have no such variable
     * to fight over.
     */
    const sessions: Record<string, Promise<InferenceLike>> = {};
    /** Which models have finished downloading, so the wait is only announced once. */
    const ready = new Set<string>();

    interface InferenceLike {
      inputNames: string[];
      outputNames: string[];
      run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
    }

    const loadModel = (quality: string): Promise<InferenceLike> => {
      const held = sessions[quality];
      if (held) return held;
      const started = (async () => {
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
        return (await ort.InferenceSession.create(MODELS[quality])) as unknown as InferenceLike;
      })().catch((err) => {
        delete sessions[quality]; // let them try again rather than being stuck
        throw err;
      });
      sessions[quality] = started;
      return started;
    };

    /**
     * Paints everything that is not the book white.
     *
     * Every failure here keeps the crop and says so. A model that will not
     * load, a browser that cannot run it, or a mask with no range in it are
     * all reasons to leave the photo alone, never to paint over it.
     *
     * Every run is numbered, and a run that is no longer the newest one stops
     * at the next check rather than painting. It has to be: this is fired by
     * the checkbox, by the model radios and by every pointerup, each awaits a
     * module import, a download and a wasm inference, and on a phone that is
     * seconds. Without the number, four nudges of a corner queued four runs
     * that finished in whatever order they finished in, and the last to land -
     * not the last to be asked for - decided both what was on screen and, via
     * `erased`, what was uploaded. Worse, `cropped` was read again *after* the
     * awaits while `fit` had been measured before them, so a mask cut for one
     * crop was stretched onto another: the book half whited out and the
     * background kept, which is exactly what a glitch looks like.
     */
    let eraseRun = 0;

    const applyErase = async () => {
      if (!cropped || !erase || !eraseNote) return;

      const run = ++eraseRun;
      // Snapshotted, not re-read. Everything below belongs to this one crop.
      const subject = cropped;
      const fit = maskFit(subject.width, subject.height);
      /** Whether this run still speaks for the dialog. */
      const current = () => run === eraseRun && erase.checked && cropped === subject;

      const showing = (text: string) => {
        eraseNote.hidden = false;
        eraseNote.textContent = text;
      };

      const quality = chosenQuality();
      try {
        showing(
          ready.has(quality)
            ? 'Working…'
            : quality === 'better'
              ? 'Fetching the better model, 168MB - this happens once…'
              : 'Fetching the model, a few megabytes - this happens once…',
        );
        const ort = await import('onnxruntime-web/wasm');
        const model = await loadModel(quality);
        ready.add(quality);
        if (!current()) return;

        // The crop, letterboxed into the square the model expects.
        const square = document.createElement('canvas');
        square.width = MASK_EDGE;
        square.height = MASK_EDGE;
        const sctx = square.getContext('2d')!;
        sctx.fillStyle = '#000';
        sctx.fillRect(0, 0, MASK_EDGE, MASK_EDGE);
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = subject.width;
        cropCanvas.height = subject.height;
        cropCanvas.getContext('2d')!.putImageData(subject, 0, 0);
        sctx.drawImage(cropCanvas, 0, 0, fit.width, fit.height);

        const input = new ort.Tensor(
          'float32',
          toTensor(sctx.getImageData(0, 0, MASK_EDGE, MASK_EDGE)),
          [1, 3, MASK_EDGE, MASK_EDGE],
        );
        const result = await model.run({ [model.inputNames[0]]: input });
        if (!current()) return;
        const raw = result[model.outputNames[0]]?.data;

        const mask = raw ? checkMask(Float32Array.from(raw), fit) : null;
        if (!mask) {
          /*
           * Said plainly, because the honest answer reads like a fault.
           *
           * Once the crop is tight the picture is all book, the model has
           * nothing to separate it from, and it says so - a maximum around
           * 0.017 rather than a mask. That is the model being right. But the
           * box then unticks itself, and "nothing it could separate" sounds
           * like the feature failing rather than the feature having nothing to
           * do, so it is worth spending a sentence on which of the two it is.
           */
          showing(
            'There is nothing behind the book to erase - the crop already ends at its edges. ' +
              'This is for a thumb or a shadow still inside the crop.',
          );
          erase.checked = false;
          if (qualityRow) qualityRow.hidden = true;
          erased = null;
          erasedImage = null;
          showResult();
          return;
        }

        const out = new ImageData(
          new Uint8ClampedArray(subject.data),
          subject.width,
          subject.height,
        );
        // Tightened before it is applied, or the soft boundary leaves a fringe
        // of whatever was behind the book smeared along every edge.
        const tightened = refineMask(mask);
        eraseBackground(out, tightened, fit);
        if (!current()) return;
        // Held on to rather than recomputed: the export warps the same corners
        // out of a larger copy, and the mask is addressed by relative position,
        // so the one already approved on screen is the right one to apply.
        erased = tightened;
        erasedImage = out;
        showResult();
        eraseNote.hidden = true;
      } catch (err) {
        console.error('background removal failed', err);
        if (!current()) return;
        showing('Could not do that here - the cropped photo is unchanged.');
        erase.checked = false;
        if (qualityRow) qualityRow.hidden = true;
        erased = null;
        erasedImage = null;
        showResult();
      }
    };

    /**
     * The same, but collapsed when it is asked for repeatedly.
     *
     * A nudge of a corner is one pointerup, and somebody lining a cover up
     * makes a dozen of them in a few seconds. Each one was a fresh 320x320
     * inference on single-threaded wasm; they cannot overlap usefully and on a
     * phone they cannot even keep up. Waiting a moment for the hand to settle
     * turns twelve runs into one.
     */
    let erasePending: ReturnType<typeof setTimeout> | null = null;
    const queueErase = () => {
      if (erasePending) clearTimeout(erasePending);
      erasePending = setTimeout(() => {
        erasePending = null;
        void applyErase();
      }, 250);
    };

    erase?.addEventListener('change', () => {
      if (qualityRow) qualityRow.hidden = !erase.checked;
      if (erase.checked) {
        void applyErase();
      } else {
        // Anything in flight belongs to a box that is no longer ticked.
        eraseRun++;
        if (erasePending) {
          clearTimeout(erasePending);
          erasePending = null;
        }
        if (eraseNote) eraseNote.hidden = true;
        erased = null;
        erasedImage = null;
        showResult();
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

    /**
     * Whether four corners still describe a book rather than a bow tie.
     *
     * Nothing stopped a corner being dragged past its neighbour, and a crossed
     * quad is still four points the warp will happily sample: the preview
     * folded over on itself at whatever proportions the crossing happened to
     * produce. Every turn going the same way is the whole test - convex, and
     * still in the order the warp reads.
     */
    const holdsShape = (quad: Point[]): boolean => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % 4];
        const c = quad[(i + 2) % 4];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (Math.abs(cross) < 1e-6) return false; // three in a line
        const way = cross > 0 ? 1 : -1;
        if (sign === 0) sign = way;
        else if (way !== sign) return false;
      }
      return true;
    };

    stage.addEventListener('pointermove', (e) => {
      if (dragging === null || !full) return;
      const p = at(e);
      // Clamped to the photo: a corner outside it warps in white, which
      // looks like a fault rather than a choice.
      const moved = {
        x: Math.min(full.width, Math.max(0, p.x)),
        y: Math.min(full.height, Math.max(0, p.y)),
      };
      const next = corners.map((c, i) => (i === dragging ? moved : c));
      /*
       * A move that would fold the quad is simply not made. The corner stops
       * against its neighbour instead, which is what a handle should do.
       *
       * Only ever a refusal to make it worse. If the quad is already folded -
       * the detector's four fitted lines can in principle meet that way, and
       * `isSane` measures its angles without minding which way they turn -
       * then refusing every move would leave the owner with four handles that
       * do not move and no way to put it right.
       */
      if (holdsShape(corners) && !holdsShape(next)) return;
      corners = next;
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
        // telling them something that is not true. Queued rather than run, so
        // a series of small adjustments costs one inference and not one each.
        if (erase?.checked) queueErase();
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
      erasedImage = null;
      cropped = null;
      // Retires anything still running, so a model that returns after the
      // dialog has gone cannot paint into the next photo's pane.
      eraseRun++;
      if (erasePending) {
        clearTimeout(erasePending);
        erasePending = null;
      }
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
      if (!panel || !note) return null;
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

      /*
       * Detection runs smaller again - it only needs to find a book, and a
       * quarter of a million pixels is enough for that - but it is reduced
       * from the large copy rather than from the working one.
       *
       * Going through `full` meant two reductions, the second of them from an
       * already-small picture, and what that costs is exactly the edge
       * definition the whole detector is reading. One step from 1600 to 240,
       * with the browser's own filter, is both cheaper and truer. The corners
       * are still expressed in `full`'s pixels below, by ratio, so nothing
       * downstream knows the difference.
       */
      const detectFrom = source;
      const detectScale = Math.min(
        1,
        DETECT_EDGE / Math.max(detectFrom.width, detectFrom.height),
      );
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(detectFrom.width * detectScale));
      small.height = Math.max(1, Math.round(detectFrom.height * detectScale));
      small.getContext('2d')!.drawImage(detectFrom, 0, 0, small.width, small.height);

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
      eraseRun++;
      erased = null;
      erasedImage = null;
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

  const framed = frameToBox(bitmap, bitmap.width, bitmap.height);
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

/**
 * The photo on a canvas of the shop's shape, widened or cropped per the rule.
 *
 * Takes anything drawable rather than an ImageBitmap so the review pane can
 * run it on the crop it is about to show. That pane and the upload have to
 * agree, and the only way to be sure they do is for both to call this.
 */
function frameToBox(
  picture: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const from = source.getContext('2d', { willReadFrequently: true });
  if (!from) return null;
  from.drawImage(picture, 0, 0);

  // Measured on the outermost column of each side, which is what decides
  // whether widening would be seamless or would show its join.
  const columnAt = (x: number) => {
    const strip = from.getImageData(x, 0, 1, height).data;
    return (y: number): [number, number, number] => [
      strip[y * 4],
      strip[y * 4 + 1],
      strip[y * 4 + 2],
    ];
  };
  const plan = framePlan({
    width,
    height,
    leftSpread: edgeSpread(columnAt(0), height),
    rightSpread: edgeSpread(columnAt(width - 1), height),
  });

  const out = document.createElement('canvas');
  const to = out.getContext('2d');
  if (!to) return null;

  if (plan.mode === 'extend') {
    out.width = plan.width;
    out.height = plan.height;
    if (plan.left) to.drawImage(source, 0, 0, 1, height, 0, 0, plan.left, plan.height);
    if (plan.right) {
      to.drawImage(
        source, width - 1, 0, 1, height,
        plan.left + width, 0, plan.right, plan.height,
      );
    }
    to.drawImage(source, plan.left, 0);
    return out;
  }

  const ratio = width / height;
  if (ratio < BOX) {
    out.width = width;
    out.height = Math.round(width / BOX);
    const spare = height - out.height;
    to.drawImage(source, 0, plan.anchor === 'north' ? 0 : -Math.round(spare / 2));
  } else {
    out.height = height;
    out.width = Math.round(height * BOX);
    to.drawImage(source, -Math.round((width - out.width) / 2), 0);
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
