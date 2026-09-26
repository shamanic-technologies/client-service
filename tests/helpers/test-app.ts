import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import resolveRoutes from "../../src/routes/resolve.js";
import phoneAccountsRoutes from "../../src/routes/phone-accounts.js";
import usersRoutes from "../../src/routes/users.js";
import orgsRoutes from "../../src/routes/orgs.js";
import orgClaimRoutes from "../../src/routes/org-claim.js";
import orgRealityRoutes from "../../src/routes/org-reality.js";
import checkoutStatusRoutes from "../../src/routes/checkout-status.js";
import rewardTasksRoutes from "../../src/routes/reward-tasks.js";
import statsRoutes from "../../src/routes/stats.js";
import invitesRoutes from "../../src/routes/invites.js";
import waitlistRoutes from "../../src/routes/waitlist.js";
import acquisitionsRoutes from "../../src/routes/acquisitions.js";

/**
 * Create a test Express app instance with all routes
 */
export function createTestApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use(healthRoutes);
  app.use(resolveRoutes);
  app.use(phoneAccountsRoutes);
  app.use(usersRoutes);
  app.use(orgsRoutes);
  app.use(orgClaimRoutes);
  app.use(orgRealityRoutes);
  app.use(checkoutStatusRoutes);
  app.use(rewardTasksRoutes);
  app.use(statsRoutes);
  app.use(invitesRoutes);
  app.use(waitlistRoutes);
  app.use(acquisitionsRoutes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
