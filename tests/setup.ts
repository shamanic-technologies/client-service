import { beforeAll, afterAll } from "vitest";

// Set test environment variables
process.env.CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY || "test_api_key";
process.env.CLIENT_SERVICE_DATABASE_URL = process.env.CLIENT_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/client_test";

beforeAll(() => {
  console.log("Test suite starting...");
});

afterAll(() => {
  console.log("Test suite complete.");
});
