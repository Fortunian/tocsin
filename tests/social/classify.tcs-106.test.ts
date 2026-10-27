import { describe, expect, it } from "vitest";
import { classifyXAnswer } from "../../src/social/x";

// TCS-106 classifyXAnswer table: one pure rule for the lane, the replay route
// and the contract suite. Billing (comment 6447345509: a real post can fail
// with a billing error when the account has no credits) is a vendor answer,
// kind "billing", never terminal. Source of the billing shapes: assumed (plan
// ASSUMPTIONS 13; X's exact billing body is not in a fixture on this box).

describe("classifyXAnswer", () => {
  const rows: [string, number, string, string][] = [
    // billing side
    ["402 with any body", 402, "whatever", "billing"],
    ["402 with an empty body", 402, "", "billing"],
    ["403 CreditsDepleted", 403, '{"title":"CreditsDepleted","detail":"Your enrolled account does not have any credits"}', "billing"],
    ["403 client-not-enrolled", 403, '{"reason":"client-not-enrolled","title":"Client Forbidden"}', "billing"],
    ["403 payment required", 403, '{"detail":"Payment Required for this endpoint"}', "billing"],
    // near misses: not billing
    ["403 duplicate content", 403, '{"detail":"You are not allowed to create a Tweet with duplicate content."}', "terminal"],
    ["403 plain", 403, "Forbidden", "terminal"],
    ["401", 401, '{"title":"Unauthorized"}', "terminal"],
    ["400", 400, '{"title":"Invalid Request"}', "terminal"],
    ["429", 429, '{"title":"Too Many Requests"}', "retryable"],
    ["500", 500, "oops", "retryable"],
    ["503", 503, "Service Unavailable", "retryable"],
    ["201 with data.id", 201, '{"data":{"id":"1850000000000000000","text":"hi"}}', "ok"],
    ["201 without data", 201, "{}", "empty"],
    ["200 with data.id empty", 200, '{"data":{"id":""}}', "empty"],
    ["200 with a body that is not JSON", 200, "<html>", "empty"],
  ];
  for (const [name, status, body, kind] of rows) {
    it(`${name} -> ${kind}`, () => {
      const r = classifyXAnswer(status, body);
      expect(r.kind).toBe(kind);
      expect(r.status).toBe(status);
    });
  }

  it("ok carries the post id and no error", () => {
    expect(classifyXAnswer(201, '{"data":{"id":"1850000000000000000"}}')).toEqual({ kind: "ok", status: 201, id: "1850000000000000000" });
  });

  it("an error answer carries 'x answered <status>: <body>' cut to 200 chars", () => {
    const r = classifyXAnswer(403, "e".repeat(1000));
    expect(r.error!.startsWith("x answered 403: eee")).toBe(true);
    expect(r.error!.length).toBe(200);
    expect(classifyXAnswer(402, "no credits").error).toBe("x answered 402: no credits");
  });
});
