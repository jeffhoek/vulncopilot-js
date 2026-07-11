import { config } from "@/src/lib/config";
import { getDocumentCount } from "@/src/lib/db";
import { auth, signOut } from "@/auth";
import { Chat } from "./chat";
import { SignIn } from "./signin";

// Server component: gate on the session first (Phase 3). Signed-out or denied
// users get the sign-in view; authenticated users get the chat, with the doc
// count and server-side config read once and handed to the client <Chat>.
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  // Next 15: searchParams is async. Carries NextAuth's `?error=…` on denial.
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.userId) {
    const { error } = await searchParams;
    return <SignIn error={error} />;
  }

  let documentCount: number | null = null;
  try {
    documentCount = await getDocumentCount();
  } catch (err) {
    // A DB hiccup shouldn't blank the page — just drop the count from the banner.
    console.error("Failed to load document count", err);
  }

  return (
    <Chat
      documentCount={documentCount}
      actionButtons={config.ACTION_BUTTONS}
      maxHistoryMessages={config.MAX_HISTORY_MESSAGES}
      user={session.user?.name ?? session.userId}
      signOutAction={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    />
  );
}
