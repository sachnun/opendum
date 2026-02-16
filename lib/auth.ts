import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";

const isDevelopment = process.env.NODE_ENV === "development";
const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

const providers = [
  ...(githubClientId && githubClientSecret
    ? [
        GitHub({
          clientId: githubClientId,
          clientSecret: githubClientSecret,
          allowDangerousEmailAccountLinking: true,
        }),
      ]
    : []),
  ...(googleClientId && googleClientSecret
    ? [
        Google({
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          allowDangerousEmailAccountLinking: true,
        }),
      ]
    : []),
  ...(isDevelopment
    ? [
        Credentials({
          name: "Local Development",
          credentials: {},
          async authorize() {
            const email = "dev@localhost";
            const user = await prisma.user.upsert({
              where: { email },
              update: {
                name: "Local Dev",
                emailVerified: new Date(),
              },
              create: {
                email,
                name: "Local Dev",
                emailVerified: new Date(),
              },
            });

            return {
              id: user.id,
              email: user.email ?? email,
              name: user.name,
              image: user.image,
            };
          },
        }),
      ]
    : []),
];

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers,
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
});
