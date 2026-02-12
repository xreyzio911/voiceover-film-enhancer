import Link from "next/link";
import { headers } from "next/headers";
import VoLeveler from "@/components/VoLeveler";
import SignOutButton from "@/components/SignOutButton";
import { getServerAuthSession } from "@/auth";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { isLocalHost } from "@/lib/isLocalHost";
import { redirect } from "next/navigation";
import styles from "./page.module.css";

export default async function Home() {
  const session = await getServerAuthSession();
  const email = session?.user?.email?.toLowerCase();
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const localMode = isLocalHost(host);

  if (!isAllowedEmail(email)) {
    redirect("/login");
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
          <div className={styles.heroTop}>
            <div className={styles.account}>{email}</div>
            <SignOutButton className={styles.logoutButton} />
          </div>
          <h1 className={styles.title}>Shorts Projektt Internal VO Optimizer</h1>
          <p className={styles.subtitle}>Internal tool for VO leveling and delivery exports.</p>
          <div className={styles.badges}>
            <span className={styles.badge}>48 kHz / 32-bit float</span>
            <span className={styles.badge}>ATSC A/85 + EBU R128</span>
            <span className={styles.badge}>Batch processing</span>
            {localMode && (
              <Link href="/qc-lab" className={`${styles.badge} ${styles.badgeAction}`}>
                Analyze + QC Lab
              </Link>
            )}
          </div>
        </header>
        <VoLeveler />
      </div>
    </div>
  );
}
