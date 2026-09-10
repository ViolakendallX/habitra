import { type CSSProperties } from 'react';

export interface DayTally {
  day: string;
  completed: number;
  missed: number;
  total: number;
}

interface WeekHeatmapProps {
  week: string[];
  dayTally: DayTally[];
  selectedDay: string;
  today: string;
  /** YYYY-MM-DD -> { weekday, day, month } for the cell caption. */
  dayParts: (dayKey: string) => { weekday: string; day: number; month: string };
  onSelectDay: (day: string) => void;
}

/**
 * Habit consistency heatmap for the current week.
 *
 * This is the Dashboard's take on the reference screens' weekly-engagement grid.
 * It renders the SAME `.weekstrip__day` elements the old week selector used (so
 * the UI test's `.weekstrip__day` / `--today` / `--selected` assertions still
 * hold) but repaints each cell as a heat square. The fill intensity is derived
 * purely from `weekStatus` (completions ÷ habits) — no new endpoint, no invented
 * data. Days with no habits configured render as a neutral "no data" square.
 */

/**
 * Lavender intensity scale, mirroring --habitra-accent for the dark canvas.
 * Capped to a translucent maximum (never solid) so the white day text stays
 * readable on every cell — a solid lavender fill would drop the text contrast
 * below WCAG AA.
 */
function heatColor(completed: number, total: number): string {
  if (total === 0) return 'rgba(255, 255, 255, 0.05)';
  const ratio = completed / total;
  if (ratio <= 0) return 'rgba(167, 139, 250, 0.18)';
  if (ratio <= 0.34) return 'rgba(167, 139, 250, 0.30)';
  if (ratio <= 0.67) return 'rgba(167, 139, 250, 0.42)';
  if (ratio < 1) return 'rgba(167, 139, 250, 0.5)';
  return 'rgba(167, 139, 250, 0.5)';
}

export default function WeekHeatmap({
  week,
  dayTally,
  selectedDay,
  today,
  dayParts,
  onSelectDay,
}: WeekHeatmapProps) {
  const tallyByDay = new Map(dayTally.map((item) => [item.day, item]));

  return (
    <div className="weekstrip" role="group" aria-label="Select a day this week">
      {week.map((day) => {
        const parts = dayParts(day);
        const tally = tallyByDay.get(day);
        const completed = tally?.completed ?? 0;
        const total = tally?.total ?? 0;

        const classes = ['weekstrip__day'];
        if (day === today) classes.push('weekstrip__day--today');
        if (day === selectedDay) classes.push('weekstrip__day--selected');

        const style: CSSProperties = { backgroundColor: heatColor(completed, total) };

        return (
          <button
            key={day}
            type="button"
            className={classes.join(' ')}
            style={style}
            onClick={() => onSelectDay(day)}
            aria-pressed={day === selectedDay}
          >
            <span className="weekstrip__weekday">{parts.weekday}</span>
            <span className="weekstrip__date">{parts.day}</span>
            <span className="weekstrip__tally">
              {total === 0 ? '—' : `${completed}/${total}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
