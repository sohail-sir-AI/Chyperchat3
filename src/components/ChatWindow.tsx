import React, { useState, useEffect, useRef } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  arrayUnion
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
  Trash2,
  X,
  Image as ImageIcon,
  Maximize2,
  Download,
  Loader2
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { encryptMessage, decryptMessage, EncryptedPayload } from '../lib/crypto';
import { processImageFile } from '../lib/imageUtils';
import { formatMessageTime, formatRelativeTime } from '../lib/dateUtils';
import { ChatRoom, ChatMessage, UserProfile } from '../types';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: any;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock: () => void;
  onBack?: () => void;
}

export default function ChatWindow({ chat, currentUser, usersMap, onEmergencyLock, onBack }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [tempPassphrase, setTempPassphrase] = useState('');
  const [showTempPassphrase, setShowTempPassphrase] = useState(false);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [replyingTo, setReplyingTo] = useState<{ id: string; senderName: string; text: string } | null>(null);

  // Staging for client-side encrypted image attachments
  const [selectedImage, setSelectedImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync tempPassphrase with passphrase when room or passphrase changes
  useEffect(() => {
    setTempPassphrase(passphrase);
  }, [passphrase, chat.id]);

  // Reset reply and image attachment states on room change
  useEffect(() => {
    setReplyingTo(null);
    setSelectedImage(null);
  }, [chat.id]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Real-time typing states and cleanup
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Local ticker for evaluating heartbeat margins of safety in real-time
  const [nowMs, setNowMs] = useState<number>(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (isTypingRef.current && currentUser) {
        const chatDocRef = doc(db, 'chats', chat.id);
        updateDoc(chatDocRef, {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Unmount typing cleanup failed:", err));
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      isTypingRef.current = false;
    };
  }, [chat.id, currentUser]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputText(val);

    if (!currentUser) return;

    if (val.trim()) {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: true
        }).catch(err => console.error("Failed to start typing update:", err));
      }

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

      typingTimeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Failed to stop typing update:", err));
      }, 3000);
    } else {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Failed to clear typing update:", err));
      }
    }
  };

  // Leverage Firestore heartbeat/presence logic to filter actively typing users
  const getTypingUsers = () => {
    if (!chat.isTyping) return [];
    return Object.entries(chat.isTyping)
      .filter(([uid, isTyping]) => {
        if (!isTyping || uid === currentUser?.uid) return false;
        const user = usersMap[uid];
        if (!user) return false;

        if (user.status !== 'online') return false;
        const lastSeenMs = user.lastSeen?.toMillis() || 0;
        const isHeartbeatActive = (nowMs - lastSeenMs) < 120000;
        return isHeartbeatActive;
      })
      .map(([uid]) => usersMap[uid])
      .filter(Boolean);
  };

  const typingUsers = getTypingUsers();
  const isSomeoneTyping = typingUsers.length > 0;

  // Trigger emergency lock: wipe room E2EE passphrase from memory & lock the entire screen
  const triggerEmergencyLock = () => {
    setPassphrase('');
    setInputText('');
    onEmergencyLock();
  };

  // Subscribing to chat messages in real time
  useEffect(() => {
    const messagesPath = `chats/${chat.id}/messages`;
    const q = query(collection(db, messagesPath), orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatMessage[];
        setMessages(msgs);
        setErrorMsg('');
      },
      (error) => {
        if ((error as any)?.code === 'unavailable') {
          console.warn('Messages listener operating in offline mode:', error);
          return;
        }
        handleFirestoreError(error, OperationType.LIST, messagesPath);
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  // Auto scroll to bottom when messages load
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, decryptedMessages]);

  // Update read receipts: Mark unread messages as read by current user
  useEffect(() => {
    if (!currentUser) return;
    
    const unreadMsgs = messages.filter(
      (msg) => !msg.readBy || !msg.readBy.includes(currentUser.uid)
    );

    if (unreadMsgs.length === 0) return;

    const updateReadReceipts = async () => {
      try {
        const batch = writeBatch(db);
        unreadMsgs.forEach((msg) => {
          const currentReadBy = msg.readBy || [];
          const updatedReadBySet = new Set([...currentReadBy, currentUser.uid]);
          const everyoneHasRead = chat.participantIds.every((id) => updatedReadBySet.has(id));

          const msgRef = doc(db, 'chats', chat.id, 'messages', msg.id);
          batch.update(msgRef, {
            readBy: arrayUnion(currentUser.uid),
            ...(everyoneHasRead ? { isRead: true } : {})
          });
        });
        await batch.commit();
      } catch (error) {
        console.error('Failed to update read receipts:', error);
      }
    };

    updateReadReceipts();
  }, [messages, currentUser, chat.id, chat.participantIds]);

  // On-the-fly decryption of messages when passphrase changes
  useEffect(() => {
    const decryptAll = async () => {
      setIsDecrypting(true);
      const decMap: Record<string, string> = {};
      
      for (const msg of messages) {
        if (!msg.isEncrypted) {
          decMap[msg.id] = msg.ciphertext || msg.previewText;
          continue;
        }

        if (!passphrase) {
          decMap[msg.id] = msg.previewText || '🔒 Encrypted message';
          continue;
        }

        try {
          const payload: EncryptedPayload = {
            ciphertext: msg.ciphertext,
            iv: msg.iv,
            salt: msg.salt
          };
          const decrypted = await decryptMessage(payload, passphrase);
          decMap[msg.id] = decrypted;
        } catch (err) {
          decMap[msg.id] = '🔒 [Decryption Failed: Incorrect Passcode]';
        }
      }
      
      setDecryptedMessages(decMap);
      setIsDecrypting(false);
    };

    const timeout = setTimeout(decryptAll, 100);
    return () => clearTimeout(timeout);
  }, [messages, passphrase]);

  // Client-side image selection and base64 compression
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a valid image file (PNG, JPEG, WebP, GIF).');
      return;
    }

    try {
      setIsProcessingImage(true);
      setErrorMsg('');
      const compressedDataUrl = await processImageFile(file);
      setSelectedImage({
        dataUrl: compressedDataUrl,
        name: file.name
      });
    } catch (err: any) {
      console.error('Failed to process image:', err);
      setErrorMsg(err?.message || 'Failed to process selected image file.');
    } finally {
      setIsProcessingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Helper to parse decrypted JSON or plain message text
  const parseDecryptedMessage = (decryptedStr: string) => {
    if (!decryptedStr) return { isImage: false, text: '', imageUrl: null };

    if (decryptedStr.startsWith('{') && decryptedStr.includes('"type":"image"')) {
      try {
        const parsed = JSON.parse(decryptedStr);
        if (parsed.type === 'image' && parsed.dataUrl) {
          return {
            isImage: true,
            imageUrl: parsed.dataUrl as string,
            text: (parsed.text as string) || ''
          };
        }
      } catch (e) {
        // Fallback if not valid JSON
      }
    } else if (decryptedStr.startsWith('data:image/')) {
      return {
        isImage: true,
        imageUrl: decryptedStr,
        text: ''
      };
    }

    return { isImage: false, text: decryptedStr, imageUrl: null };
  };

  // Sending a message (encrypted or direct plain text)
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() && !selectedImage) return;

    if (!passphrase) {
      setErrorMsg('Please enter a room passcode to encrypt and send messages.');
      return;
    }

    const messageText = inputText.trim();
    const imageToEncrypt = selectedImage;
    const replyData = replyingTo ? { ...replyingTo } : null;

    setInputText('');
    setSelectedImage(null);
    setReplyingTo(null);
    setErrorMsg('');

    if (isTypingRef.current) {
      isTypingRef.current = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      updateDoc(doc(db, 'chats', chat.id), {
        [`isTyping.${currentUser.uid}`]: false
      }).catch(err => console.error("Failed to clear typing on submit:", err));
    }

    try {
      let rawPayload = messageText;
      let previewText = messageText;
      let ciphertext = '';
      let iv = '';
      let salt = '';
      let isEncrypted = false;

      if (imageToEncrypt) {
        rawPayload = JSON.stringify({
          type: 'image',
          dataUrl: imageToEncrypt.dataUrl,
          text: messageText
        });
        previewText = messageText ? `📷 Photo: ${messageText}` : '📷 Shared image';
      }

      if (passphrase) {
        const encrypted = await encryptMessage(rawPayload, passphrase);
        ciphertext = encrypted.ciphertext;
        iv = encrypted.iv;
        salt = encrypted.salt;
        isEncrypted = true;
        if (!imageToEncrypt) {
          previewText = '🔒 Encrypted message';
        }
      } else {
        ciphertext = rawPayload;
      }

      if (previewText.length > 180) {
        previewText = previewText.substring(0, 180) + '...';
      }

      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;

      const messageDocRef = doc(db, 'chats', chat.id, 'messages', messageId);
      const chatDocRef = doc(db, 'chats', chat.id);

      const senderProfile = usersMap[currentUser.uid];
      const senderName = (senderProfile?.displayName || currentUser.displayName || 'Anonymous').substring(0, 90);
      const senderPhoto = (senderProfile?.photoURL || currentUser.photoURL || '').substring(0, 490);

      const isReadInitial = chat.participantIds.every((id) => id === currentUser.uid);

      const messagePayload = {
        id: messageId,
        senderId: currentUser.uid,
        senderName,
        senderPhoto,
        timestamp: serverTimestamp(),
        isEncrypted,
        ciphertext,
        iv,
        salt,
        previewText,
        readBy: [currentUser.uid],
        isRead: isReadInitial,
        ...(replyData ? {
          replyToId: replyData.id,
          replyToSenderName: replyData.senderName.substring(0, 90),
          replyToText: replyData.text.substring(0, 180)
        } : {})
      };

      await setDoc(messageDocRef, messagePayload);

      await updateDoc(chatDocRef, {
        lastMessage: {
          text: previewText,
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });

    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `chats/${chat.id}/messages`);
    }
  };

  // Delete message from room
  const handleDeleteMessage = async (messageId: string) => {
    try {
      const msgRef = doc(db, 'chats', chat.id, 'messages', messageId);
      await deleteDoc(msgRef);
    } catch (error) {
      console.error('Failed to delete message:', error);
      setErrorMsg('Failed to delete message. Please try again.');
    }
  };

  // Locate current chat recipient (for direct chats)
  const getRecipientInfo = () => {
    if (chat.type !== 'direct') return null;
    const recipientId = chat.participantIds.find((id) => id !== currentUser.uid);
    if (!recipientId) return null;
    return usersMap[recipientId] || null;
  };

  const recipient = getRecipientInfo();
  const roomName = chat.type === 'direct' ? (recipient?.displayName || 'Direct Chat') : (chat.name || 'Group Chat');

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 rounded-2xl border border-slate-800/80 overflow-hidden shadow-2xl relative">
      {/* Top Navigation Bar */}
      <div className="px-4 py-3 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
              title="Back to conversations"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}

          {chat.type === 'direct' && recipient ? (
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative shrink-0">
                <img
                  src={recipient.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(recipient.displayName)}`}
                  alt={recipient.displayName}
                  className="w-9 h-9 rounded-full object-cover bg-slate-800 border border-slate-700"
                  referrerPolicy="no-referrer"
                />
                <span
                  className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${
                    recipient.status === 'online' ? 'bg-emerald-500' : 'bg-slate-500'
                  }`}
                />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-100 truncate flex items-center gap-1.5">
                  <span>{recipient.displayName}</span>
                  <span className="text-[10px] text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-mono shrink-0">
                    E2EE
                  </span>
                </h2>
                <div className="text-[11px] text-slate-400 truncate flex items-center gap-1">
                  {isSomeoneTyping ? (
                    <span className="text-amber-400 font-medium animate-pulse flex items-center gap-1">
                      <span>{typingUsers.map(u => u.displayName.split(' ')[0]).join(', ')}</span>
                      <span>is typing...</span>
                    </span>
                  ) : (
                    <span>{recipient.status === 'online' ? 'Online • Active now' : `Last seen ${formatRelativeTime(recipient.lastSeen)}`}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0 text-amber-400 font-bold text-xs">
                {chat.name.substring(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-100 truncate flex items-center gap-1.5">
                  <span>{chat.name}</span>
                  <span className="text-[10px] text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-mono shrink-0">
                    Group E2EE
                  </span>
                </h2>
                <div className="text-[11px] text-slate-400 truncate">
                  {isSomeoneTyping ? (
                    <span className="text-amber-400 font-medium animate-pulse">
                      {typingUsers.map(u => u.displayName.split(' ')[0]).join(', ')} typing...
                    </span>
                  ) : (
                    <span>{chat.participantIds.length} encrypted participants</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Security Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={triggerEmergencyLock}
            className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 transition-colors flex items-center gap-1 text-xs font-semibold cursor-pointer"
            title="Panic Lock: Purge room memory & lock screen instantly"
          >
            <ShieldAlert className="w-4 h-4" />
            <span className="hidden sm:inline">Panic Lock</span>
          </button>

          {passphrase ? (
            <div className="flex items-center gap-1">
              <div className="flex items-center gap-1 text-emerald-400 font-medium text-xs px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Unlocked</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPassphrase('');
                  setTempPassphrase('');
                }}
                className="flex items-center justify-center p-1.5 rounded-lg bg-slate-900 border border-emerald-500/20 text-emerald-400 hover:bg-slate-850 hover:text-rose-400 transition-colors cursor-pointer"
                title="Click to lock chat"
              >
                <Unlock className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-rose-400 font-medium px-2 py-1 bg-rose-500/10 border border-rose-500/20 rounded-lg animate-pulse">
              <Lock className="w-3.5 h-3.5" />
              <span className="text-[10px] uppercase font-semibold tracking-wider">Locked</span>
            </div>
          )}
        </div>
      </div>

      {/* Chat Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-slate-900/40 relative flex flex-col justify-between">
        {!passphrase ? (
          <div className="flex-1 flex items-center justify-center py-6 animate-fadeIn">
            <div className="w-full max-w-xs bg-slate-950/60 border border-slate-800/80 rounded-2xl p-5 shadow-2xl backdrop-blur-sm flex flex-col items-center">
              <div className="inline-flex p-3 rounded-full bg-slate-900 border border-slate-800 text-amber-500 mb-2">
                <Lock className="w-6 h-6 animate-pulse" />
              </div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">E2E Cryptographic Vault</h3>
              <p className="text-[11px] text-slate-400 text-center mt-1 mb-4 leading-relaxed">
                Enter a shared secret passcode to encrypt & decrypt this conversation.
              </p>

              {/* Display Panel */}
              <div className="w-full relative mb-4">
                <input
                  type={showTempPassphrase ? 'text' : 'password'}
                  value={tempPassphrase}
                  onChange={(e) => setTempPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tempPassphrase) {
                      setPassphrase(tempPassphrase);
                      setErrorMsg('');
                    }
                  }}
                  placeholder="Enter passcode..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-center font-mono text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500 tracking-widest"
                />
                <button
                  type="button"
                  onClick={() => setShowTempPassphrase(!showTempPassphrase)}
                  className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  {showTempPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Keypad Grid */}
              <div className="grid grid-cols-3 gap-2.5 w-full mb-4">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setTempPassphrase(prev => prev + num)}
                    className="w-11 h-11 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200 hover:text-amber-400 font-bold text-sm flex items-center justify-center border border-slate-800/80 hover:border-slate-700 transition-all active:scale-90 shadow-sm cursor-pointer mx-auto"
                  >
                    {num}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setTempPassphrase('')}
                  className="w-11 h-11 rounded-full bg-slate-900/40 hover:bg-slate-900 text-slate-500 hover:text-rose-450 text-[10px] font-semibold flex items-center justify-center transition-colors cursor-pointer mx-auto"
                >
                  CLEAR
                </button>
                <button
                  type="button"
                  onClick={() => setTempPassphrase(prev => prev + '0')}
                  className="w-11 h-11 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200 hover:text-amber-400 font-bold text-sm flex items-center justify-center border border-slate-800/80 hover:border-slate-700 transition-all active:scale-90 shadow-sm cursor-pointer mx-auto"
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={() => setTempPassphrase(prev => prev.slice(0, -1))}
                  className="w-11 h-11 rounded-full bg-slate-900/40 hover:bg-slate-900 text-slate-500 hover:text-amber-450 flex items-center justify-center transition-colors cursor-pointer mx-auto"
                  title="Backspace"
                >
                  ⌫
                </button>
              </div>

              {/* Submit button */}
              <button
                type="button"
                disabled={!tempPassphrase}
                onClick={() => {
                  setPassphrase(tempPassphrase);
                  setErrorMsg('');
                }}
                className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800/80 disabled:text-slate-600 text-slate-950 font-bold py-2.5 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-all duration-150 shadow-md active:scale-95 cursor-pointer text-xs"
              >
                <Unlock className="w-3.5 h-3.5" />
                <span>Unlock & Decrypt Chat</span>
              </button>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3 p-8 animate-fadeIn">
            <Lock className="w-12 h-12 text-slate-600 animate-pulse" />
            <div className="max-w-xs">
              <h3 className="text-sm font-semibold text-slate-300">Secure Vault Established</h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Messages and attachments in this chat are end-to-end encrypted using AES-GCM-256 with PBKDF2 key derivation.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => {
              const isMe = msg.senderId === currentUser?.uid;
              const decryptedText = decryptedMessages[msg.id];
              const isLockError = decryptedText?.includes('🔒 [Decryption Failed');
              const readByList = msg.readBy || [];
              const otherReaders = readByList.filter((id) => id !== msg.senderId);
              const isReadByOthers = otherReaders.length > 0;
              const allRead = msg.isRead || (chat.participantIds.length > 0 && chat.participantIds.every((id) => readByList.includes(id)));

              const parsedPayload = parseDecryptedMessage(decryptedText);
              const isImagePreview = msg.previewText?.includes('📷') || parsedPayload.isImage;

              return (
                <div
                  key={msg.id}
                  className={`flex items-end gap-2.5 ${isMe ? 'flex-row-reverse' : 'flex-row'} group/msg`}
                >
                  {/* Sender Avatar */}
                  {!isMe && (
                    <img
                      src={msg.senderPhoto || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(msg.senderName)}`}
                      alt={msg.senderName}
                      className="w-7 h-7 rounded-full object-cover bg-slate-800 border border-slate-700 shrink-0 mb-1"
                      referrerPolicy="no-referrer"
                    />
                  )}

                  {/* Message Card Container */}
                  <div className={`max-w-[85%] sm:max-w-[70%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    {/* Header info for group chats */}
                    {chat.type === 'group' && !isMe && (
                      <span className="text-[10px] text-slate-400 font-medium mb-1 ml-1">
                        {msg.senderName}
                      </span>
                    )}

                    {/* Replying Context Quote Banner */}
                    {msg.replyToId && (
                      <div className={`border-l-2 px-2.5 py-1 rounded text-xs mb-1 max-w-full truncate ${
                        isMe
                          ? 'border-amber-400 bg-amber-950/40 text-amber-200/90'
                          : 'border-slate-600 bg-slate-800/80 text-slate-300'
                      }`}>
                        <span className="font-semibold text-[10px] uppercase tracking-wider block opacity-75">
                          Replying to {msg.replyToSenderName}
                        </span>
                        <span className="truncate block italic text-[11px]">{msg.replyToText}</span>
                      </div>
                    )}

                    {/* Message Bubble Body */}
                    <div
                      className={`relative px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-lg backdrop-blur-xs break-words ${
                        isMe
                          ? 'bg-amber-600 text-slate-950 font-medium rounded-br-xs'
                          : 'bg-slate-800 text-slate-100 rounded-bl-xs border border-slate-700/60'
                      }`}
                    >
                      {isLockError ? (
                        <div className="flex items-center gap-2 text-rose-300 font-mono text-xs">
                          <Lock className="w-3.5 h-3.5 shrink-0" />
                          <span>Incorrect Room Passcode</span>
                        </div>
                      ) : parsedPayload.isImage ? (
                        <div className="space-y-2">
                          <div className="relative group/img overflow-hidden rounded-xl border border-slate-700/60 bg-black/40">
                            <img
                              src={parsedPayload.imageUrl!}
                              alt="Encrypted attachment"
                              className="max-h-64 sm:max-h-80 w-auto rounded-xl object-contain cursor-pointer hover:opacity-95 transition-opacity"
                              onClick={() => setExpandedImageUrl(parsedPayload.imageUrl)}
                            />
                            <button
                              type="button"
                              onClick={() => setExpandedImageUrl(parsedPayload.imageUrl)}
                              className="absolute bottom-2 right-2 p-1.5 bg-black/70 text-slate-200 rounded-lg backdrop-blur-md opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center gap-1 text-[10px] font-medium border border-slate-700 cursor-pointer"
                            >
                              <Maximize2 className="w-3 h-3" />
                              <span>View</span>
                            </button>
                          </div>
                          {parsedPayload.text && (
                            <p className="whitespace-pre-wrap break-words">{parsedPayload.text}</p>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {!passphrase && (
                            <span className="shrink-0 text-amber-300">
                              {isImagePreview ? '📷' : '🔒'}
                            </span>
                          )}
                          <p className="whitespace-pre-wrap break-words">
                            {decryptedText || msg.previewText}
                          </p>
                        </div>
                      )}

                      {/* Footer Metadata */}
                      <div
                        className={`flex items-center justify-end gap-1 text-[10px] mt-1 font-mono ${
                          isMe ? 'text-amber-950/80 font-semibold' : 'text-slate-400'
                        }`}
                      >
                        <span>{formatMessageTime(msg.timestamp)}</span>
                        {isMe && (
                          <span title={allRead ? 'Read by everyone' : isReadByOthers ? 'Read by recipient' : 'Sent'}>
                            {allRead || isReadByOthers ? (
                              <CheckCheck className="w-3.5 h-3.5 text-slate-950" />
                            ) : (
                              <Check className="w-3.5 h-3.5 text-amber-950/70" />
                            )}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Quick Action Controls (Reply / Delete) */}
                    <div className="flex items-center gap-1.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                      <button
                        onClick={() => {
                          const replyText = parsedPayload.isImage
                            ? (parsedPayload.text ? `📷 Photo: ${parsedPayload.text}` : '📷 Shared image')
                            : (decryptedText || msg.previewText);
                          setReplyingTo({
                            id: msg.id,
                            senderName: isMe ? 'You' : msg.senderName,
                            text: replyText
                          });
                        }}
                        className="p-1 hover:bg-slate-800 text-slate-500 hover:text-amber-400 rounded transition-colors cursor-pointer"
                        title="Reply to message"
                      >
                        <CornerUpLeft className="w-3.5 h-3.5" />
                      </button>

                      {(isMe || chat.type === 'direct') && (
                        <button
                          onClick={() => handleDeleteMessage(msg.id)}
                          className="p-1 hover:bg-slate-800 text-slate-500 hover:text-rose-400 rounded transition-colors cursor-pointer"
                          title="Delete message"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Toolbar Section */}
      <div className="p-3 bg-slate-900 border-t border-slate-800 shrink-0 space-y-2">
        {errorMsg && (
          <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-3 py-1.5 rounded-xl text-xs font-medium flex items-center justify-between animate-shake">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} className="p-0.5 hover:text-rose-200 cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Selected Image Attachment Staging Banner */}
        {selectedImage && (
          <div className="flex items-center justify-between bg-slate-950 border border-slate-800 p-2 rounded-xl text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative w-10 h-10 rounded-lg overflow-hidden border border-slate-700 shrink-0">
                <img
                  src={selectedImage.dataUrl}
                  alt="Attachment preview"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="min-w-0">
                <span className="text-slate-200 font-medium truncate block">{selectedImage.name}</span>
                <span className="text-[10px] text-amber-500 font-mono">Compressed for AES-256 E2EE</span>
              </div>
            </div>
            <button
              onClick={() => setSelectedImage(null)}
              className="p-1 text-slate-500 hover:text-rose-400 transition-colors cursor-pointer"
              title="Remove image"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Replying Context Banner */}
        {replyingTo && (
          <div className="flex items-center justify-between bg-slate-950 border-l-2 border-amber-500 px-3 py-2 rounded-r-xl text-xs">
            <div className="min-w-0 pr-2">
              <span className="text-amber-400 font-semibold text-[10px] uppercase tracking-wider block">
                Replying to {replyingTo.senderName}
              </span>
              <span className="text-slate-300 truncate block text-[11px]">{replyingTo.text}</span>
            </div>
            <button
              onClick={() => setReplyingTo(null)}
              className="p-1 text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Hidden File Input for Image Selection */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageSelect}
        />

        {/* Message Input Form */}
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <button
            type="button"
            disabled={!passphrase || isProcessingImage}
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-amber-400 rounded-xl transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shrink-0 cursor-pointer"
            title="Attach encrypted image"
          >
            {isProcessingImage ? (
              <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
            ) : (
              <ImageIcon className="w-4 h-4" />
            )}
          </button>

          <input
            type="text"
            value={inputText}
            onChange={handleInputChange}
            disabled={!passphrase}
            placeholder={
              passphrase
                ? selectedImage
                  ? "Add an optional image caption..."
                  : "Type an E2E encrypted message..."
                : "🔒 Room is locked. Enter passcode above to chat..."
            }
            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />

          <button
            type="submit"
            disabled={!passphrase || (!inputText.trim() && !selectedImage)}
            className="bg-amber-600 text-slate-950 font-medium px-4 py-2 rounded-xl flex items-center justify-center gap-1 hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 shrink-0 cursor-pointer"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Lightbox Modal for Expanded Decrypted Image */}
      {expandedImageUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setExpandedImageUrl(null)}
        >
          <div className="relative max-w-4xl w-full max-h-[90vh] flex flex-col items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <div className="absolute -top-12 right-0 flex items-center gap-2">
              <a
                href={expandedImageUrl}
                download="encrypted-attachment.jpg"
                className="p-2 bg-slate-800 text-slate-200 rounded-lg border border-slate-700 hover:bg-slate-700 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download</span>
              </a>
              <button
                type="button"
                onClick={() => setExpandedImageUrl(null)}
                className="p-2 bg-slate-800 text-slate-200 rounded-lg border border-slate-700 hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <img
              src={expandedImageUrl}
              alt="Expanded decrypted attachment"
              className="max-h-[85vh] max-w-full rounded-2xl object-contain border border-slate-800 shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
                                      }import { encryptMessage, decryptMessage, EncryptedPayload } from '../lib/crypto';
import { processImageFile } from '../lib/imageUtils';
import { formatMessageTime, formatRelativeTime } from '../lib/dateUtils';
import { ChatRoom, ChatMessage, UserProfile } from '../types';
import PresenceStatus from './PresenceStatus';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: any;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock: () => void;
  onBack?: () => void;
}

export default function ChatWindow({ chat, currentUser, usersMap, onEmergencyLock, onBack }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  const [tempPassphrase, setTempPassphrase] = useState('');
  const [showTempPassphrase, setShowTempPassphrase] = useState(false);

  const [replyingTo, setReplyingTo] = useState<{ id: string; senderName: string; text: string } | null>(null);
  
  // Staging for client-side encrypted image attachments
  const [selectedImage, setSelectedImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync tempPassphrase with passphrase when room or passphrase changes
  useEffect(() => {
    setTempPassphrase(passphrase);
  }, [passphrase, chat.id]);

  // Reset reply and image attachment states on room change
  useEffect(() => {
    setReplyingTo(null);
    setSelectedImage(null);
  }, [chat.id]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Real-time typing states and cleanup
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Local ticker for evaluating heartbeat margins of safety in real-time
  const [nowMs, setNowMs] = useState<number>(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (isTypingRef.current && currentUser) {
        const chatDocRef = doc(db, 'chats', chat.id);
        updateDoc(chatDocRef, {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Unmount typing cleanup failed:", err));
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      isTypingRef.current = false;
    };
  }, [chat.id, currentUser]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputText(val);

    if (!currentUser) return;

    if (val.trim()) {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: true
        }).catch(err => console.error("Failed to start typing update:", err));
      }

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

      typingTimeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Failed to stop typing update:", err));
      }, 3000);
    } else {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        updateDoc(doc(db, 'chats', chat.id), {
          [`isTyping.${currentUser.uid}`]: false
        }).catch(err => console.error("Failed to clear typing update:", err));
      }
    }
  };

  // Leverage Firestore heartbeat/presence logic to filter actively typing users
  const getTypingUsers = () => {
    if (!chat.isTyping) return [];
    return Object.entries(chat.isTyping)
      .filter(([uid, isTyping]) => {
        if (!isTyping || uid === currentUser?.uid) return false;
        const user = usersMap[uid];
        if (!user) return false;

        // Check user status is 'online' and lastSeen heartbeat is within 2-minute margin
        if (user.status !== 'online') return false;
        const lastSeenMs = user.lastSeen?.toMillis() || 0;
        const isHeartbeatActive = (nowMs - lastSeenMs) < 120000; // 2 minutes heartbeat window
        return isHeartbeatActive;
      })
      .map(([uid]) => usersMap[uid])
      .filter(Boolean);
  };

  const typingUsers = getTypingUsers();
  const isSomeoneTyping = typingUsers.length > 0;

  // Trigger emergency lock: wipe room E2EE passphrase from memory & lock the entire screen
  const triggerEmergencyLock = () => {
    setPassphrase('');
    setInputText('');
    onEmergencyLock();
  };

  // Subscribing to chat messages in real time
  useEffect(() => {
    const messagesPath = `chats/${chat.id}/messages`;
    const q = query(collection(db, messagesPath), orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatMessage[];
        setMessages(msgs);
        setErrorMsg('');
      },
      (error) => {
        if ((error as any)?.code === 'unavailable') {
          console.warn('Messages listener operating in offline mode:', error);
          return;
        }
        handleFirestoreError(error, OperationType.LIST, messagesPath);
      }
    );

    return () => unsubscribe();
  }, [chat.id]);

  // Auto scroll to bottom when messages load
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, decryptedMessages]);

  // Update read receipts: Mark unread messages as read by current user
  useEffect(() => {
    if (!currentUser) return;
    
    const unreadMsgs = messages.filter(
      (msg) => !msg.readBy || !msg.readBy.includes(currentUser.uid)
    );

    if (unreadMsgs.length === 0) return;

    const updateReadReceipts = async () => {
      try {
        const batch = writeBatch(db);
        unreadMsgs.forEach((msg) => {
          const currentReadBy = msg.readBy || [];
          const updatedReadBySet = new Set([...currentReadBy, currentUser.uid]);
          const everyoneHasRead = chat.participantIds.every((id) => updatedReadBySet.has(id));

          const msgRef = doc(db, 'chats', chat.id, 'messages', msg.id);
          batch.update(msgRef, {
            readBy: arrayUnion(currentUser.uid),
            ...(everyoneHasRead ? { isRead: true } : {})
          });
        });
        await batch.commit();
      } catch (error) {
        console.error('Failed to update read receipts:', error);
      }
    };

    updateReadReceipts();
  }, [messages, currentUser, chat.id, chat.participantIds]);

  // On-the-fly decryption of messages when passphrase changes
  useEffect(() => {
    const decryptAll = async () => {
      setIsDecrypting(true);
      const decMap: Record<string, string> = {};
      
      for (const msg of messages) {
        if (!msg.isEncrypted) {
          decMap[msg.id] = msg.ciphertext || msg.previewText;
          continue;
        }

        if (!passphrase) {
          decMap[msg.id] = '🔒 [Encrypted message - Enter passcode above to decrypt]';
          continue;
        }

        try {
          const payload: EncryptedPayload = {
            ciphertext: msg.ciphertext,
            iv: msg.iv,
            salt: msg.salt
          };
          const decrypted = await decryptMessage(payload, passphrase);
          decMap[msg.id] = decrypted;
        } catch (err) {
          // Decryption failed for this passcode
          decMap[msg.id] = '🔒 [Decryption Failed: Incorrect Passcode]';
        }
      }
      
      setDecryptedMessages(decMap);
      setIsDecrypting(false);
    };

    const timeout = setTimeout(decryptAll, 150);
    return () => clearTimeout(timeout);
  }, [messages, passphrase]);

  // Client-side image selection and base64 compression
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a valid image file (PNG, JPEG, WebP, GIF).');
      return;
    }

    try {
      setIsProcessingImage(true);
      setErrorMsg('');
      const compressedDataUrl = await processImageFile(file);
      setSelectedImage({
        dataUrl: compressedDataUrl,
        name: file.name
      });
    } catch (err: any) {
      console.error('Failed to process image:', err);
      setErrorMsg(err?.message || 'Failed to process selected image file.');
    } fontally {
      setIsProcessingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Helper to parse decrypted JSON or plain message text
  const parseDecryptedMessage = (decryptedStr: string) => {
    if (!decryptedStr) return { isImage: false, text: '', imageUrl: null };

    if (decryptedStr.startsWith('{') && decryptedStr.includes('"type":"image"')) {
      try {
        const parsed = JSON.parse(decryptedStr);
        if (parsed.type === 'image' && parsed.dataUrl) {
          return {
            isImage: true,
            imageUrl: parsed.dataUrl as string,
            text: (parsed.text as string) || ''
          };
        }
      } catch (e) {
        // Fallback if not valid JSON
      }
    } else if (decryptedStr.startsWith('data:image/')) {
      return {
        isImage: true,
        imageUrl: decryptedStr,
        text: ''
      };
    }

    return { isImage: false, text: decryptedStr, imageUrl: null };
  };

  // Sending a message (encrypted or direct plain text)
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() && !selectedImage) return;

    if (!passphrase) {
      setErrorMsg('Please enter a room passcode to encrypt and send messages.');
      return;
    }

    const messageText = inputText.trim();
    const imageToEncrypt = selectedImage;
    const replyData = replyingTo ? { ...replyingTo } : null;

    setInputText('');
    setSelectedImage(null);
    setReplyingTo(null);
    setErrorMsg('');

    // Immediately stop typing indicator on message send
    if (isTypingRef.current) {
      isTypingRef.current = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      updateDoc(doc(db, 'chats', chat.id), {
        [`isTyping.${currentUser.uid}`]: false
      }).catch(err => console.error("Failed to clear typing on submit:", err));
    }

    try {
      let rawPayload = messageText;
      let previewText = messageText;
      let ciphertext = '';
      let iv = '';
      let salt = '';
      let isEncrypted = false;

      if (imageToEncrypt) {
        rawPayload = JSON.stringify({
          type: 'image',
          dataUrl: imageToEncrypt.dataUrl,
          text: messageText
        });
        previewText = messageText ? `📷 Photo: ${messageText}` : '📷 Shared image';
      }

      if (passphrase) {
        // Encrypt message payload client-side with passcode
        const encrypted = await encryptMessage(rawPayload, passphrase);
        ciphertext = encrypted.ciphertext;
        iv = encrypted.iv;
        salt = encrypted.salt;
        isEncrypted = true;
        if (!imageToEncrypt) {
          previewText = '🔒 Encrypted message';
        }
      } else {
        // Unencrypted direct message
        ciphertext = rawPayload;
      }

      // Truncate previewText to safely comply with Firestore rule max length (200)
      if (previewText.length > 180) {
        previewText = previewText.substring(0, 180) + '...';
      }

      // Generate secure unique message ID
      const messageId = doc(collection(db, 'chats', chat.id, 'messages')).id;

      // Prepare transaction payloads
      const messageDocRef = doc(db, 'chats', chat.id, 'messages', messageId);
      const chatDocRef = doc(db, 'chats', chat.id);

      const senderProfile = usersMap[currentUser.uid];
      const senderName = (senderProfile?.displayName || currentUser.displayName || 'Anonymous').substring(0, 90);
      const senderPhoto = (senderProfile?.photoURL || currentUser.photoURL || '').substring(0, 490);

      const isReadInitial = chat.participantIds.every((id) => id === currentUser.uid);

      const messagePayload = {
        id: messageId,
        senderId: currentUser.uid,
        senderName,
        senderPhoto,
        timestamp: serverTimestamp(),
        isEncrypted,
        ciphertext,
        iv,
        salt,
        previewText,
        readBy: [currentUser.uid],
        isRead: isReadInitial,
        ...(replyData ? {
          replyToId: replyData.id,
          replyToSenderName: replyData.senderName.substring(0, 90),
          replyToText: replyData.text.substring(0, 180)
        } : {})
      };

      // Create message document in subcollection
      await setDoc(messageDocRef, messagePayload);

      // Update room metadata for recent previews
      await updateDoc(chatDocRef, {
        lastMessage: {
          text: previewText,
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      });

    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `chats/${chat.id}/messages`);
    }
  };

  // Delete message from room
  const handleDeleteMessage = async (messageId: string) => {
    try {
      const msgRef = doc(db, 'chats', chat.id, 'messages', messageId);
      await deleteDoc(msgRef);
    } catch (error) {
      console.error('Failed to delete message:', error);
      setErrorMsg('Failed to delete message. Please try again.');
    }
  };

  // Locate current chat recipient (for direct chats)
  const getRecipientInfo = () => {
    if (chat.type !== 'direct') return null;
    const recipientId = chat.participantIds.find((id) => id !== currentUser.uid);
    if (!recipientId) return null;
    return usersMap[recipientId] || null;
  };

  const recipient = getRecipientInfo();
  const roomName = chat.type === 'direct' ? (recipient?.displayName || 'Direct Chat') : (chat.name || 'Group Chat');

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-2xl">
      {/* Chat Room Header */}
      <div className="flex items-center justify-between p-4 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2 sm:gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-2 -ml-2 rounded-full text-slate-400 hover:text-slate-100 hover:bg-slate-900/60 transition-all duration-150 cursor-pointer"
              aria-label="Back to chat list"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}

          {chat.type === 'direct' && recipient ? (
            <div className="flex items-center gap-2">
              <div className="relative">
                <img
                  src={recipient.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(recipient.displayName)}`}
                  alt={recipient.displayName}
                  className="w-10 h-10 rounded-full bg-slate-700 border border-slate-700 object-cover"
                  referrerPolicy="no-referrer"
                />
                <span
                  className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-slate-900 ${
                    isSomeoneTyping ? 'bg-amber-500 animate-bounce' : recipient.status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'
                  }`}
                  title={isSomeoneTyping ? 'Typing' : recipient.status === 'online' ? 'Online' : 'Offline'}
                />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-slate-100 truncate">
                  {recipient.displayName}
                </span>
                <span className="text-xs truncate">
                  {isSomeoneTyping ? (
                    <span className="text-amber-400 font-medium animate-pulse flex items-center gap-1">
                      <span>typing</span>
                      <span className="flex gap-0.5 text-amber-400">
                        <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                      </span>
                    </span>
                  ) : recipient.status === 'online' ? (
                    <span className="text-emerald-400 font-medium">Online</span>
                  ) : (
                    <span className="text-slate-400">
                      Last seen: {formatRelativeTime(recipient.lastSeen)}
                    </span>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 rounded-full bg-indigo-600/20 text-indigo-400 flex items-center justify-center border border-indigo-500/20">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-100">{roomName}</h3>
                <p className="text-xs text-slate-400 min-h-[16px]">
                  {isSomeoneTyping ? (
                    <span className="text-amber-400 font-medium animate-pulse flex items-center gap-1">
                      <span className="truncate max-w-[140px]">{typingUsers.map(u => u.displayName).join(', ')} typing</span>
                      <span className="flex gap-0.5 text-amber-400">
                        <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                      </span>
                    </span>
                  ) : (
                    `${chat.participantIds.length} members • End-to-End Encrypted`
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* E2EE Lock State Badge & Emergency Lock Button */}
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1 bg-slate-900 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-mono">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span>E2EE Active</span>
          </div>

          <button
            type="button"
            onClick={triggerEmergencyLock}
            className="flex items-center gap-1.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/30 text-rose-300 hover:text-white px-3 py-1.5 rounded-xl text-xs font-semibold shadow-lg transition-all active:scale-95 duration-150 cursor-pointer"
            title="Instantly lock the app and wipe keys"
          >
            <Lock className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
            <span>Emergency Lock</span>
          </button>
        </div>
      </div>

      {/* Security Key Vault Banner */}
      <div className="bg-slate-950/80 border-b border-slate-800/60 p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
        <div className="flex items-start gap-2 max-w-md">
          <Key className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-slate-300 font-medium">Room Passphrase (Strict E2EE)</p>
            <p className="text-slate-500 text-[11px] leading-relaxed">
              Messages are encrypted client-side using this passcode. It is never uploaded to Firebase. Both participants must enter the identical passcode to converse.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {passphrase ? (
            <>
              <div className="relative animate-fadeIn">
                <input
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter room password..."
                  className="bg-slate-900 text-slate-100 placeholder-slate-600 text-xs rounded-lg border border-slate-800 px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-amber-500 w-48 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  className="absolute right-2 top-2 text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  {showPassphrase ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPassphrase('');
                  setTempPassphrase('');
                }}
                className="flex items-center justify-center p-1.5 rounded-lg bg-slate-900 border border-emerald-500/20 text-emerald-400 hover:bg-slate-850 hover:text-rose-400 transition-colors cursor-pointer"
                title="Click to lock chat"
              >
                <Unlock className="w-4 h-4" />
              </button>
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-rose-400 font-medium px-2 py-1 bg-rose-500/10 border border-rose-500/20 rounded-lg animate-pulse">
              <Lock className="w-3.5 h-3.5" />
              <span className="text-[10px] uppercase font-semibold tracking-wider">Locked</span>
            </div>
          )}
        </div>
      </div>

      {/* Chat Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-slate-900/40 relative flex flex-col justify-between">
        {!passphrase ? (
          <div className="flex-1 flex items-center justify-center py-6 animate-fadeIn">
            <div className="w-full max-w-xs bg-slate-950/60 border border-slate-800/80 rounded-2xl p-5 shadow-2xl backdrop-blur-sm flex flex-col items-center">
              <div className="inline-flex p-3 rounded-full bg-slate-900 border border-slate-800 text-amber-500 mb-2">
                <Lock className="w-6 h-6 animate-pulse" />
              </div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">E2E Cryptographic Vault</h3>
              <p className="text-[11px] text-slate-400 text-center mt-1 mb-4 leading-relaxed">
                Enter a shared secret passcode to encrypt & decrypt this conversation.
              </p>

              {/* Display Panel */}
              <div className="w-full relative mb-4">
                <input
                  type={showTempPassphrase ? 'text' : 'password'}
                  value={tempPassphrase}
                  onChange={(e) => setTempPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tempPassphrase) {
                      e.preventDefault();
                      setPassphrase(tempPassphrase);
                      setErrorMsg('');
                    }
                  }}
                  placeholder="Enter passcode..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-center font-mono text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500 tracking-widest"
                />
                <button
                  type="button"
                  onClick={() => setShowTempPassphrase(!showTempPassphrase)}
                  className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  {showTempPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Keypad Grid */}
              <div className="grid grid-cols-3 gap-2.5 w-full mb-4">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setTempPassphrase(prev => prev + num)}
                    className="w-11 h-11 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200 hover:text-amber-400 font-bold text-sm flex items-center justify-center border border-slate-800/80 hover:border-slate-700 transition-all active:scale-90 shadow-sm cursor-pointer mx-auto"
                  >
                    {num}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setTempPassphrase('')}
                  className="w-11 h-11 rounded-full bg-slate-900/40 hover:bg-slate-900 text-slate-500 hover:text-rose-450 text-[10px] font-semibold flex items-center justify-center transition-colors cursor-pointer mx-auto"
                >
                  CLEAR
                </button>
                <button
                  type="button"
                  onClick={() => setTempPassphrase(prev => prev + '0')}
                  className="w-11 h-11 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200 hover:text-amber-400 font-bold text-sm flex items-center justify-center border border-slate-800/80 hover:border-slate-700 transition-all active:scale-90 shadow-sm cursor-pointer mx-auto"
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={() => setTempPassphrase(prev => prev.slice(0, -1))}
                  className="w-11 h-11 rounded-full bg-slate-900/40 hover:bg-slate-900 text-slate-500 hover:text-amber-450 flex items-center justify-center transition-colors cursor-pointer mx-auto"
                  title="Backspace"
                >
                  ⌫
                </button>
              </div>

              {/* Submit button */}
              <button
                type="button"
                disabled={!tempPassphrase}
                onClick={() => {
                  setPassphrase(tempPassphrase);
                  setErrorMsg('');
                }}
                className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800/80 disabled:text-slate-600 text-slate-950 font-bold py-2.5 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-all duration-150 shadow-md active:scale-95 cursor-pointer text-xs"
              >
                <Unlock className="w-3.5 h-3.5" />
                <span>Unlock & Decrypt Chat</span>
              </button>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3 p-8 animate-fadeIn">
            <Lock className="w-12 h-12 text-slate-600 animate-pulse" />
            <div className="max-w-xs">
              <p className="text-slate-300 font-medium text-sm">No Messages Yet</p>
              <p className="text-xs text-slate-500 leading-relaxed">
                Send your first message! Type below or enter a room passcode above to encrypt with E2EE.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 w-full flex-1">
            {messages.map((msg) => {
              const isMe = msg.senderId === currentUser.uid;
              const decryptedText = decryptedMessages[msg.id];
              const isLockError = decryptedText?.includes('🔒 [Decryption Failed');
              const readByList = msg.readBy || [];
              const otherReaders = readByList.filter((id) => id !== msg.senderId);
              const isReadByOthers = otherReaders.length > 0;
              const allRead = msg.isRead || (chat.participantIds.length > 0 && chat.participantIds.every((id) => readByList.includes(id)));
              
              const readerNames = readByList
                .map((id) => (id === currentUser.uid ? 'You' : usersMap[id]?.displayName || 'User'))
                .join(', ');

              const parsedPayload = parseDecryptedMessage(decryptedText);

              return (
                <div key={msg.id} className={`flex items-start gap-2.5 group/msg ${isMe ? 'justify-end' : 'justify-start'}`}>
                  {/* Sender Avatar */}
                  {!isMe && (
                    <img
                      src={msg.senderPhoto || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(msg.senderName)}`}
                      alt={msg.senderName}
                      className="w-8 h-8 rounded-full border border-slate-800 object-cover mt-0.5"
                      referrerPolicy="no-referrer"
                    />
                  )}

                  {/* Message Bubble container */}
                  <div className={`flex flex-col max-w-[70%] ${isMe ? 'items-end' : 'items-start'}`}>
                    {/* Sender Name / Time */}
                    <div className="flex items-center gap-2 mb-1 px-1">
                      <span className="text-xs font-medium text-slate-300">
                        {isMe ? 'You' : msg.senderName}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {formatMessageTime(msg.timestamp)}
                      </span>
                      {isMe && (
                        <span className="flex items-center ml-0.5 cursor-help" title={isReadByOthers ? `Read by: ${readerNames}` : 'Sent'}>
                          {allRead || isReadByOthers ? (
                            <CheckCheck className="w-3.5 h-3.5 text-amber-400" />
                          ) : (
                            <Check className="w-3.5 h-3.5 text-slate-500" />
                          )}
                        </span>
                      )}
                    </div>

                    {/* Message Bubble payload */}
                    <div
                      className={`rounded-2xl px-4 py-2.5 text-sm shadow-md transition-all ${
                        isMe
                          ? 'bg-amber-600 text-slate-50 rounded-tr-none'
                          : 'bg-slate-800 text-slate-100 rounded-tl-none'
                      }`}
                    >
                      {msg.replyToId && (
                        <div className="bg-slate-950/45 border-l-2 border-amber-500/70 px-2 py-1.5 rounded-lg text-[11px] mb-2 truncate max-w-full text-left opacity-90 flex flex-col">
                          <span className="text-[9px] text-amber-400 font-bold uppercase tracking-wider">
                            Replying to {msg.replyToSenderName}
                          </span>
                          <span className="text-slate-300 truncate mt-0.5 max-w-[180px] sm:max-w-[240px] block font-mono text-[10px] bg-slate-950/20 px-1 py-0.5 rounded">
                            {msg.replyToText}
                          </span>
                        </div>
                      )}

                      {isLockError ? (
                        <div className="flex items-center gap-1.5 text-rose-450 text-xs italic font-mono">
                          <ShieldAlert className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                          <span>Decryption failed. Bad passcode.</span>
                        </div>
                      ) : parsedPayload.isImage ? (
                        <div className="space-y-2">
                          <div className="relative group/img overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/40">
                            <img
                              src={parsedPayload.imageUrl!}
                              alt="Decrypted encrypted attachment"
                              className="max-h-64 sm:max-h-80 w-auto rounded-xl object-contain cursor-pointer hover:opacity-95 transition-opacity"
                              onClick={() => setExpandedImageUrl(parsedPayload.imageUrl)}
                            />
                            <button
                              type="button"
                              onClick={() => setExpandedImageUrl(parsedPayload.imageUrl)}
                              className="absolute bottom-2 right-2 p-1.5 bg-slate-900/80 hover:bg-slate-900 text-slate-200 rounded-lg backdrop-blur-md opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center gap-1 text-[10px] font-medium border border-slate-700 cursor-pointer"
                            >
                              <Maximize2 className="w-3 h-3" />
                              <span>View</span>
                            </button>
                          </div>
                          {parsedPayload.text && (
                            <p className="whitespace-pre-wrap break-words">{parsedPayload.text}</p>
                          )}
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{decryptedText || msg.previewText}</p>
                      )}
                    </div>
                  </div>

                  {/* Action Buttons on Hover */}
                  <div className={`flex items-center gap-1 self-center opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 ${isMe ? 'order-first' : 'order-last'}`}>
                    <button
                      type="button"
                      onClick={() => {
                        const replyText = parsedPayload.isImage
                          ? (parsedPayload.text ? `📷 Photo: ${parsedPayload.text}` : '📷 Shared image')
                          : (decryptedText || msg.previewText);
                        setReplyingTo({
                          id: msg.id,
                          senderName: isMe ? 'You' : msg.senderName,
                          text: replyText
                        });
                      }}
                      className="p-1.5 rounded-full text-slate-500 hover:text-amber-500 hover:bg-slate-800 cursor-pointer transition-colors"
                      title="Reply to this message"
                    >
                      <CornerUpLeft className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteMessage(msg.id)}
                      className="p-1.5 rounded-full text-slate-500 hover:text-rose-400 hover:bg-slate-800 cursor-pointer transition-colors"
                      title="Delete message"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form Footer */}
      <div className="p-4 bg-slate-950 border-t border-slate-800">
        {errorMsg && (
          <div className="mb-2 text-xs font-medium text-amber-500 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 animate-fadeIn">
            <ShieldAlert className="w-4 h-4" />
            <span>{errorMsg}</span>
          </div>
        )}

        {selectedImage && (
          <div className="mb-2.5 flex items-center justify-between bg-slate-900 border border-slate-800 p-2 rounded-xl text-xs animate-fadeIn">
            <div className="flex items-center gap-2 min-w-0 pr-2">
              <img
                src={selectedImage.dataUrl}
                alt="Preview"
                className="w-10 h-10 rounded-lg object-cover border border-slate-700 shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] text-amber-500 font-bold uppercase tracking-wider flex items-center gap-1">
                  <ImageIcon className="w-3 h-3" /> Encrypted Image Attachment
                </span>
                <span className="text-slate-300 truncate text-[11px] mt-0.5 max-w-[200px]">
                  {selectedImage.name}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedImage(null)}
              className="p-1 text-slate-500 hover:text-slate-300 rounded-full hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
              title="Remove image attachment"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {replyingTo && (
          <div className="mb-2.5 flex items-center justify-between bg-slate-900 border-l-2 border-amber-500 px-3 py-2 rounded-lg text-xs animate-fadeIn">
            <div className="flex flex-col min-w-0 pr-4">
              <span className="text-[10px] text-amber-500 font-bold uppercase tracking-wider">
                Replying to {replyingTo.senderName}
              </span>
              <span className="text-slate-300 truncate text-[11px] mt-0.5">
                {replyingTo.text}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="p-1 text-slate-500 hover:text-slate-300 rounded-full hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
              title="Cancel Reply"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        
        {/* Hidden File Picker */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageSelect}
        />

        <form onSubmit={handleSendMessage} className="flex gap-2">
          <button
            type="button"
            disabled={!passphrase || isProcessingImage}
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-amber-400 rounded-xl transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shrink-0 cursor-pointer"
            title="Attach encrypted image"
          >
            {isProcessingImage ? (
              <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
            ) : (
              <ImageIcon className="w-4 h-4" />
            )}
          </button>

          <input
            type="text"
            value={inputText}
            onChange={handleInputChange}
            disabled={!passphrase}
            placeholder={
              passphrase
                ? selectedImage
                  ? "Add an optional image caption..."
                  : "Type an E2E encrypted message..."
                : "🔒 Room is locked. Enter passcode above to chat..."
            }
            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />

          <button
            type="submit"
            disabled={!passphrase || (!inputText.trim() && !selectedImage)}
            className="bg-amber-600 text-slate-950 font-medium px-4 py-2 rounded-xl flex items-center justify-center gap-1 hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 shrink-0 cursor-pointer"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Fullscreen Decrypted Image Lightbox Modal */}
      {expandedImageUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setExpandedImageUrl(null)}
        >
          <div className="relative max-w-4xl w-full max-h-[90vh] flex flex-col items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <div className="absolute -top-12 right-0 flex items-center gap-2">
              <a
                href={expandedImageUrl}
                download="encrypted-attachment.jpg"
                className="p-2 bg-slate-800/80 hover:bg-slate-800 text-slate-200 rounded-lg border border-slate-700 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download</span>
              </a>
              <button
                type="button"
                onClick={() => setExpandedImageUrl(null)}
                className="p-2 bg-slate-800/80 hover:bg-slate-800 text-slate-200 rounded-lg border border-slate-700 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <img
              src={expandedImageUrl}
              alt="Expanded decrypted attachment"
              className="max-h-[85vh] max-w-full rounded-2xl object-contain border border-slate-800 shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
