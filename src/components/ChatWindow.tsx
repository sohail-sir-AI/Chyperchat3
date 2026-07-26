import React, { useState, useEffect, useRef } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
  writeBatch,
  arrayUnion,
  Timestamp
} from 'firebase/firestore';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Send,
  Key,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  ArrowLeft,
  Check,
  CheckCheck,
  CornerUpLeft,
  X,
  Image as ImageIcon,
  Maximize2,
  Download,
  Loader2
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { encryptMessage, decryptMessage, EncryptedPayload } from '../lib/crypto';
import { processImageFile } from '../lib/imageUtils';
import { ChatRoom, ChatMessage, UserProfile } from '../types';
import PresenceStatus from './PresenceStatus';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: any;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock?: () => void;
  onBack?: () => void;
}

export default function ChatWindow({
  chat,
  currentUser,
  usersMap,
  onEmergencyLock,
  onBack
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [decryptionKey, setDecryptionKey] = useState('');
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Subscribe to messages
  useEffect(() => {
    const q = query(
      collection(db, 'chats', chat.id, 'messages'),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatMessage[];
        setMessages(msgs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, `chats/${chat.id}/messages`);
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !currentUser) return;

    setIsSending(true);
    try {
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;
      
      let payload: any = {
        id: messageId,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Anonymous',
        senderPhoto: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        text: messageText,
        isEncrypted: false,
        ciphertext: '',
        iv: '',
        salt: '',
        previewText: messageText.substring(0, 50)
      };

      if (isEncrypted && decryptionKey) {
        const encrypted = await encryptMessage(messageText, decryptionKey);
        payload.isEncrypted = true;
        payload.ciphertext = encrypted.ciphertext;
        payload.iv = encrypted.iv;
        payload.salt = encrypted.salt;
        payload.previewText = '🔒 Encrypted Message';
      }

      await setDoc(
        doc(db, 'chats', chat.id, 'messages', messageId),
        payload
      );

      // Update chat lastMessage
      await updateDoc(doc(db, 'chats', chat.id), {
        lastMessage: {
          text: payload.previewText,
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });

      setMessageText('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chat.id}/messages`);
    } finally {
      setIsSending(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;

    setIsSending(true);
    try {
      const imageDataUrl = await processImageFile(file);
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;

      await setDoc(
        doc(db, 'chats', chat.id, 'messages', messageId),
        {
          id: messageId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'Anonymous',
          senderPhoto: currentUser.photoURL || '',
          timestamp: serverTimestamp(),
          text: '📸 Image',
          type: 'image',
          fileUrl: imageDataUrl,
          isEncrypted: false,
          previewText: '📸 Image'
        }
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chat.id}/messages`);
    } finally {
      setIsSending(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Determine chat title
  const chatTitle = chat.type === 'direct'
    ? (() => {
        const recipientId = chat.participantIds.find(id => id !== currentUser?.uid);
        return recipientId ? usersMap[recipientId]?.displayName || 'Direct Chat' : 'Direct Chat';
      })()
    : chat.name || 'Group Chat';

  return (
    <div className="flex flex-col h-full bg-slate-950 border-l border-slate-900">
      {/* Header */}
      <div className="p-4 border-b border-slate-900 flex items-center justify-between bg-slate-900/50">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden p-2 rounded hover:bg-slate-800 text-slate-400"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div>
            <h2 className="font-semibold text-slate-100">{chatTitle}</h2>
            <p className="text-xs text-slate-500">
              {chat.type === 'direct' 
                ? 'Direct Encrypted Chat'
                : `${chat.participantIds.length} members`
              }
            </p>
          </div>
        </div>
        {onEmergencyLock && (
          <button
            onClick={onEmergencyLock}
            className="p-2 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-500"
            title="Emergency Lock"
          >
            <Lock className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center">
            <div className="text-slate-600">
              <ShieldCheck className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No messages yet</p>
              <p className="text-xs text-slate-700 mt-1">Start your encrypted conversation</p>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-2 ${msg.senderId === currentUser?.uid ? 'justify-end' : ''}`}
            >
              {msg.senderId !== currentUser?.uid && (
                <PresenceStatus user={usersMap[msg.senderId]} className="scale-75" />
              )}
              <div
                className={`max-w-xs px-4 py-2 rounded-lg ${
                  msg.senderId === currentUser?.uid
                    ? 'bg-amber-600 text-slate-950'
                    : 'bg-slate-800 text-slate-100'
                }`}
              >
                {msg.type === 'image' && msg.fileUrl ? (
                  <img src={msg.fileUrl} alt="shared" className="max-w-xs rounded" />
                ) : (
                  <p className="text-sm break-words">{msg.previewText}</p>
                )}
                <p className="text-xs mt-1 opacity-70">
                  {new Date(msg.timestamp?.toMillis?.()).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Encryption Key Setup */}
      {isEncrypted && !decryptionKey && (
        <div className="p-3 bg-amber-500/10 border-t border-amber-500/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-amber-500" />
            <span className="text-xs text-amber-400">Set encryption key to send messages</span>
          </div>
          <button
            onClick={() => setShowKeyPrompt(true)}
            className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold text-xs rounded"
          >
            Set Key
          </button>
        </div>
      )}

      {/* Key Prompt Modal */}
      {showKeyPrompt && (
        <div className="fixed inset-0 bg-slate-950/80 flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 w-96">
            <h3 className="font-bold mb-4 text-slate-100">Set Encryption Key</h3>
            <input
              type="password"
              placeholder="Enter shared encryption key"
              value={decryptionKey}
              onChange={(e) => setDecryptionKey(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-slate-200 mb-4 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowKeyPrompt(false)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2 rounded font-semibold text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowKeyPrompt(false)}
                className="flex-1 bg-amber-600 hover:bg-amber-500 text-slate-950 py-2 rounded font-semibold text-sm"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message Input */}
      <form onSubmit={handleSendMessage} className="p-4 border-t border-slate-900 bg-slate-900/50">
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setIsEncrypted(!isEncrypted)}
            className={`px-3 py-1 rounded text-xs font-semibold flex items-center gap-1 ${
              isEncrypted
                ? 'bg-amber-600 text-slate-950'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {isEncrypted ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
            {isEncrypted ? 'Encrypted' : 'Plain'}
          </button>
          <input
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            ref={fileInputRef}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1 rounded text-xs font-semibold bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 flex items-center gap-1"
          >
            <ImageIcon className="w-3 h-3" />
            Image
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type a message..."
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            disabled={isEncrypted && !decryptionKey}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSending || !messageText.trim()}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2"
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
