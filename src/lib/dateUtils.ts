/**
 * Safely converts any Firestore timestamp, JS Date, ISO string, or number to milliseconds.
 */
export function getMillisFromTimestamp(ts: any): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') {
    try {
      return ts.toMillis();
    } catch {
      // fallback
    }
  }
  if (typeof ts.toDate === 'function') {
    try {
      return ts.toDate().getTime();
    } catch {
      // fallback
    }
  }
  if (typeof ts.seconds === 'number') {
    return ts.seconds * 1000 + (ts.nanoseconds ? Math.floor(ts.nanoseconds / 1000000) : 0);
  }
  if (typeof ts._seconds === 'number') {
    return ts._seconds * 1000;
  }
  if (ts instanceof Date) {
    return ts.getTime();
  }
  if (typeof ts === 'number') {
    return ts;
  }
  if (typeof ts === 'string') {
    const parsed = new Date(ts).getTime();
    if (!isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * Formats a message timestamp into a 12-hour time string (e.g. "10:24 AM").
 * Safely defaults to "Just now" if pending serverTimestamp or invalid date.
 */
export function formatMessageTime(ts: any): string {
  const ms = getMillisFromTimestamp(ts);
  if (!ms || isNaN(ms)) {
    return 'Just now';
  }
  const date = new Date(ms);
  if (isNaN(date.getTime())) {
    return 'Just now';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Formats chat room updatedAt timestamp into date/time string (e.g. "10:24 AM" or "Jul 26").
 */
export function formatChatDate(ts: any): string {
  const ms = getMillisFromTimestamp(ts);
  if (!ms || isNaN(ms)) return '';
  const date = new Date(ms);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Formats relative "Last seen" duration (e.g. "Just now", "5m ago", "2h ago").
 */
export function formatRelativeTime(ts: any): string {
  const ms = getMillisFromTimestamp(ts);
  if (!ms || isNaN(ms)) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 0) return 'Just now';
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
