import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import type { EmailOtp } from "../db.types";

/**
 * `email_otp` — the one-time sign-in codes.
 *
 * Like auth_session, this table only ever holds a *hash* of the secret (code_hash), never
 * the code itself — see lib/password.ts. Expiry, single-use and the wrong-guess cap are all
 * enforced by the service (otp-auth.service.ts); this model is just the storage.
 */
export class EmailOtpModel extends DBModel {
  static async create(input: {
    userId: string;
    codeHash: string;
    expiresAt: Date;
    purpose?: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<string> {
    const db = await this.getKyselyDB();
    const row = await db
      .insertInto("email_otp")
      .values({
        user_id: input.userId,
        purpose: input.purpose ?? "login",
        code_hash: input.codeHash,
        expires_at: input.expiresAt.toISOString(),
        ip: input.ip?.slice(0, 64) ?? null,
        user_agent: input.userAgent?.slice(0, 500) ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return String((row as { id: string | number }).id);
  }

  /**
   * Burn every still-pending code this user has, before issuing a fresh one — so a user who
   * asks for a second code cannot then sign in with the first. Stamping consumed_at is enough:
   * the lookup below refuses any row that has it set.
   */
  static async invalidatePending(userId: string, purpose = "login"): Promise<void> {
    const db = await this.getKyselyDB();
    await db
      .updateTable("email_otp")
      .set({ consumed_at: sql`now()` })
      .where("user_id", "=", userId)
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .execute();
  }

  /** The row for a challenge reference, or undefined if the id is not a valid bigint. */
  static async findById(id: string): Promise<EmailOtp | undefined> {
    if (!/^\d+$/.test(id)) return undefined; // bigint PK: a non-numeric ref can never match
    const db = await this.getKyselyDB();
    return db
      .selectFrom("email_otp")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst() as Promise<EmailOtp | undefined>;
  }

  /** Record one wrong guess and return the new total, so the caller can burn a code that hit the cap. */
  static async incrementAttempts(id: string): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .updateTable("email_otp")
      .set({ attempts: sql`attempts + 1` })
      .where("id", "=", id)
      .returning("attempts")
      .executeTakeFirst();
    return Number((row as { attempts?: number } | undefined)?.attempts ?? 0);
  }

  /**
   * Spend the code — but only if it is still unspent. The `consumed_at is null` guard makes
   * this the atomic winner-takes-all step: two requests racing the same code, only the one
   * that flips the row from null gets `true`, so a code is never accepted twice.
   */
  static async consume(id: string): Promise<boolean> {
    const db = await this.getKyselyDB();
    const res = await db
      .updateTable("email_otp")
      .set({ consumed_at: sql`now()` })
      .where("id", "=", id)
      .where("consumed_at", "is", null)
      .executeTakeFirst();
    return Number(res?.numUpdatedRows ?? 0) > 0;
  }

  /** Housekeeping: reclaim spent and expired rows. Safe to run on a timer. */
  static async deleteExpired(): Promise<number> {
    const db = await this.getKyselyDB();
    const res = await db
      .deleteFrom("email_otp")
      .where((eb) =>
        eb.or([eb(sql`expires_at`, "<", sql`now()`), eb("consumed_at", "is not", null)])
      )
      .executeTakeFirst();
    return Number(res?.numDeletedRows ?? 0);
  }
}
