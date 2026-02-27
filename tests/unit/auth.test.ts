import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requireApiKey } from "../../src/middleware/auth.js";

describe("requireApiKey middleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockReq = { headers: {} };
    mockRes = { status: statusMock, json: jsonMock } as any;
    mockNext = vi.fn();
    process.env.CLIENT_SERVICE_API_KEY = "test_api_key";
  });

  it("should call next() with valid API key", () => {
    mockReq.headers = { "x-api-key": "test_api_key" };
    requireApiKey(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("should reject missing API key", () => {
    requireApiKey(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should reject wrong API key", () => {
    mockReq.headers = { "x-api-key": "wrong-key" };
    requireApiKey(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 500 if CLIENT_SERVICE_API_KEY not configured", () => {
    delete process.env.CLIENT_SERVICE_API_KEY;
    mockReq.headers = { "x-api-key": "any-key" };
    requireApiKey(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

describe("Clerk removal verification", () => {
  it("auth.ts should not import @clerk/backend", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const content = readFileSync(resolve(__dirname, "../../src/middleware/auth.ts"), "utf-8");
    expect(content).not.toContain("@clerk/backend");
    expect(content).not.toContain("verifyToken");
    expect(content).not.toContain("createClerkClient");
  });

  it("auth.ts should not export requireAuth or clerk", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const content = readFileSync(resolve(__dirname, "../../src/middleware/auth.ts"), "utf-8");
    expect(content).not.toContain("requireAuth");
    expect(content).not.toContain("export { clerk }");
  });
});
