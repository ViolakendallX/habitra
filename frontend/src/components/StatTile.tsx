interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  /** Tints the numeric value with the accent color (e.g. the headline metric). */
  accent?: boolean;
}

/**
 * A single dashboard stat tile — large tabular numeral + small label + caption.
 *
 * Purely presentational. It renders no data and makes no API calls; the value
 * is always passed in from Dashboard, which derives it from the existing
 * analytics payload. `font-variant-numeric: tabular-nums` keeps the figures
 * aligned like the reference dashboards.
 */
export default function StatTile({ label, value, sub, accent }: StatTileProps) {
  return (
    <div className={accent ? 'stat-tile stat-tile--accent' : 'stat-tile'}>
      <p className="stat-tile__label">{label}</p>
      <p className="stat-tile__value">{value}</p>
      {sub && <p className="stat-tile__sub">{sub}</p>}
    </div>
  );
}
