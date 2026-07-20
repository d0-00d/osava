import type { ReactNode } from "react";

/** Small chevron used in the "EYEBROW › STATUS" header line. */
export function Chevron() {
  return (
    <svg
      width={4.317}
      height={7}
      viewBox="0 0 4.317 7"
      fill="none"
      className="osv-chevron"
      aria-hidden="true"
    >
      <path
        d="M 2.683 3.5 L 0 0.817 L 0.817 0 L 4.317 3.5 L 0.817 7 L 0 6.183 Z"
        fill="currentColor"
      />
    </svg>
  );
}

type HeaderProps = {
  eyebrow: string;
  status?: string;
  title: string;
  subtitle?: string;
};

/** Standard tab header: mono eyebrow (+ teal status), Pixelify title, subtitle. */
export function OsavaHeader({ eyebrow, status, title, subtitle }: HeaderProps) {
  return (
    <header className="osv-header">
      <div className="osv-eyebrow">
        <span>{eyebrow}</span>
        {status && (
          <>
            <Chevron />
            <span className="osv-eyebrow-status">{status}</span>
          </>
        )}
      </div>
      <h1 className="osv-title">{title}</h1>
      {subtitle && <p className="osv-subtitle">{subtitle}</p>}
    </header>
  );
}

type Tone = "ok" | "bad" | "warn" | "neutral";

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`osv-pill osv-pill--${tone}`}>{children}</span>;
}
