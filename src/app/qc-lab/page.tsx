import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerAuthSession } from "@/auth";
import SignOutButton from "@/components/SignOutButton";
import QcReportLab from "@/components/QcReportLab";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { isLocalHost } from "@/lib/isLocalHost";
import styles from "./page.module.css";

export default async function QcLabPage() {
  const session = await getServerAuthSession();
  const email = session?.user?.email?.toLowerCase();

  if (!isAllowedEmail(email)) {
    redirect("/login");
  }

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  if (!isLocalHost(host)) {
    notFound();
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
          <div className={styles.heroTop}>
            <div className={styles.accountRow}>
              <div className={styles.account}>{email}</div>
              <span className={styles.localBadge}>Local only</span>
            </div>
            <div className={styles.navActions}>
              <Link href="/" className={styles.backLink}>
                Back to Optimizer
              </Link>
              <SignOutButton className={styles.logoutButton} />
            </div>
          </div>
          <h1 className={styles.title}>Analyze + QC Report Lab</h1>
          <p className={styles.subtitle}>
            Offline diagnostics workspace for VO quality checks before production processing.
          </p>
        </header>

        <QcReportLab />
      </div>
    </div>
  );
}

