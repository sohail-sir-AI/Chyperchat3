import React from 'react';
import { UserProfile } from '../types';

interface PresenceStatusProps {
  user: UserProfile;
  className?: string;
  showDetails?: boolean;
}

export default function PresenceStatus({ user, className = '', showDetails = false }: PresenceStatusProps) {
  // Determine online status based on status field AND a 2-minute heartbeat margin of safety
  const isHeartbeatOnline = () => {
    if (user.status !== 'online') return false;
    const now = Date.now();
    const lastSeenMs = user.lastSeen?.toMillis() || 0;
    // 2 minutes = 120,000 milliseconds
    return now - lastSeenMs < 120000;
  };

  const online = isHeartbeatOnline();

  const getRelativeTime = () => {
    if (!user.lastSeen) return 'Never';
    const lastSeenMs = user.lastSeen.toMillis();
    const diff = Date.now() - lastSeenMs;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative">
        <img
          src={user.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user.displayName)}`}
          alt={user.displayName}
          className="w-10 h-10 rounded-full bg-slate-700 border border-slate-700 object-cover"
          referrerPolicy="no-referrer"
        />
        <span
          className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-slate-900 ${
            online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'
          }`}
          title={online ? 'Online' : 'Offline'}
        />
      </div>
      {showDetails && (
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-slate-100 truncate">
            {user.displayName}
          </span>
          <span className="text-xs text-slate-400 truncate">
            {online ? (
              <span className="text-emerald-400 font-medium">Online</span>
            ) : (
              `Last seen: ${getRelativeTime()}`
            )}
          </span>
        </div>
      )}
    </div>
  );
}

