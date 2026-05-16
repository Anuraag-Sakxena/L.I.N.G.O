import type { Metadata, Viewport } from "next";

import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import Splash from "@/components/Splash";

import "./globals.css";

export const metadata: Metadata = {
  title: "LINGO",
  description:
    "Language I'll Never Genuinely Obtain — Real-time Assamese to English translation",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "LINGO",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }],
    apple: "/icons/icon-192.png",
    shortcut: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0A0F1C",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="bg-bg-deep text-text-primary antialiased min-h-screen overflow-hidden font-sans">
        <Splash />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
