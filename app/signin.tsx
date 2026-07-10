import { signIn } from "@/auth";

// Signed-out / denied view. Rendered by page.tsx when there is no session.
// `error` comes from NextAuth's redirect (`?error=AccessDenied` on a denied
// allow-list decision). Server component; the button posts an inline server
// action that kicks off the GitHub OAuth flow.
export function SignIn({ error }: { error?: string }) {
  const denied = error === "AccessDenied";
  return (
    <div className="signin">
      <div className="signin-card">
        <h1>VulnCopilot</h1>
        <p className="tagline">CISA KEV / NIST NVD vulnerability assistant.</p>
        {denied && (
          <p className="signin-denied">
            Your GitHub account is not authorized for this app. Contact the
            administrator to request access.
          </p>
        )}
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button type="submit" className="signin-btn">
            Sign in with GitHub
          </button>
        </form>
      </div>
    </div>
  );
}
