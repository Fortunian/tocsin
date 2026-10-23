// The bun-runtime ingester: the oven-sh/bun GitHub repository security
// advisories, through the shared GitHub runtime ingester.
import { githubRuntimeIngester, type GithubRuntimeDefaults } from "./github-runtime";

// Code fallbacks for sources.config_json of row "bun-runtime" (repo iron rule 5).
export const BUN_DEFAULTS: GithubRuntimeDefaults = {
  advisories_url: "https://api.github.com/repos/oven-sh/bun/security-advisories",
  releases_url: "https://api.github.com/repos/oven-sh/bun/releases",
  // Bun tags its releases bun-v1.1.30.
  release_tag_prefix: "bun-v",
  exclude_package_pattern: "_",
  page_size: 100,
  max_pages: 10,
  // 100 is the GitHub maximum per page.
  release_page_size: 100,
  max_release_pages: 5,
};

export const bunRuntime = githubRuntimeIngester("bun-runtime", "bun", BUN_DEFAULTS);
