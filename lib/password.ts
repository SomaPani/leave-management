import bcrypt from "bcryptjs";

/**
 * Password hashing.
 *
 * `bcryptjs` rather than the native `bcrypt` binding: same algorithm and hash
 * format, but pure JavaScript, so there's no node-gyp build step on Windows and
 * no rebuild when the Node version changes.
 */

const ROUNDS = 12;

/** The shortest password creation endpoints will accept. */
export const MIN_PASSWORD_LENGTH = 8;

export function isAcceptablePassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

export async function hashPassword(password: string): Promise<string> {
  if (!isAcceptablePassword(password)) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  // bcrypt.compare rejects on a malformed hash; a bad stored hash should read
  // as "wrong password", not as a 500.
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}
