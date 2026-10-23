import { describe, expect, it } from "vitest";
import { get } from "./seed.tcs-3";

const ip = "192.0.2.187";

describe("llms.txt OS package input (production entry src/index.ts)", () => {
  it("does not offer dpkg -l, whose rows are all skipped as binary_package_name", async () => {
    const res = await get("/llms.txt", ip);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("dpkg -l");
  });

  it("offers apk list --installed and the dpkg-query source-package form", async () => {
    const res = await get("/llms.txt", ip);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("apk list --installed");
    expect(text).toContain("dpkg-query -W -f='${source:Package} ${Version}\\n'");
  });
});
