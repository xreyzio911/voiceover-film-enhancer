import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedEmail } from "@/lib/authAllowlist";

export const authOptions: NextAuthOptions = {
  secret: process.env.AUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async signIn({ user, profile }) {
      const profileEmail =
        typeof profile === "object" && profile && "email" in profile
          ? String(profile.email ?? "")
          : "";
      const email = (user.email ?? profileEmail).toLowerCase();
      return isAllowedEmail(email);
    },
    async jwt({ token }) {
      if (typeof token.email === "string") {
        token.email = token.email.toLowerCase();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.email === "string") {
        session.user.email = token.email.toLowerCase();
      }
      return session;
    },
  },
};

export const getServerAuthSession = () => getServerSession(authOptions);
