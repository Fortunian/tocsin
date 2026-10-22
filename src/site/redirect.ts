import type { MiddlewareHandler } from "hono";

// tocsin.so is an alias: every request there answers 301 to the same path and
// query on tocsin.sh. URL.hostname is already lowercase and has no port.
const ALIAS_HOSTS = new Set(["tocsin.so", "www.tocsin.so"]);

export const soRedirect: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  if (ALIAS_HOSTS.has(url.hostname.toLowerCase())) {
    return c.redirect(`https://tocsin.sh${url.pathname}${url.search}`, 301);
  }
  await next();
};
