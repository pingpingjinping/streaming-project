import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, initDb } from "@/lib/db";
import { checkAndPromoteNewEpisodes } from "@/lib/historyPromotion";

// Called after the saved history has rendered. Keep the work attached to this
// request so it also completes on hosts that stop work after a response ends.
export async function POST() {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (!getDb()) return NextResponse.json({ success: false }, { status: 503 });
  try {
    await initDb();
    const changed = await checkAndPromoteNewEpisodes(user.username);
    return NextResponse.json({ success: true, changed }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[History refresh error]:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
