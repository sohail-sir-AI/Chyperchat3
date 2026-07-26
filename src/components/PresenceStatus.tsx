import React from 'react';
import { UserProfile } from '../types';
import { getMillisFromTimestamp, formatRelativeTime } from '../lib/dateUtils';

interface PresenceStatusProps {
  user: UserProfile;
  showText?: boolean;
  className?: string;
}

export default function PresenceStatus({ user, showText = false, className = '' }: PresenceStatusProps) {
  if (!user) return null;

  const isHeartbeatOnline = () => {
    if (user.status !== 'online') return false;
    const now = Date.now();
    const lastSeenMs = getMillisFromTimestamp(user.lastSeen);
    if (!lastSeenMs) return false;
    // 2 minutes = 120,000 milliseconds
    return now - lastSeenMs < 120000;
  };

  const online = isHeartbeatOnline();

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative">
        <img
          src={user.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.uid}`}
          alt={user.displayName}
          className="w-8 h-8 rounded-full border border-slate-700 bg-slate-800 object-cover"
        />
        <span
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${
            online ? 'bg-emerald-500' : 'bg-slate-500'
          }`}
        />
      </div>

      {showText && (
        <div className="flex flex-col">
          <span className="text-xs font-semibold text-slate-200">{user.displayName}</span>
          <span className="text-[10px] text-slate-400">
            {online ? (
              <span className="text-emerald-400 font-medium">Online</span>
            ) : (
              `Last seen: ${formatRelativeTime(user.lastSeen)}`
            )}
          </span>
        </div>
      )}
    </div>
  );
}
