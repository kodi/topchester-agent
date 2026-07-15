import { buildTopchesterProductPack } from "../../src/knowledge/product/pack.js";

const result = await buildTopchesterProductPack(process.cwd());
console.log(
  `Built Topchester product knowledge ${result.manifest.productVersion}: ${result.sourcePaths.length} sources, ${result.entryPaths.length} entries, ${result.bytes} bytes.`
);
