import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import type { AppUser } from "../db.types";

/**
 * `auth_session` — the live logins.
 *
 * Everything here takes a *token hash*, never a token: the plaintext exists only in the
 * browser's cookie and in the one request that carries it. See lib/session.ts.
 */

/** A session that is still valid, together with the user it belongs to. */
export interface ActiveSession {
  id: string;
  expires_at: string;
  user: AppUser;
}

export class AuthSessionModel extends DBModel {
  static async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<void> {
    const db = await this.getKyselyDB();
    await db
      .insertInto("auth_session")
      .values({
        user_id: input.userId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt.toISOString(),
        // A stored UA is only for the user recognising their own devices; cap it so a
        // hostile client can't push megabytes into the row.
        user_agent: input.userAgent?.slice(0, 500) ?? null,
        ip: input.ip?.slice(0, 64) ?? null,
      })
      .execute();
  }

  /**
   * The hot path — one query per authenticated request.
   *
   * Expiry and `is_active` are checked in SQL rather than in the caller, so a disabled
   * account or a lapsed session simply fails to resolve. That is what makes revocation
   * immediate: there is no cached claim to outlive the row.
   */
  static async findActive(tokenHash: string): Promise<ActiveSession | undefined> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("auth_session as s")
      .innerJoin("app_user as u", "u.id", "s.user_id")
      .select([
        "s.id as id",
        "s.expires_at as expires_at",
        "u.id as user_id",
        "u.email as email",
        "u.password_hash as password_hash",
        "u.name as name",
        "u.roles as roles",
        "u.is_active as is_active",
        "u.last_login_at as last_login_at",
        "u.last_login_ip as last_login_ip",
        "u.created_at as created_at",
        "u.updated_at as updated_at",
      ])
      .where("s.token_hash", "=", tokenHash)
      .where(sql<boolean>`s.expires_at > now()`)
      .where("u.is_active", "=", true)
      .executeTakeFirst();

    if (!row) return undefined;

    const r = row as unknown as Record<string, unknown>;
    return {
      id: String(r.id),
      expires_at: String(r.expires_at),
      user: {
        id: String(r.user_id),
        email: r.email as string,
        password_hash: r.password_hash as string,
        name: (r.name as string | null) ?? null,
        roles: (r.roles as string[] | null) ?? [],
        is_active: r.is_active as boolean,
        last_login_at: (r.last_login_at as string | null) ?? null,
        last_login_ip: (r.last_login_ip as string | null) ?? null,
        created_at: String(r.created_at),
        updated_at: String(r.updated_at),
      },
    };
  }

  /**
   * Sliding expiry: an active user is not thrown out mid-task. Only writes when the
   * session is past its half-life, so a busy tab doesn't produce an UPDATE per request.
   */
  static async touch(sessionId: string, expiresAt: Date): Promise<void> {
    const db = await this.getKyselyDB();
    await db
      .updateTable("auth_session")
      .set({ last_seen_at: sql`now()`, expires_at: expiresAt.toISOString() })
      .where("id", "=", sessionId)
      .execute();
  }

  /** Sign out: the row is gone, so the token in the wild is now worthless. */
  static async deleteByTokenHash(tokenHash: string): Promise<number> {
    const db = await this.getKyselyDB();
    const res = await db.deleteFrom("auth_session").where("token_hash", "=", tokenHash).executeTakeFirst();
    return Number(res?.numDeletedRows ?? 0);
  }

  /** "Sign out everywhere" — also the right move after a password change. */
  static async deleteAllForUser(userId: string): Promise<number> {
    const db = await this.getKyselyDB();
    const res = await db.deleteFrom("auth_session").where("user_id", "=", userId).executeTakeFirst();
    return Number(res?.numDeletedRows ?? 0);
  }

  /** Housekeeping. Expired rows are already refused by findActive; this just reclaims space. */
  static async deleteExpired(): Promise<number> {
    const db = await this.getKyselyDB();
    const res = await db
      .deleteFrom("auth_session")
      .where(sql<boolean>`expires_at < now()`)
      .executeTakeFirst();
    return Number(res?.numDeletedRows ?? 0);
  }
}
