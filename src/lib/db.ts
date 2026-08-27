import mongoose from "mongoose";

const MONGODB_URL = process.env.MONGODB_URL!;
const MONGODB_DB = process.env.MONGODB_DB || "center_erp";

declare global {
  // eslint-disable-next-line no-var
  var _mongoose: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } | undefined;
}

const cached = global._mongoose ?? (global._mongoose = { conn: null, promise: null });

export async function dbConnect() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    // QA-899: a rejected connect promise used to stay cached forever - the NEXT request awaited
    // the SAME rejected promise instead of trying a fresh connect, so one transient Mongo blip at
    // startup permanently killed every DB-backed request until the process was restarted by hand,
    // while /api/public/version (which never touches Mongo) kept reporting 200. Clearing the cache
    // on rejection lets the next call retry instead of replaying the same failure forever.
    cached.promise = mongoose.connect(MONGODB_URL, {
      dbName: MONGODB_DB,
      serverSelectionTimeoutMS: 10000,
    }).catch((err) => {
      cached.promise = null;
      throw err;
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
