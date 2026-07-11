import { handlers } from "@/auth";

// NextAuth touches Node APIs (crypto, the GitHub provider); pin the Node runtime.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
