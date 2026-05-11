export type SchedulableLink = {
  id?: string;
  actualAccountId?: string;
  syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
  syncHour: number | null;
  syncDayOfWeek: number | null;
  lastSyncedAt: Date | null;
  isEnabled: boolean;
};

function isSameCalendarDay(left: Date, right: Date) {
  return left.toDateString() === right.toDateString();
}

function nextDailyDueAt(now: Date, link: SchedulableLink) {
  const scheduledHour = link.syncHour ?? 0;
  const candidate = new Date(now);
  candidate.setHours(scheduledHour, 0, 0, 0);

  if (!link.lastSyncedAt) {
    return now >= candidate ? now : candidate;
  }

  if (isSameCalendarDay(now, link.lastSyncedAt)) {
    candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  return now >= candidate ? now : candidate;
}

function nextWeeklyDueAt(now: Date, link: SchedulableLink) {
  const scheduledHour = link.syncHour ?? 0;
  const scheduledDayOfWeek = link.syncDayOfWeek ?? 0;
  const candidate = new Date(now);
  candidate.setHours(scheduledHour, 0, 0, 0);

  const dayOffset = (scheduledDayOfWeek - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + dayOffset);

  if (dayOffset === 0 && now > candidate) {
    candidate.setDate(candidate.getDate() + 7);
  }

  if (!link.lastSyncedAt) {
    return dayOffset === 0 && now >= candidate ? now : candidate;
  }

  while (candidate.getTime() - link.lastSyncedAt.getTime() < 7 * 24 * 60 * 60 * 1000) {
    candidate.setDate(candidate.getDate() + 7);
  }

  return candidate;
}

export function isAccountLinkDue(now: Date, link: SchedulableLink) {
  if (!link.isEnabled || link.syncFrequency === "MANUAL") {
    return false;
  }

  if (!link.lastSyncedAt) {
    return true;
  }

  if (link.syncFrequency === "HOURLY") {
    return now.getTime() - link.lastSyncedAt.getTime() >= 60 * 60 * 1000;
  }

  if (link.syncFrequency === "DAILY") {
    const currentHour = now.getHours();
    return currentHour >= (link.syncHour ?? 0) && now.toDateString() !== link.lastSyncedAt.toDateString();
  }

  if (link.syncFrequency === "WEEKLY") {
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    const sameWeek =
      now.getFullYear() === link.lastSyncedAt.getFullYear() &&
      Math.abs(now.getTime() - link.lastSyncedAt.getTime()) < 7 * 24 * 60 * 60 * 1000;

    return currentDay === (link.syncDayOfWeek ?? 0) && currentHour >= (link.syncHour ?? 0) && !sameWeek;
  }

  return false;
}

export function getNextAccountLinkDueAt(now: Date, link: SchedulableLink) {
  if (!link.isEnabled || link.syncFrequency === "MANUAL") {
    return null;
  }

  if (isAccountLinkDue(now, link)) {
    return now;
  }

  if (!link.lastSyncedAt) {
    return now;
  }

  if (link.syncFrequency === "HOURLY") {
    return new Date(link.lastSyncedAt.getTime() + 60 * 60 * 1000);
  }

  if (link.syncFrequency === "DAILY") {
    return nextDailyDueAt(now, link);
  }

  if (link.syncFrequency === "WEEKLY") {
    return nextWeeklyDueAt(now, link);
  }

  return null;
}
