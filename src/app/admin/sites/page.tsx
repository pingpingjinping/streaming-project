import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import SitesManager from "./SitesManager";

export const dynamic = "force-dynamic";

export default async function AdminSitesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.isAdmin) redirect("/");
  return <SitesManager />;
}
