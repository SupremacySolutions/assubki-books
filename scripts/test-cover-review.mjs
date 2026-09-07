// Exercise the real dialog handlers with controllable inference and canvas I/O.
// Geometry has separate pixel tests in test-cover-clean.mjs.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

class Element {
  handlers = new Map();
  checked = false;
  hidden = false;
  textContent = '';
  addEventListener(name, fn) {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
  }
  fire(name, fields = {}) {
    for (const fn of this.handlers.get(name) ?? []) fn({ target: this, ...fields });
  }
  setAttribute() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 140 }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
class Canvas extends Element {
  width = 100;
  height = 140;
  getContext() {
    return {
      drawImage() {}, putImageData() {}, fillRect() {},
      getImageData: (_x, _y, w, h) => new ImageData(w, h),
    };
  }
  toBlob(callback) { callback(new Blob(['photo'], { type: 'image/webp' })); }
}
globalThis.ImageData = class {
  constructor(data, width, height) {
    if (typeof data === 'number') {
      this.width = data; this.height = width;
      this.data = new Uint8ClampedArray(data * width * 4);
    } else { this.data = data; this.width = width; this.height = height; }
  }
};
const ids = ['cleanPanel', 'cleanStage', 'cleanSource', 'cleanOverlay', 'cleanResult',
  'cleanNote', 'cleanErase', 'cleanEraseNote', 'cleanQualityRow', 'cleanCancel',
  'cleanReport', 'cleanRaw', 'cleanUse'];
const elements = Object.fromEntries(ids.map(id => [id, new Canvas()]));
globalThis.document = {
  querySelector: selector => elements[selector.slice(1)] ?? null,
  querySelectorAll: () => [],
  createElement: () => new Canvas(),
};
globalThis.window = {};
globalThis.localStorage = { getItem() { return null; } };
globalThis.createImageBitmap = async () => ({ width: 100, height: 140 });
let resolveInference, rejectInference;
let eraseCalls = 0;
globalThis.coverReviewTest = {
  erased() { eraseCalls++; },
  infer() { return new Promise((resolve, reject) => { resolveInference = resolve; rejectInference = reject; }); },
};
const temp = mkdtempSync(join(tmpdir(), 'asb-cover-review-'));
try {
  await build({
    entryPoints: ['src/scripts/cover-review.ts'], bundle: true, platform: 'node',
    format: 'esm', outfile: join(temp, 'review.mjs'),
    plugins: [{ name: 'controlled-images', setup(b) {
      b.onResolve({ filter: /^(\.\/cover-clean|onnxruntime-web\/wasm)$/ }, ({path}) => ({path, namespace: 'fixture'}));
      b.onLoad({filter: /.*/, namespace: 'fixture'}, ({path}) => ({contents: path === './cover-clean' ? `
        export const DETECT_EDGE=240, MASK_EDGE=320;
        export const detectQuad=()=>[{x:0,y:0},{x:100,y:0},{x:100,y:140},{x:0,y:140}];
        export const quadSize=()=>({width:100,height:140});
        export const warp=()=>true;
        export const maskFit=()=>({width:100,height:140});
        export const toTensor=()=>new Float32Array(1);
        export const checkMask=x=>x;
        export const refineMask=x=>x;
        export const eraseBackground=()=>globalThis.coverReviewTest.erased();
      ` : `
        export const env={wasm:{}};
        export class Tensor {}
        export const InferenceSession={create:async()=>({inputNames:['in'],outputNames:['out'],run:()=>globalThis.coverReviewTest.infer()})};
      `}));
    }}],
  });
  const { mountCoverReview } = await import(pathToFileURL(join(temp, 'review.mjs')));
  mountCoverReview();
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const open = async () => {
    const result = window.coverClean.review(new File(['photo'], 'photo.webp', {type:'image/webp'}));
    await flush();
    return { result };
  };
  const startErase = async () => {
    elements.cleanErase.checked = true;
    elements.cleanErase.fire('change');
    await flush();
  };
  const drag = () => {
    elements.cleanStage.fire('pointerdown', {target:{getAttribute:()=> '0'}, pointerId:1, preventDefault(){}});
    elements.cleanStage.fire('pointermove', {clientX:10,clientY:10});
  };
  const first = await open();
  await startErase();
  resolveInference({out:{data:new Float32Array([1])}});
  await flush();
  assert.equal(eraseCalls, 1, 'successful inference paints the erased preview');
  drag();
  elements.cleanStage.fire('pointerup');
  elements.cleanUse.fire('click');
  assert.ok(await first.result instanceof File);
  assert.equal(eraseCalls, 1, 'export during the next inference must not reuse the previous crop mask');
  console.log('PASS exporting a changed crop discards the old mask');

  const second = await open();
  await startErase();
  drag();
  const originalError = console.error;
  console.error = () => {};
  try {
    rejectInference(new Error('obsolete inference failed'));
    await flush();
  } finally { console.error = originalError; }
  assert.equal(elements.cleanErase.checked, true, 'an obsolete failure cannot untick the new crop');
  elements.cleanStage.fire('pointerup');
  elements.cleanCancel.fire('click');
  assert.equal(await second.result, null);
  console.log('PASS an obsolete inference failure cannot change the current dialog');
} finally {
  rmSync(temp, {recursive:true, force:true});
}
