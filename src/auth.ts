import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { User } from "@/models";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: "Admin" | "Operations" | "Location" | "Enrollment" | "Trainer";
  location_scope: string[];
  can_edit: boolean;
};

// NOTE: no `basePath` override here — Next strips the app basePath before the
// route handler runs, so Auth.js sees /api/auth/* (its default). The CLIENT side
// does need the prefix (SessionProvider basePath in components/providers.tsx).
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const email = String(credentials?.email || "").toLowerCase();
        const password = String(credentials?.password || "");
        if (!email || !password) return null;
        await dbConnect();
        const user = await User.findOne({ email }).lean<any>();
        if (!user) return null;
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return null;
        // 2026-08-11 (CEO): self-signups wait for Admin approval; deactivated users stay out.
        // Password is checked FIRST so this message never leaks account state to guessers.
        if (user.approval_status === "Pending") throw new Error("Your account is awaiting Admin approval.");
        if (user.approval_status === "Rejected" || !user.active) throw new Error("This account is not active. Contact an Admin.");
        return {
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          location_scope: (user.location_scope || []).map(String),
          can_edit: !!user.can_edit,
        } as any;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const u = user as unknown as SessionUser;
        token.id = u.id;
        token.role = u.role;
        token.location_scope = u.location_scope;
        token.can_edit = u.can_edit;
      }
      return token;
    },
    session({ session, token }) {
      (session.user as unknown as SessionUser).id = token.id as string;
      (session.user as unknown as SessionUser).role = token.role as SessionUser["role"];
      (session.user as unknown as SessionUser).location_scope = (token.location_scope as string[]) || [];
      (session.user as unknown as SessionUser).can_edit = !!token.can_edit;
      return session;
    },
  },
});
