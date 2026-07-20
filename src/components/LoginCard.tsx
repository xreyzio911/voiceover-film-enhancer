"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
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
  const [signingIn, setSigningIn] = useState(false);
  const error = searchParams.get("error");
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const errorText = getErrorText(error);

  return (
    <div className={styles.card}>
      <div className={styles.brandLockup}>
        <span className={styles.brandMark} aria-hidden="true">SP</span>
        <div>
          <div className={styles.brand}>Shorts Projektt</div>
          <div className={styles.brandContext}>Voiceover production</div>
        </div>
      </div>
      <div className={styles.copy}>
        <h1 className={styles.title}>Sign in to production</h1>
        <p className={styles.subtitle}>
          Continue with an approved Google account to access the internal audio workspace.
        </p>
      </div>
      {errorText && <div className={styles.error} role="alert">{errorText}</div>}
      <button
        type="button"
        className={styles.button}
        disabled={signingIn}
        onClick={() => {
          setSigningIn(true);
          void signIn("google", { callbackUrl });
        }}
      >
        {signingIn ? "Opening Google sign-in" : "Continue with Google"}
      </button>
      <p className={styles.hint}>Access is restricted to approved accounts.</p>
    </div>
  );
}
