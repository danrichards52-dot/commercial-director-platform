import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Commercial Director",
  description: "An explained verdict on whether the business is on target.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
