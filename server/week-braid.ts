import { DateTime } from "luxon";
import { db } from "./db";

export interface WeekBraidDay {
  date: string;
  label: string;
  completed: number;
  total: number;
  percentage: number | null;
}

export function collectWeekBraid(circleId: number, now = new Date()): WeekBraidDay[] {
  const circle = db.prepare("SELECT timezone FROM circles WHERE id = ?").get(circleId) as { timezone: string } | undefined;
  if (!circle) throw new Error("Cannot prepare a week braid for an unknown circle.");
  const today = DateTime.fromJSDate(now, { zone: "utc" }).setZone(circle.timezone).startOf("day");
  const dates = Array.from({ length: 7 }, (_, index) => today.minus({ days: 6 - index }));
  const rows = db.prepare(`
    SELECT scheduled_at, status FROM dose_events
    WHERE circle_id = ? AND scheduled_at >= ? AND scheduled_at <= ?
  `).all(circleId, dates[0].toUTC().toISO(), today.endOf("day").toUTC().toISO()) as { scheduled_at: string; status: string }[];
  const daily = new Map<string, { completed: number; total: number }>();
  for (const row of rows) {
    const date = DateTime.fromISO(row.scheduled_at, { zone: "utc" }).setZone(circle.timezone).toFormat("yyyy-LL-dd");
    const counts = daily.get(date) ?? { completed: 0, total: 0 };
    counts.total++;
    if (row.status === "taken" || row.status === "late") counts.completed++;
    daily.set(date, counts);
  }
  return dates.map((date) => {
    const key = date.toFormat("yyyy-LL-dd");
    const counts = daily.get(key) ?? { completed: 0, total: 0 };
    return {
      date: key,
      label: date.toFormat("ccc"),
      ...counts,
      percentage: counts.total ? Math.round((counts.completed / counts.total) * 100) : null,
    };
  });
}
