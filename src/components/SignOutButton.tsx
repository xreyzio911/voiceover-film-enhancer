"use client";

import { signOut } from "next-auth/react";

type SignOutButtonProps = {
  className?: string;
};

export default function SignOutButton({ className }: SignOutButtonProps) {
  return (
    <button
      className={className}
      type="button"
      onClick={() => {
        void signOut({ callbackUrl: "/login" });
      }}
    >
      Sign out
    </button>
  );
}
