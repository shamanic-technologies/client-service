import { Router } from "express";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireApiKey, AuthenticatedRequest, clerk } from "../middleware/auth.js";
import { ClerkUserIdParamSchema } from "../schemas.js";

const router = Router();

// Get or create user from Clerk ID
router.post("/users/sync", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const clerkUserId = req.clerkUserId!;

    const clerkUser = await clerk.users.getUser(clerkUserId);
    const profileData = {
      email: clerkUser.emailAddresses[0]?.emailAddress ?? null,
      firstName: clerkUser.firstName ?? null,
      lastName: clerkUser.lastName ?? null,
      imageUrl: clerkUser.imageUrl ?? null,
    };

    const [user] = await db
      .insert(users)
      .values({ clerkUserId, ...profileData })
      .onConflictDoUpdate({
        target: users.clerkUserId,
        set: { ...profileData, updatedAt: new Date() },
      })
      .returning();

    const created = user.createdAt.getTime() === user.updatedAt.getTime();
    return res.json({ user, created });
  } catch (error) {
    console.error("User sync error:", error);
    return res.status(500).json({ error: "Failed to sync user" });
  }
});

// Get user by Clerk ID
router.get("/users/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const clerkUserId = req.clerkUserId!;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ error: "Failed to get user" });
  }
});

// Get internal user ID from Clerk ID (for other services)
router.get("/users/by-clerk/:clerkUserId", requireApiKey, async (req, res) => {
  try {
    const parsed = ClerkUserIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
    }

    const { clerkUserId } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
  } catch (error) {
    console.error("Get user by clerk error:", error);
    return res.status(500).json({ error: "Failed to get user" });
  }
});

export default router;
