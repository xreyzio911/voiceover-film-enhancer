import VoLeveler from "@/components/VoLeveler";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
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
