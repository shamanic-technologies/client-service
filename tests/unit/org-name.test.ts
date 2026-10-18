import { describe, it, expect } from "vitest";
import { orgNameForEmail } from "../../src/lib/org-name.js";

describe("orgNameForEmail", () => {
  it("names a company address after its domain", () => {
    expect(orgNameForEmail("jane@acme.io")).toBe("acme.io");
    expect(orgNameForEmail("Jane@Acme.IO")).toBe("acme.io");
  });

  it.each(["gmail.com", "outlook.com", "icloud.com", "hotmail.com", "yahoo.com", "proton.me"])(
    "never names a %s org after the provider",
    (domain) => {
      const name = orgNameForEmail(`jane.doe@${domain}`);
      expect(name).toBe("Jane Doe");
      expect(name).not.toContain(domain);
    },
  );

  it("reads the person's name off the local part", () => {
    expect(orgNameForEmail("JANE_DOE+news@gmail.com")).toBe("Jane Doe");
    expect(orgNameForEmail("j-smith42@outlook.com")).toBe("J Smith");
    expect(orgNameForEmail("kevin@icloud.com")).toBe("Kevin");
    expect(orgNameForEmail("élodie.martin@GMAIL.com")).toBe("Élodie Martin");
  });

  it("falls back to the local part as typed when it holds no letters", () => {
    expect(orgNameForEmail("12345@gmail.com")).toBe("12345");
  });
});
