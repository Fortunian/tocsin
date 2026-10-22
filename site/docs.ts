import { DOCS_HTML } from "./docs.generated";
import { page } from "./layout";

// docs.generated.ts comes from docs/API.md (npm run gen:docs).
export function renderDocs(): string {
  return page("tocsin API docs", DOCS_HTML);
}
