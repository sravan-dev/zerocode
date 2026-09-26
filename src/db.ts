import { Collection, Db, MongoClient, ObjectId } from 'mongodb';

export type Role = 'admin' | 'user';
export type UserStatus = 'active' | 'blocked';

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash?: string;
  googleSub?: string;
  /** True once ownership of the email is proven (Google sign-in) or an admin created the account. */
  emailVerified?: boolean;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface SessionDoc {
  _id: ObjectId;
  tokenHash: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

/** One chat as the web app stores it; `data` is the app's chat object, opaque to the server. */
export interface ChatDoc {
  _id: ObjectId;
  userId: ObjectId;
  chatId: string;
  title: string;
  updated: number;
  data: unknown;
}

let client: MongoClient | null = null;
let db: Db | null = null;

/** Accounts, sessions and server-side chat history need MongoDB; without MONGODB_URI the app runs single-user. */
export function dbEnabled(): boolean {
  return !!process.env.MONGODB_URI?.trim();
}

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  await Promise.all([
    users().createIndex({ email: 1 }, { unique: true }),
    users().createIndex({ googleSub: 1 }, { unique: true, sparse: true }),
    sessions().createIndex({ tokenHash: 1 }, { unique: true }),
    sessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    chats().createIndex({ userId: 1, chatId: 1 }, { unique: true }),
    chats().createIndex({ userId: 1, updated: -1 })
  ]);
}

function requireDb(): Db {
  if (!db) throw new Error('Database not connected');
  return db;
}

export const users = (): Collection<UserDoc> => requireDb().collection<UserDoc>('users');
export const sessions = (): Collection<SessionDoc> => requireDb().collection<SessionDoc>('sessions');
export const chats = (): Collection<ChatDoc> => requireDb().collection<ChatDoc>('chats');

export async function closeDb(): Promise<void> {
  await client?.close().catch(() => { });
}
