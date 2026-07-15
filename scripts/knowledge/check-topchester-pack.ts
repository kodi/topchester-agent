import { checkTopchesterProductPack } from "../../src/knowledge/product/pack.js";
import { createSelectedKnowledgeContext, formatL1ContextPackForPrompt } from "../../src/knowledge/sources/index.js";

const result = await checkTopchesterProductPack(process.cwd());
const context = await createSelectedKnowledgeContext(
  process.cwd(),
  "Topchester configuration and knowledge sync",
  "topchester",
  { packageRoot: process.cwd(), productVersion: result.manifest.productVersion }
);
if (!context.contextPack) throw new Error("Product pack did not produce context for the representative product query.");
const promptBytes = Buffer.byteLength(formatL1ContextPackForPrompt(context.contextPack));
if (promptBytes > 24 * 1024) {
  throw new Error(`Representative product context is too large: ${promptBytes} bytes (limit 24576).`);
}
console.log(
  `Topchester product knowledge is current: ${result.sourcePaths.length} sources, ${result.entryPaths.length} entries, ${result.bytes} bytes; representative prompt context ${promptBytes} bytes.`
);
