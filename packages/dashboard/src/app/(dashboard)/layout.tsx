import { Sidebar } from '@/components/sidebar';
import { Header } from '@/components/header';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm';
import { WorkspaceProvider } from '@/lib/workspace-context';

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <WorkspaceProvider>
          <div className="flex h-full min-h-screen">
            <Sidebar />
            <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
              <Header />
              <main className="flex-1 overflow-auto p-6 md:p-8">{children}</main>
            </div>
          </div>
        </WorkspaceProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
