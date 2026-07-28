import React from 'react';
import { UserProfile } from '../types';

interface PresenceStatusProps {
  user: UserProfile;
  showText?: boolean;
  showDetails?: boolean;
  className?: string;
}

export const PresenceStatus: React.FC<PresenceStatusProps> = ({
  user,
  showText = false,
  showDetails = false,
  className = ''
}) => {
  const isOnline = user.status === 'online';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative">
        <img
          src={user.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.uid}`}
          alt={user.displayName}
          className="w-8 h-8 rounded-full bg-slate-800 object-cover border border-slate-700"
        />
        <span
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${
            isOnline ? 'bg-emerald-500' : 'bg-slate-500'
          }`}
        />
      </div>
      {showDetails && (
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-200 truncate">{user.displayName}</p>
          <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
        </div>
      )}
      {showText && !showDetails && (
        <span className="text-xs text-slate-400 capitalize">{user.status}</span>
      )}
    </div>
  );
};        />
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
