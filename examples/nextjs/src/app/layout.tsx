import type { ReactNode } from "react";
import "@workflow/frontend/styles.css";

export const metadata = {
  title: "Workflow Next.js Example",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
