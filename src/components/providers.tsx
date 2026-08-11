"use client";
import { SessionProvider } from "next-auth/react";
import { BASE_PATH } from "@/lib/base-path";

// Root-level provider so both the app shell AND the login page get the correct
// auth basePath (client-side signIn/signOut post to `${BASE_PATH}/api/auth/*`).
export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider basePath={`${BASE_PATH}/api/auth`}>{children}</SessionProvider>;
}
