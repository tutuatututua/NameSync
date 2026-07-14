import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { MainContainer } from "@/components/main-container";
import { AuthGuard } from "@/components/auth-guard";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // Everything in this group is behind a session. The guard only decides what to paint —
    // the API refuses every request without one regardless, which is the actual enforcement.
    <AuthGuard>
      <div className="flex min-h-screen bg-background">
        <AppSidebar />
        {/* min-w-0: without it this flex child refuses to shrink below the width of the
            Database console's table, and the whole page scrolls sideways instead of the grid. */}
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <TopBar />
          <MainContainer>{children}</MainContainer>
        </div>
      </div>
    </AuthGuard>
  );
}
