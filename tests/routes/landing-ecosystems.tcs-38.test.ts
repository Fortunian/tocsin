import { describe, expect, it } from "vitest";
import { get } from "./seed.tcs-3";

// TCS-38: the landing hook names the ecosystems /v1/check now covers.

describe("landing hook (GET /)", () => {
  it("names Java, .NET, Elixir, Dart, Alpine and Debian in the hook paragraph", async () => {
    const res = await get("/", "192.0.2.238");
    expect(res.status).toBe(200);
    const html = await res.text();
    const hook = /<p>Your agent runs on ([\s\S]*?)<\/p>/.exec(html)?.[1].replace(/\s+/g, " ") ?? "";
    expect(hook).toBe(
      "Node, PHP, Python, Go, Rust, Ruby, Java, .NET, Elixir, Dart, Alpine, Debian and the packages on top of them. When one of them ships a critical fix, nothing tells the agent. Tocsin does. One feed. One command.",
    );
    for (const name of ["Java", ".NET", "Elixir", "Dart", "Alpine", "Debian"]) expect(hook).toContain(name);
  });
});
