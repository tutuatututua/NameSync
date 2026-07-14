import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import type { AppUser } from "../db.types";

/**
 * `app_user` — who can sign in.
 *
 * Email is matched case-insensitively (the unique index is on lower(email)), so the
 * lookup here must be too; matching on the raw column would let Ann@x.com fail to find
 * the row stored as ann@x.com.
 *
 * Nothing in here checks a password — that is auth.service's job, and it must go through
 * lib/password.ts so the comparison stays timing-safe.
 */
export class UserModel extends DBModel {
  static async findByEmail(email: string): Promise<AppUser | undefined> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("app_user")
      .selectAll()
      .where(sql<boolean>`lower(email) = lower(${email})`)
      .executeTakeFirst() as Promise<AppUser | undefined>;
  }

  static async findById(id: string): Promise<AppUser | undefined> {
    if (!/^\d+$/.test(id)) return undefined; // bigint PK: a non-numeric id can never match
    const db = await this.getKyselyDB();
    return db
      .selectFrom("app_user")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst() as Promise<AppUser | undefined>;
  }

  /** `passwordHash` must already be hashed (lib/password.ts) — this never sees a plaintext. */
  static async create(input: {
    email: string;
    passwordHash: string;
    name?: string | null;
    roles?: string[];
  }): Promise<AppUser> {
    const db = await this.getKyselyDB();
    const row = await db
      .insertInto("app_user")
      .values({
        email: input.email.trim(),
        password_hash: input.passwordHash,
        name: input.name?.trim() || null,
        roles: input.roles ?? [],
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as AppUser;
  }

  static async countAll(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("app_user")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  static async touchLastLogin(id: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db
      .updateTable("app_user")
      .set({ last_login_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", id)
      .execute();
  }

  static async setPassword(id: string, passwordHash: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db
      .updateTable("app_user")
      .set({ password_hash: passwordHash, updated_at: sql`now()` })
      .where("id", "=", id)
      .execute();
  }
}
