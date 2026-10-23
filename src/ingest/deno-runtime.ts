// The deno-runtime ingester: the denoland/deno GitHub repository security
// advisories, through the shared GitHub runtime ingester.
import { githubRuntimeIngester, type GithubRuntimeDefaults } from "./github-runtime";

// Code fallbacks for sources.config_json of row "deno-runtime" (repo iron rule 5).
export const DENO_DEFAULTS: GithubRuntimeDefaults = {
  advisories_url: "https://api.github.com/repos/denoland/deno/security-advisories",
  releases_url: "https://api.github.com/repos/denoland/deno/releases",
  release_tag_prefix: "v",
  // A package name with "_" is a library crate (deno_fetch, serde_v8), not the runtime.
  exclude_package_pattern: "_",
  page_size: 100,
  max_pages: 10,
  // 100 is the GitHub maximum per page.
  release_page_size: 100,
  max_release_pages: 5,
};

export const denoRuntime = githubRuntimeIngester("deno-runtime", "deno", DENO_DEFAULTS);
