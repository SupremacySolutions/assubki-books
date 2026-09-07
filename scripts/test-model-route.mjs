// The real model route with an R2 miss: Range does not make a missing file exist.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(join(tmpdir(), 'asb-model-route-'));
try {
  await build({entryPoints:['src/pages/model/[...key].ts'],bundle:true,platform:'node',format:'esm',outfile:join(temp,'route.mjs'),
    plugins:[{name:'missing-r2-object',setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'test'}));
      b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const env={UPLOADS:{get:async()=>null}};'}));
    }}],
  });
  const {GET}=await import(pathToFileURL(join(temp,'route.mjs')));
  for (const headers of [{},{Range:'bytes=0-99'}]) {
    const response=await GET({params:{key:'models/missing.onnx'},request:new Request('https://example.invalid/model/models/missing.onnx',{headers})});
    assert.equal(response.status,404);
  }
  console.log('PASS missing model returns 404 with and without a range');
} finally {rmSync(temp,{recursive:true,force:true});}
