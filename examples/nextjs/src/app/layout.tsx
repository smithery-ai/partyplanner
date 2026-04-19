import type { ReactNode } from "react";

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
