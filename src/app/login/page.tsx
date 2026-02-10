import LoginCard from "@/components/LoginCard";
import { getServerAuthSession } from "@/auth";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { redirect } from "next/navigation";
import styles from "./page.module.css";

export default async function LoginPage() {
  const session = await getServerAuthSession();
  const email = session?.user?.email?.toLowerCase();

  if (isAllowedEmail(email)) {
    redirect("/");
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <LoginCard />
      </div>
    </div>
  );
}
