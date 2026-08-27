import "dotenv/config";

// Auth.js reads this at import time; the unit tests never sign anything, but
// importing lib/auth.ts would warn without it.
process.env.AUTH_SECRET ??= "test-secret-not-used-for-signing";
