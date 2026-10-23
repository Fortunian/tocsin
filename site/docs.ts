import { DOCS_HTML } from "./docs.generated";
import { installLinks } from "./install";
import { page } from "./layout";

// The install links go right after the connect command block. The block comes
// from docs/API.md; if it is ever missing, the page renders without the links.
const CONNECT_BLOCK = "<pre><code>npx tocsin connect</code></pre>";

// docs.generated.ts comes from docs/API.md (npm run gen:docs).
export function renderDocs(): string {
  return page("tocsin API docs", DOCS_HTML.replace(CONNECT_BLOCK, () => `${CONNECT_BLOCK}\n${installLinks()}`));
}
