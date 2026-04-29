import { Router } from "express";
import { count, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

/**
 * GET /public/stats - Platform-wide stats (total orgs, users, monthly growth)
 */
router.get("/public/stats/users", requireApiKey, async (_req, res) => {
  try {
    const [
      [{ totalOrgs }],
      [{ totalUsers }],
      monthlyOrgs,
      monthlyUsers,
    ] = await Promise.all([
      db.select({ totalOrgs: count() }).from(orgs),
      db.select({ totalUsers: count() }).from(users),
      db
        .select({
          month: sql<string>`TO_CHAR(DATE_TRUNC('month', ${orgs.createdAt}), 'YYYY-MM')`,
          count: count(),
        })
        .from(orgs)
        .groupBy(sql`DATE_TRUNC('month', ${orgs.createdAt})`)
        .orderBy(sql`DATE_TRUNC('month', ${orgs.createdAt})`),
      db
        .select({
          month: sql<string>`TO_CHAR(DATE_TRUNC('month', ${users.createdAt}), 'YYYY-MM')`,
          count: count(),
        })
        .from(users)
        .groupBy(sql`DATE_TRUNC('month', ${users.createdAt})`)
        .orderBy(sql`DATE_TRUNC('month', ${users.createdAt})`),
    ]);

    // Merge monthly org and user counts into a single array
    const monthMap = new Map<string, { newOrgs: number; newUsers: number }>();
    for (const row of monthlyOrgs) {
      monthMap.set(row.month, { newOrgs: row.count, newUsers: 0 });
    }
    for (const row of monthlyUsers) {
      const existing = monthMap.get(row.month);
      if (existing) {
        existing.newUsers = row.count;
      } else {
        monthMap.set(row.month, { newOrgs: 0, newUsers: row.count });
      }
    }

    const monthlyGrowth = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, counts]) => ({ month, ...counts }));

    return res.json({ totalOrgs, totalUsers, monthlyGrowth });
  } catch (error) {
    console.error("[client-service] Public stats error:", error);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

export default router;
