import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Navbar from "@/components/Navbar";
import SubtitleLinkManager from "./SubtitleLinkManager";

export const dynamic = "force-dynamic";
export const metadata = { title: "자막 DB 직접 연결 - Anihub" };

export default async function AdminSubtitleLinksPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.isAdmin) redirect("/");
  return <><Navbar/><SubtitleLinkManager/></>;
}
