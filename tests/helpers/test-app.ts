import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import resolveRoutes from "../../src/routes/resolve.js";
import usersRoutes from "../../src/routes/users.js";

/**
 * Create a test Express app instance with all routes
 */
export function createTestApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use(healthRoutes);
  app.use(resolveRoutes);
  app.use(usersRoutes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
