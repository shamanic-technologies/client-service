import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * CI must REPLAY the migrations, never `db:push`.
 *
 * `drizzle-kit push` builds tables from `schema.ts`, so it cannot create
 * anything that exists only as SQL — the gold `reward_task_status` view and the
 * `reward_task_due_at()` function that defines the 30-day refresh cadence among
 * them. Production runs `migrate()` at boot, so a CI that pushes is testing a
 * schema production never has: every reward-task read 500s there and passes
 * locally. It cost one red CI cycle on the ledger's first ship.
 */
describe("CI database setup", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf-8");

  it("replays the migrations rather than pushing the schema", () => {
    expect(workflow).toContain("pnpm db:migrate");
    expect(workflow).not.toContain("pnpm db:push");
  });
});
