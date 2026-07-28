// File Path: src/types.ts

export type UserStatus = 'online' | 'busy' | 'offline';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  status: UserStatus;
  statusMessage?: string;
  lastSeen: any; // Timestamp
  publicKey?: string;
  isEphemeralKey?: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  ciphertext: string;
  iv: string;
  mac: string;
  timestamp: any;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
  };
  imageURL?: string;
  ephemeralHours?: number; // Self-destruct timer in hours
  expiresAt?: any; // Timestamp
  readBy?: string[]; // Array of UIDs who have read the message
}

export interface ChatRoom {
  id: string;
  type: 'direct' | 'group';
  name?: string;
  participants: string[];
  createdById: string;
  createdAt: any;
  updatedAt?: any;
  lastMessage?: {
    text: string;
    senderId: string;
    timestamp: any;
  };
  typing?: Record<string, boolean>; // uid -> boolean
}  name?: string;
  lastMessage?: {
    text: string;
    senderId: string;
    timestamp: Timestamp;
  };
  isTyping?: Record<string, boolean>;
}
