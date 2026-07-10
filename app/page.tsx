import { config } from "@/src/lib/config";
import { getDocumentCount } from "@/src/lib/db";
import { Chat } from "./chat";

// Server component: reads the doc count and server-side config once, then hands
// them to the client <Chat>. Keeps config (incl. MAX_HISTORY_MESSAGES) server-only.
export const dynamic = "force-dynamic";

export default async function Home() {
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
    />
  );
}
