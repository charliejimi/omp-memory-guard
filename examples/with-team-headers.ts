// Load this file instead of the package when another extension adds its own memory block to the
// system prompt. List it last, after that extension. In a project that installs the package, import
// from "omp-memory-guard" instead of "../src/index".
import { createMemoryGuard } from "../src/index";

export default createMemoryGuard({
	extraBlockHeaders: [{ open: /^## Team memory\b/i }],
	entry: import.meta.path,
});
