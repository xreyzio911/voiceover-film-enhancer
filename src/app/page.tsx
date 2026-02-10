import VoLeveler from "@/components/VoLeveler";
import SignOutButton from "@/components/SignOutButton";
import { getServerAuthSession } from "@/auth";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { redirect } from "next/navigation";
import styles from "./page.module.css";

export default async function Home() {
  const session = await getServerAuthSession();
  const email = session?.user?.email?.toLowerCase();

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
          <h1 className={styles.title}>VO Batch Leveler</h1>
          <p className={styles.subtitle}>
            Film-grade VO leveling with adaptive tone matching and broadcast loudness targets.
            Runs entirely in the browser so the internal team can process files without uploading
            to a server.
          </p>
          <div className={styles.badges}>
            <span className={styles.badge}>48 kHz / 32-bit float</span>
            <span className={styles.badge}>ATSC A/85 + EBU R128</span>
            <span className={styles.badge}>Gentle leveler presets</span>
          </div>
        </header>
        <VoLeveler />
      </div>
    </div>
  );
}
