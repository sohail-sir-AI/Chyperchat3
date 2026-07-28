import { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  createdAt: Timestamp;
  lastSeen: Timestamp;
  status: 'online' | 'offline' | 'away';
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderPhoto: string;
  timestamp: any;
  isEncrypted: boolean;
  ciphertext: string;
  iv: string;
  salt: string;
  previewText: string;
  readBy: string[];
  isRead: boolean;
  replyToId?: string;
  replyToSenderName?: string;
  replyToText?: string;
}

export interface ChatRoom {
  id: string;
  participantIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  type: 'direct' | 'group';
  name?: string;
  lastMessage?: {
    text: string;
    senderId: string;
    timestamp: Timestamp;
  };
  isTyping?: Record<string, boolean>;
}  id: string;
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
