import "./globals.css";
import AppHeader from "./components/app-header";

export const metadata = {
  title: "Options Log",
  description: "Minimal options trading journal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <AppHeader />

          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
