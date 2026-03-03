import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import { sql } from "../../src/db/index.js";
import { closeDb } from "../helpers/test-db.js";

/**
 * Regression test for migration 0006: deduplication of external_id rows.
 *
 * Under the old schema (composite unique on app_id + external_id), the same
 * external_id could appear in multiple rows. Migration 0006 must merge these
 * before creating the unique index on external_id alone.
 */
describe("migration 0006 dedup logic", () => {
  beforeEach(async () => {
    // Drop the unique index so we can insert duplicates
    await sql`DROP INDEX IF EXISTS "idx_users_external_id"`;
    await sql`DELETE FROM users`;
    await sql`DELETE FROM orgs`;
  });

  afterEach(async () => {
    // Recreate the unique index to restore normal schema state
    await sql`DELETE FROM users`;
    await sql`DELETE FROM orgs`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_external_id" ON "users" USING btree ("external_id")`;
  });

  afterAll(async () => {
    await closeDb();
  });

  /** The dedup SQL extracted from migration 0006 */
  async function runDedupSql() {
    // Merge all profile data into the oldest row per external_id using aggregation
    await sql`
      WITH aggregated AS (
        SELECT
          external_id,
          (array_agg(id ORDER BY created_at ASC))[1] AS keep_id,
          (array_remove(array_agg(org_id ORDER BY created_at ASC), NULL))[1] AS org_id,
          (array_remove(array_agg(email ORDER BY created_at ASC), NULL))[1] AS email,
          (array_remove(array_agg(first_name ORDER BY created_at ASC), NULL))[1] AS first_name,
          (array_remove(array_agg(last_name ORDER BY created_at ASC), NULL))[1] AS last_name,
          (array_remove(array_agg(image_url ORDER BY created_at ASC), NULL))[1] AS image_url,
          (array_remove(array_agg(phone ORDER BY created_at ASC), NULL))[1] AS phone
        FROM users
        WHERE external_id IS NOT NULL
        GROUP BY external_id
        HAVING COUNT(*) > 1
      )
      UPDATE users
      SET
        org_id = aggregated.org_id,
        email = aggregated.email,
        first_name = aggregated.first_name,
        last_name = aggregated.last_name,
        image_url = aggregated.image_url,
        phone = aggregated.phone
      FROM aggregated
      WHERE users.id = aggregated.keep_id
    `;

    // Delete newer duplicate rows
    await sql`
      DELETE FROM users
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY external_id ORDER BY created_at ASC
          ) AS rn
          FROM users
          WHERE external_id IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `;
  }

  it("should merge duplicate external_id rows and keep the oldest", async () => {
    // Insert an org for the FK constraint
    const [org] = await sql`
      INSERT INTO orgs (external_id, name) VALUES ('org-1', 'Test Org')
      RETURNING id
    `;

    // Insert the older row (has profile data, no org_id) — simulates pre-migration state
    const [older] = await sql`
      INSERT INTO users (external_id, email, first_name, last_name, created_at)
      VALUES ('user-dup', 'kevin@test.com', 'Kevin', 'Lourd', '2026-02-27T03:00:00Z')
      RETURNING id
    `;

    // Insert the newer row (has org_id, no profile data)
    await sql`
      INSERT INTO users (external_id, org_id, created_at)
      VALUES ('user-dup', ${org.id}, '2026-03-02T07:00:00Z')
    `;

    // Verify we have 2 rows
    const before = await sql`SELECT COUNT(*)::int as cnt FROM users WHERE external_id = 'user-dup'`;
    expect(before[0].cnt).toBe(2);

    // Run the dedup logic
    await runDedupSql();

    // Should have exactly 1 row left
    const after = await sql`SELECT * FROM users WHERE external_id = 'user-dup'`;
    expect(after).toHaveLength(1);

    // Should be the older row (preserved ID)
    expect(after[0].id).toBe(older.id);

    // Should have merged data: profile from older + org_id from newer
    expect(after[0].email).toBe("kevin@test.com");
    expect(after[0].first_name).toBe("Kevin");
    expect(after[0].last_name).toBe("Lourd");
    expect(after[0].org_id).toBe(org.id);
  });

  it("should not touch rows with unique external_ids", async () => {
    await sql`
      INSERT INTO users (external_id, email) VALUES ('unique-1', 'a@test.com')
    `;
    await sql`
      INSERT INTO users (external_id, email) VALUES ('unique-2', 'b@test.com')
    `;

    await runDedupSql();

    const rows = await sql`SELECT * FROM users ORDER BY external_id`;
    expect(rows).toHaveLength(2);
    expect(rows[0].external_id).toBe("unique-1");
    expect(rows[1].external_id).toBe("unique-2");
  });

  it("should not touch rows with null external_id", async () => {
    await sql`INSERT INTO users (external_id) VALUES (NULL)`;
    await sql`INSERT INTO users (external_id) VALUES (NULL)`;

    await runDedupSql();

    const rows = await sql`SELECT * FROM users WHERE external_id IS NULL`;
    expect(rows).toHaveLength(2);
  });

  it("should handle three-way duplicates", async () => {
    const [org] = await sql`
      INSERT INTO orgs (external_id, name) VALUES ('org-3way', 'Org')
      RETURNING id
    `;

    // Oldest: has email
    const [oldest] = await sql`
      INSERT INTO users (external_id, email, created_at)
      VALUES ('user-3way', 'first@test.com', '2026-01-01T00:00:00Z')
      RETURNING id
    `;

    // Middle: has org_id
    await sql`
      INSERT INTO users (external_id, org_id, created_at)
      VALUES ('user-3way', ${org.id}, '2026-02-01T00:00:00Z')
    `;

    // Newest: has phone
    await sql`
      INSERT INTO users (external_id, phone, created_at)
      VALUES ('user-3way', '+1234567890', '2026-03-01T00:00:00Z')
    `;

    await runDedupSql();

    const rows = await sql`SELECT * FROM users WHERE external_id = 'user-3way'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oldest.id);
    expect(rows[0].email).toBe("first@test.com");
    expect(rows[0].org_id).toBe(org.id);
    expect(rows[0].phone).toBe("+1234567890");
  });
});
