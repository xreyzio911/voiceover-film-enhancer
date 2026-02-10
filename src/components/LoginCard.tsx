"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import styles from "./LoginCard.module.css";

const getErrorText = (error: string | null) => {
  if (error === "AccessDenied") {
    return "This Google account is not allowed to access this app.";
  }
  if (error === "Configuration") {
    return "Google login is not configured yet. Please check app environment variables.";
  }
  if (error === "SigninRequired") {
    return "Please sign in with an approved Google account.";
  }
  if (error === "OAuthAccountNotLinked") {
    return "This account is not linked for access.";
  }
  if (error) {
    return "Login failed. Please try again.";
  }
  return null;
};

export default function LoginCard() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const errorText = getErrorText(error);

  return (
    <div className={styles.card}>
      <div className={styles.brand}>VO Batch Leveler</div>
      <h1 className={styles.title}>Google Sign In</h1>
      <p className={styles.subtitle}>
        Continue with an approved Google account to access internal voice-over processing.
      </p>
      {errorText && <div className={styles.error}>{errorText}</div>}
      <button
        className={styles.button}
        onClick={() => {
          void signIn("google", { callbackUrl });
        }}
      >
        Continue with Google
      </button>
      <p className={styles.hint}>Allowed accounts are restricted by app policy.</p>
    </div>
  );
}
