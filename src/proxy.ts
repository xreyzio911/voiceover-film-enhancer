import { NextResponse } from "next/server";
import { withAuth } from "next-auth/middleware";
import { isAllowedEmail } from "@/lib/authAllowlist";

const LOGIN_PATH = "/login";

export default withAuth(
  (request) => {
    const { nextUrl } = request;
    const path = nextUrl.pathname;
    const email =
      typeof request.nextauth.token?.email === "string"
        ? request.nextauth.token.email.toLowerCase()
        : undefined;
    const allowed = isAllowedEmail(email);

    if (path === LOGIN_PATH) {
      if (allowed) {
        return NextResponse.redirect(new URL("/", nextUrl));
      }
      return NextResponse.next();
    }

    if (!allowed) {
      const loginUrl = new URL(LOGIN_PATH, nextUrl);
      loginUrl.searchParams.set("callbackUrl", `${path}${nextUrl.search}`);
      loginUrl.searchParams.set("error", email ? "AccessDenied" : "SigninRequired");
      return NextResponse.redirect(loginUrl);
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: () => true,
    },
    pages: {
      signIn: LOGIN_PATH,
    },
  }
);

export const config = {
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|ffmpeg/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
