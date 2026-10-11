import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Navbar from "@/components/Navbar";
import WorkAuditPanel from "./WorkAuditPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Work 검수 자료 - Anihub" };

export default async function WorkAuditPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.isAdmin) redirect("/");
  return <><Navbar /><WorkAuditPanel /></>;
}
