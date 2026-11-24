import "./globals.css";
export const metadata = {
  title: "모아담 · 기숙사 공동구매",
  description: "같은 기숙사에서 생필품을 필요한 만큼 나눠요.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
