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
  const [showKeypad, setShowKeypad] = useState(true);

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

  const handleApplyKey = () => {
    setPassphrase(tempPassphrase);
    setErrorMsg('');
    if (tempPassphrase) {
      setShowKeypad(false);
    }
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

      {/* Security Key Vault Banner with Top Passcode Field & Apply Key */}
      <div className="bg-[#0b101a] border-b border-slate-800/80 p-3 flex flex-col gap-2 shadow-lg">
        <div className="flex items-center gap-2">
          {/* Main Passcode Input Field */}
          <div className="relative flex-1">
            <input
              type={showTempPassphrase ? 'text' : 'password'}
              value={tempPassphrase}
              onChange={(e) => setTempPassphrase(e.target.value)}
              onFocus={() => setShowKeypad(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tempPassphrase) {
                  e.preventDefault();
                  handleApplyKey();
                }
              }}
              placeholder="Enter room E2EE passcode..."
              className="w-full bg-[#131b2e] border border-amber-500/50 rounded-xl px-3.5 py-2.5 text-slate-100 placeholder-slate-500 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500 pr-9 shadow-inner"
            />
            <button
              type="button"
              onClick={() => setShowTempPassphrase(!showTempPassphrase)}
              className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
              title={showTempPassphrase ? "Hide passcode" : "Show passcode"}
            >
              {showTempPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Apply Key Button */}
          <button
            type="button"
            onClick={handleApplyKey}
            disabled={!tempPassphrase && !passphrase}
            className="bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold px-4 py-2.5 rounded-xl text-xs transition-all shadow-md active:scale-95 cursor-pointer shrink-0"
          >
            Apply Key
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 px-0.5">
          <span>Passcodes are strictly computed in browser memory (AES-GCM 256) and never sent to servers.</span>
          <button
            type="button"
            onClick={() => setShowKeypad(!showKeypad)}
            className="text-amber-400 hover:text-amber-300 font-medium cursor-pointer flex items-center gap-1 ml-2 shrink-0 hover:underline"
          >
            <Key className="w-3.5 h-3.5" />
            <span>{showKeypad ? 'Hide Keypad' : 'Keypad'}</span>
          </button>
        </div>

        {/* Number Style Lock Pad Drawer / Overlay */}
        {showKeypad && (
          <div className="mt-1 p-4 bg-[#111827] border border-slate-800 rounded-2xl shadow-2xl max-w-xs mx-auto w-full animate-fadeIn flex flex-col items-center">
            {/* Display / Status */}
            <div className="w-full text-center mb-3">
              <span className="text-[11px] font-mono text-amber-400 font-semibold uppercase tracking-wider">
                {passphrase ? '● Key Active (Tap digits to change)' : 'Enter PIN or custom passcode'}
              </span>
            </div>

            {/* Circular Digits Grid (1-9, C, 0, ⌫) */}
            <div className="grid grid-cols-3 gap-3 w-full max-w-[240px] mb-4">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setTempPassphrase((prev) => prev + num)}
                  className="w-12 h-12 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-100 hover:text-amber-400 font-extrabold text-base flex items-center justify-center border border-slate-800 hover:border-amber-500/40 transition-all active:scale-95 shadow-md cursor-pointer mx-auto"
                >
                  {num}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setTempPassphrase('')}
                className="w-12 h-12 rounded-full bg-slate-900/50 hover:bg-slate-900 text-slate-400 hover:text-rose-400 text-xs font-bold flex items-center justify-center border border-slate-800/50 transition-colors cursor-pointer mx-auto"
                title="Clear input"
              >
                CLEAR
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev + '0')}
                className="w-12 h-12 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-100 hover:text-amber-400 font-extrabold text-base flex items-center justify-center border border-slate-800 hover:border-amber-500/40 transition-all active:scale-95 shadow-md cursor-pointer mx-auto"
              >
                0
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev.slice(0, -1))}
                className="w-12 h-12 rounded-full bg-slate-900/50 hover:bg-slate-900 text-slate-400 hover:text-amber-400 text-sm flex items-center justify-center border border-slate-800/50 transition-colors cursor-pointer mx-auto"
                title="Delete digit"
              >
                ⌫
              </button>
            </div>

            {/* Confirm / Apply Key button inside keypad */}
            <button
              type="button"
              onClick={handleApplyKey}
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-lg active:scale-95 cursor-pointer"
            >
              <Unlock className="w-3.5 h-3.5" />
              <span>Apply Key & Decrypt Chat</span>
            </button>
          </div>
        )}
      </div>

      {/* Chat Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-slate-900/40 relative flex flex-col justify-between">
        {messages.length === 0 ? (
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
    }export default function ChatWindow({ chat, currentUser, usersMap, onEmergencyLock, onBack }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  const [tempPassphrase, setTempPassphrase] = useState('');
  const [showTempPassphrase, setShowTempPassphrase] = useState(false);
  const [showKeypad, setShowKeypad] = useState(true);

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
        // Fallback
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

  const handleApplyKey = () => {
    setPassphrase(tempPassphrase);
    setErrorMsg('');
    if (tempPassphrase) {
      setShowKeypad(false);
    }
  };

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

  const handleDeleteMessage = async (messageId: string) => {
    try {
      const msgRef = doc(db, 'chats', chat.id, 'messages', messageId);
      await deleteDoc(msgRef);
    } catch (error) {
      console.error('Failed to delete message:', error);
      setErrorMsg('Failed to delete message. Please try again.');
    }
  };

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
      {/* Header */}
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
      <div className="bg-[#0b101a] border-b border-slate-800/80 p-3 flex flex-col gap-2 shadow-lg">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showTempPassphrase ? 'text' : 'password'}
              value={tempPassphrase}
              onChange={(e) => setTempPassphrase(e.target.value)}
              onFocus={() => setShowKeypad(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tempPassphrase) {
                  e.preventDefault();
                  handleApplyKey();
                }
              }}
              placeholder="Enter room E2EE passcode..."
              className="w-full bg-[#131b2e] border border-amber-500/50 rounded-xl px-3.5 py-2.5 text-slate-100 placeholder-slate-500 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500 pr-9 shadow-inner"
            />
            <button
              type="button"
              onClick={() => setShowTempPassphrase(!showTempPassphrase)}
              className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
              title={showTempPassphrase ? "Hide passcode" : "Show passcode"}
            >
              {showTempPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <button
            type="button"
            onClick={handleApplyKey}
            disabled={!tempPassphrase && !passphrase}
            className="bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold px-4 py-2.5 rounded-xl text-xs transition-all shadow-md active:scale-95 cursor-pointer shrink-0"
          >
            Apply Key
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 px-0.5">
          <span>Passcodes are strictly computed in browser memory (AES-GCM 256) and never sent to servers.</span>
          <button
            type="button"
            onClick={() => setShowKeypad(!showKeypad)}
            className="text-amber-400 hover:text-amber-300 font-medium cursor-pointer flex items-center gap-1 ml-2 shrink-0 hover:underline"
          >
            <Key className="w-3.5 h-3.5" />
            <span>{showKeypad ? 'Hide Keypad' : 'Keypad'}</span>
          </button>
        </div>

        {/* Number Keypad Drawer */}
        {showKeypad && (
          <div className="mt-1 p-4 bg-[#111827] border border-slate-800 rounded-2xl shadow-2xl max-w-xs mx-auto w-full animate-fadeIn flex flex-col items-center">
            <div className="w-full text-center mb-3">
              <span className="text-[11px] font-mono text-amber-400 font-semibold uppercase tracking-wider">
                {passphrase ? '● Key Active (Tap digits to change)' : 'Enter PIN or custom passcode'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 w-full max-w-[240px] mb-4">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setTempPassphrase((prev) => prev + num)}
                  className="w-12 h-12 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-100 hover:text-amber-400 font-extrabold text-base flex items-center justify-center border border-slate-800 hover:border-amber-500/40 transition-all active:scale-95 shadow-md cursor-pointer mx-auto"
                >
                  {num}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setTempPassphrase('')}
                className="w-12 h-12 rounded-full bg-slate-900/50 hover:bg-slate-900 text-slate-400 hover:text-rose-400 text-xs font-bold flex items-center justify-center border border-slate-800/50 transition-colors cursor-pointer mx-auto"
                title="Clear input"
              >
                CLEAR
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev + '0')}
                className="w-12 h-12 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-100 hover:text-amber-400 font-extrabold text-base flex items-center justify-center border border-slate-800 hover:border-amber-500/40 transition-all active:scale-95 shadow-md cursor-pointer mx-auto"
              >
                0
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev.slice(0, -1))}
                className="w-12 h-12 rounded-full bg-slate-900/50 hover:bg-slate-900 text-slate-400 hover:text-amber-400 text-sm flex items-center justify-center border border-slate-800/50 transition-colors cursor-pointer mx-auto"
                title="Delete digit"
              >
                ⌫
              </button>
            </div>

            <button
              type="button"
              onClick={handleApplyKey}
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-lg active:scale-95 cursor-pointer"
            >
              <Unlock className="w-3.5 h-3.5" />
              <span>Apply Key & Decrypt Chat</span>
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 bg-slate-900/40 relative flex flex-col justify-between">
        {messages.length === 0 ? (
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
                  {!isMe && (
                    <img
                      src={msg.senderPhoto || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(msg.senderName)}`}
                      alt={msg.senderName}
                      className="w-8 h-8 rounded-full border border-slate-800 object-cover mt-0.5"
                      referrerPolicy="no-referrer"
                    />
                  )}

                  <div className={`flex flex-col max-w-[70%] ${isMe ? 'items-end' : 'items-start'}`}>
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

      {/* Input */}
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

      {/* Lightbox */}
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
                }import { processImageFile } from '../lib/imageUtils';
import { formatMessageTime, formatRelativeTime } from '../lib/dateUtils';
import { ChatRoom, ChatMessage, UserProfile } from '../types';
import PresenceStatus from './PresenceStatus';

interface ChatWindowProps {
  chat: ChatRoom;
  currentUser: UserProfile;
  usersMap: Record<string, UserProfile>;
  onEmergencyLock: () => void;
  onBack: () => void;
}

export default function ChatWindow({
  chat,
  currentUser,
  usersMap,
  onEmergencyLock,
  onBack
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [decryptedTexts, setDecryptedTexts] = useState<Record<string, string>>({});
  
  // E2EE Passphrase state (Volatile memory only)
  const [passphrase, setPassphrase] = useState('');
  const [tempPassphrase, setTempPassphrase] = useState('');
  const [showTempPassphrase, setShowTempPassphrase] = useState(false);
  const [showKeypad, setShowKeypad] = useState(true);
  const [keyFingerprint, setKeyFingerprint] = useState('');

  // Compute key verification fingerprint (SHA-256) when active passphrase changes
  useEffect(() => {
    if (!passphrase) {
      setKeyFingerprint('');
      return;
    }
    getPasscodeFingerprint(passphrase).then(fp => setKeyFingerprint(fp));
  }, [passphrase]);

  const [replyingTo, setReplyingTo] = useState<{ id: string; senderName: string; text: string } | null>(null);
  
  // Media / Attachment states
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [ephemeralHours, setEphemeralHours] = useState<number>(0); // 0 = off

  // Status & Error indicators
  const [errorMsg, setErrorMsg] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [decryptionStatus, setDecryptionStatus] = useState<'idle' | 'success' | 'failed'>('idle');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, decryptedTexts]);

  // 1. Subscribe to real-time messages & update read receipts
  useEffect(() => {
    if (!chat.id) return;

    const messagesPath = `chats/${chat.id}/messages`;
    const q = query(
      collection(db, messagesPath),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgList: ChatMessage[] = [];
        const batch = writeBatch(db);
        let hasUpdatesToRead = false;

        snapshot.docs.forEach((d) => {
          const data = d.data() as Omit<ChatMessage, 'id'>;
          const msgObj: ChatMessage = { id: d.id, ...data };
          msgList.push(msgObj);

          // Mark message as read if current user hasn't marked it yet
          if (currentUser?.uid && data.senderId !== currentUser.uid) {
            const readBy = data.readBy || [];
            if (!readBy.includes(currentUser.uid)) {
              const msgRef = doc(db, messagesPath, d.id);
              batch.update(msgRef, {
                readBy: arrayUnion(currentUser.uid)
              });
              hasUpdatesToRead = true;
            }
          }
        });

        if (hasUpdatesToRead) {
          batch.commit().catch((err) => {
            console.error('Error updating read receipts:', err);
          });
        }

        setMessages(msgList);
      },
      (error) => {
        handleFirestoreError(error, OperationType.READ, messagesPath);
      }
    );

    return () => unsubscribe();
  }, [chat.id, currentUser?.uid]);

  // 2. Decrypt messages whenever passphrase or messages change
  useEffect(() => {
    if (!passphrase) {
      setDecryptedTexts({});
      setDecryptionStatus('idle');
      return;
    }

    let failCount = 0;
    let successCount = 0;
    const newDecrypted: Record<string, string> = {};

    const decryptAll = async () => {
      for (const msg of messages) {
        if (!msg.ciphertext || !msg.iv || !msg.mac) continue;

        try {
          const payload: EncryptedPayload = {
            ciphertext: msg.ciphertext,
            iv: msg.iv,
            mac: msg.mac
          };
          const plainText = await decryptMessage(payload, passphrase);
          newDecrypted[msg.id] = plainText;
          successCount++;
        } catch {
          failCount++;
        }
      }

      setDecryptedTexts(newDecrypted);
      if (failCount > 0 && successCount === 0 && messages.length > 0) {
        setDecryptionStatus('failed');
      } else if (successCount > 0) {
        setDecryptionStatus('success');
      }
    };

    decryptAll();
  }, [messages, passphrase]);

  // Handle typing indicator updates
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value);

    if (!currentUser) return;

    // Set typing = true
    const chatRef = doc(db, 'chats', chat.id);
    updateDoc(chatRef, {
      [`typing.${currentUser.uid}`]: true
    }).catch(() => {});

    // Clear previous timeout
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    // Stop typing after 2.5 seconds of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      updateDoc(chatRef, {
        [`typing.${currentUser.uid}`]: false
      }).catch(() => {});
    }, 2500);
  };

  // Image File selection
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Clear selected image
  const handleClearImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Send Encrypted Message
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!passphrase) {
      setErrorMsg('Please set or apply an encryption passcode first!');
      return;
    }

    if (!inputText.trim() && !selectedImage) return;

    setIsSending(true);
    setErrorMsg('');

    try {
      let processedBase64Image: string | undefined = undefined;

      if (selectedImage) {
        processedBase64Image = await processImageFile(selectedImage);
      }

      // Encrypt the message text
      const textToEncrypt = inputText.trim() || '[Attached Image]';
      const encrypted = await encryptMessage(textToEncrypt, passphrase);

      let imageURL: string | undefined = undefined;
      if (processedBase64Image) {
        imageURL = processedBase64Image;
      }

      // Calculate expiration timestamp if ephemeral mode is active
      let expiresAt = null;
      if (ephemeralHours > 0) {
        const now = new Date();
        expiresAt = new Date(now.getTime() + ephemeralHours * 3600 * 1000);
      }

      const messagesPath = `chats/${chat.id}/messages`;
      
      const newMsgData: Omit<ChatMessage, 'id'> = {
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Anonymous',
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        mac: encrypted.mac,
        timestamp: serverTimestamp(),
        readBy: [currentUser.uid],
        ...(replyingTo && { replyTo: replyingTo }),
        ...(imageURL && { imageURL }),
        ...(ephemeralHours > 0 && { ephemeralHours, expiresAt })
      };

      await addDoc(collection(db, messagesPath), newMsgData);

      // Update Chat Room's lastMessage
      const chatRef = doc(db, 'chats', chat.id);
      await updateDoc(chatRef, {
        updatedAt: serverTimestamp(),
        lastMessage: {
          text: '[Encrypted Cypher Message]',
          senderId: currentUser.uid,
          timestamp: serverTimestamp()
        },
        [`typing.${currentUser.uid}`]: false
      });

      // Clear input state
      setInputText('');
      setReplyingTo(null);
      handleClearImage();

    } catch (err: any) {
      console.error('Failed to send encrypted message:', err);
      setErrorMsg(err.message || 'Error encrypting message. Check passcode.');
    } finally {
      setIsSending(false);
    }
  };

  // Determine participant details for title bar
  const otherParticipantId = chat.type === 'direct'
    ? chat.participants.find(id => id !== currentUser.uid)
    : null;
  const otherUser = otherParticipantId ? usersMap[otherParticipantId] : null;

  // Check if someone else is typing
  const typingUsers = chat.typing
    ? Object.entries(chat.typing)
        .filter(([uid, isTyping]) => uid !== currentUser.uid && isTyping)
        .map(([uid]) => usersMap[uid]?.displayName || 'Someone')
    : [];

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 relative overflow-hidden select-none">
      
      {/* Top Bar Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900/90 border-b border-slate-800 backdrop-blur-md z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="md:hidden p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {chat.type === 'direct' && otherUser ? (
            <PresenceStatus user={otherUser} showDetails={true} />
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center font-bold text-amber-400 text-sm">
                {chat.name ? chat.name[0].toUpperCase() : 'G'}
              </div>
              <div>
                <h3 className="font-semibold text-sm text-slate-100 leading-tight">{chat.name || 'Group Chat'}</h3>
                <p className="text-[10px] text-slate-400">{chat.participants.length} members</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Emergency Lock / Panic Button */}
          <button
            onClick={onEmergencyLock}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-950/80 border border-rose-500/40 text-rose-300 hover:bg-rose-900 transition-all text-xs font-semibold cursor-pointer shadow-lg shadow-rose-950/50"
            title="Instant Panic Wipe - Clears key and exits chat"
          >
            <Lock className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
            <span className="hidden sm:inline">Emergency Lock</span>
          </button>
        </div>
      </div>

      {/* Passcode & Keypad Security Vault Toolbar */}
      <div className="bg-slate-900/95 border-b border-slate-800 p-3 z-10 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="relative flex-1 max-w-sm">
            <Key className="w-4 h-4 text-amber-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type={showTempPassphrase ? "text" : "password"}
              value={tempPassphrase}
              onChange={(e) => setTempPassphrase(e.target.value)}
              placeholder="Enter PIN or Custom Key..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-9 py-2 text-xs font-mono text-amber-300 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowTempPassphrase(!showTempPassphrase)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            >
              {showTempPassphrase ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              if (!tempPassphrase) {
                setErrorMsg('Enter a key first!');
                return;
              }
              setPassphrase(tempPassphrase);
              setErrorMsg('');
            }}
            className="bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold px-4 py-2 rounded-xl text-xs transition-colors cursor-pointer shrink-0 shadow-md shadow-amber-950/30"
          >
            Apply Key
          </button>

          {/* Lock Vault / Wipe Active Key Button */}
          {passphrase && (
            <button
              type="button"
              onClick={() => {
                setPassphrase('');
                setTempPassphrase('');
                setErrorMsg('');
              }}
              className="bg-rose-950/80 hover:bg-rose-900 border border-rose-500/30 text-rose-300 font-semibold px-3 py-2 rounded-xl text-xs transition-all active:scale-95 cursor-pointer shrink-0 flex items-center gap-1"
              title="Lock Vault: Instantly wipe active key from browser memory"
            >
              <Lock className="w-3.5 h-3.5 text-rose-400" />
              <span>Lock Vault</span>
            </button>
          )}
        </div>

        {/* Security Info & Fingerprint Badge */}
        <div className="flex flex-wrap items-center justify-between text-[11px] text-slate-400 px-0.5 gap-2">
          {keyFingerprint ? (
            <div className="flex items-center gap-1.5 bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 px-2.5 py-1 rounded-lg font-mono">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>Fingerprint: <strong>{keyFingerprint}</strong></span>
              <span className="text-[10px] text-emerald-500 hidden sm:inline ml-1">(Both members check code to verify)</span>
            </div>
          ) : (
            <span>Passcodes are strictly computed in browser memory (AES-GCM 256) and never sent to servers.</span>
          )}

          <button
            type="button"
            onClick={() => setShowKeypad(!showKeypad)}
            className="text-amber-400 hover:text-amber-300 font-medium cursor-pointer flex items-center gap-1 ml-auto shrink-0 hover:underline"
          >
            <Key className="w-3.5 h-3.5" />
            <span>{showKeypad ? 'Hide Keypad' : 'Keypad'}</span>
          </button>
        </div>

        {/* PIN Pad Toggle Box */}
        {showKeypad && (
          <div className="bg-slate-950/90 border border-slate-800/80 rounded-xl p-3 flex flex-col items-center">
            <div className="w-full text-center mb-2">
              <span className="text-[10px] font-mono text-amber-400 font-semibold uppercase tracking-wider">
                {passphrase ? '● Key Active (Tap digits or Lock Vault)' : 'Enter PIN or custom passcode'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2.5 w-full max-w-[220px] mb-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setTempPassphrase((prev) => prev + num)}
                  className="w-10 h-10 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200 text-sm font-semibold flex items-center justify-center border border-slate-800 transition-colors cursor-pointer mx-auto"
                >
                  {num}
                </button>
              ))}

              <button
                type="button"
                onClick={() => {
                  setTempPassphrase('');
                  setPassphrase('');
                }}
                className="w-10 h-10 rounded-full bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 text-[9px] font-extrabold flex flex-col items-center justify-center border border-rose-800/40 transition-colors cursor-pointer mx-auto"
                title="Lock Vault & Wipe memory key"
              >
                <Lock className="w-3 h-3 mb-0.5" />
                <span>LOCK</span>
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev + '0')}
                className="w-10 h-10 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200 text-sm font-semibold flex items-center justify-center border border-slate-800 transition-colors cursor-pointer mx-auto"
              >
                0
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev.slice(0, -1))}
                className="w-10 h-10 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs font-semibold flex items-center justify-center border border-slate-800 transition-colors cursor-pointer mx-auto"
                title="Backspace"
              >
                ⌫
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Chat Messages Display Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-slate-800">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
            <ShieldCheck className="w-12 h-12 mb-3 text-amber-500/40" />
            <p className="text-sm font-medium text-slate-400">Zero-Knowledge Encrypted Stream</p>
            <p className="text-xs text-slate-600 max-w-xs mt-1">
              Messages are encrypted end-to-end on device. Set matching passcodes to decrypt messages.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUser.uid;
            const decryptedText = decryptedTexts[msg.id];
            const isDecrypted = Boolean(decryptedText);

            // Calculate Read Receipts: double check if read by all participants (excluding sender)
            const otherParticipants = chat.participants.filter(pId => pId !== msg.senderId);
            const readByList = msg.readBy || [];
            const isReadByAll = otherParticipants.length > 0 && otherParticipants.every(pId => readByList.includes(pId));

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} group`}
              >
                <div
                  className={`max-w-[85%] sm:max-w-[70%] rounded-2xl p-3.5 relative transition-all shadow-md ${
                    isMe
                      ? 'bg-amber-600/90 text-slate-950 font-medium rounded-tr-none border border-amber-500/40'
                      : 'bg-slate-900 text-slate-100 rounded-tl-none border border-slate-800'
                  }`}
                >
                  {/* Sender Name */}
                  {!isMe && (
                    <p className="text-[10px] font-bold text-amber-400 mb-1 font-mono">
                      {msg.senderName}
                    </p>
                  )}

                  {/* Quoted Reply Block */}
                  {msg.replyTo && (
                    <div className={`text-[11px] p-2 rounded-lg mb-2 border-l-2 font-mono ${
                      isMe ? 'bg-amber-700/30 border-slate-950 text-slate-900' : 'bg-slate-950 border-amber-500 text-slate-300'
                    }`}>
                      <p className="font-bold text-[10px]">{msg.replyTo.senderName}</p>
                      <p className="truncate text-[10px]">{msg.replyTo.text}</p>
                    </div>
                  )}

                  {/* Image Attachment */}
                  {msg.imageURL && (
                    <div className="mb-2 rounded-xl overflow-hidden border border-slate-950/20 max-h-60 bg-black/40">
                      <img
                        src={msg.imageURL}
                        alt="Cypher Attachment"
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  )}

                  {/* Message Content */}
                  <div className="text-xs sm:text-sm leading-relaxed break-words font-sans">
                    {isDecrypted ? (
                      <span>{decryptedText}</span>
                    ) : (
                      <div className="flex items-center gap-1.5 opacity-80 font-mono text-[11px]">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span className="italic">
                          {passphrase ? '[Decryption Failed - Wrong Key]' : '[Encrypted Message - Enter Key]'}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Footer Meta: Time, Self-Destruct, Read Receipts */}
                  <div className={`flex items-center justify-end gap-1.5 mt-2 text-[10px] font-mono ${
                    isMe ? 'text-slate-950/80' : 'text-slate-500'
                  }`}>
                    {msg.ephemeralHours && (
                      <span className="flex items-center gap-0.5 text-rose-400 font-bold" title="Self-destruct timer enabled">
                        <Clock className="w-3 h-3" />
                        <span>{msg.ephemeralHours}h</span>
                      </span>
                    )}

                    <span>{formatMessageTime(msg.timestamp)}</span>

                    {/* Read Receipt Double Check Indicator */}
                    {isMe && (
                      <span title={isReadByAll ? "Seen by participant(s)" : "Sent (Unread)"}>
                        {isReadByAll ? (
                          <CheckCheck className="w-3.5 h-3.5 text-sky-950 font-bold" />
                        ) : (
                          <Check className="w-3.5 h-3.5 text-slate-950/70" />
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* Message Quick Action Menu */}
                <button
                  type="button"
                  onClick={() => setReplyingTo({
                    id: msg.id,
                    senderName: msg.senderName,
                    text: isDecrypted ? decryptedText : '[Encrypted Content]'
                  })}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-slate-500 hover:text-amber-400 mt-1 flex items-center gap-1 cursor-pointer"
                >
                  <CornerUpLeft className="w-3 h-3" />
                  <span>Reply</span>
                </button>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing Indicator Bar */}
      {typingUsers.length > 0 && (
        <div className="px-4 py-1 bg-slate-900/40 text-[10px] text-amber-400 font-mono flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
          <span>{typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing encrypted cypher...</span>
        </div>
      )}

      {/* Error Banner */}
      {errorMsg && (
        <div className="px-4 py-2 bg-rose-950/80 border-t border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg('')} className="text-rose-400 hover:text-rose-200">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Quoted Reply Preview Header */}
      {replyingTo && (
        <div className="px-4 py-2 bg-slate-900 border-t border-slate-800 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 overflow-hidden">
            <CornerUpLeft className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <div className="truncate">
              <span className="font-semibold text-slate-300">{replyingTo.senderName}: </span>
              <span className="text-slate-400 italic">{replyingTo.text}</span>
            </div>
          </div>
          <button onClick={() => setReplyingTo(null)} className="text-slate-500 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Image Attachment Preview Header */}
      {imagePreview && (
        <div className="px-4 py-2 bg-slate-900 border-t border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-lg overflow-hidden border border-slate-700 bg-black">
              <img src={imagePreview} alt="Preview" className="w-full h-full object-cover" />
            </div>
            <span className="text-xs text-slate-300 font-medium">Image Attached</span>
          </div>
          <button onClick={handleClearImage} className="text-slate-500 hover:text-rose-400">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Message Input Controls Toolbar */}
      <form onSubmit={handleSendMessage} className="p-3 bg-slate-900/90 border-t border-slate-800 z-10 flex items-center gap-2">
        {/* Attachment & Ephemeral Controls */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageSelect}
          accept="image/*"
          className="hidden"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 hover:text-amber-400 transition-colors cursor-pointer"
          title="Attach Image"
        >
          <ImageIcon className="w-4 h-4" />
        </button>

        {/* Ephemeral Self-Destruct Timer Toggle */}
        <button
          type="button"
          onClick={() => {
            const options = [0, 1, 12, 24];
            const nextIdx = (options.indexOf(ephemeralHours) + 1) % options.length;
            setEphemeralHours(options[nextIdx]);
          }}
          className={`p-2.5 rounded-xl border transition-colors cursor-pointer text-xs font-mono flex items-center gap-1 ${
            ephemeralHours > 0
              ? 'bg-rose-950/60 border-rose-500/50 text-rose-300'
              : 'bg-slate-950 border-slate-800 text-slate-500 hover:text-slate-300'
          }`}
          title="Toggle Self-Destruct Timer (0h, 1h, 12h, 24h)"
        >
          <Clock className="w-4 h-4" />
          {ephemeralHours > 0 && <span className="text-[10px] font-bold">{ephemeralHours}h</span>}
        </button>

        {/* Main Text Input */}
        <input
          type="text"
          value={inputText}
          onChange={handleInputChange}
          placeholder={passphrase ? "Type cypher message..." : "Apply Key above to type..."}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
        />

        {/* Send Button */}
        <button
          type="submit"
          disabled={isSending || (!inputText.trim() && !selectedImage)}
          className="p-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 rounded-xl transition-colors cursor-pointer font-bold shrink-0 shadow-lg shadow-amber-500/20"
        >
          {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
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
  const [showKeypad, setShowKeypad] = useState(true);

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

  const handleApplyKey = () => {
    setPassphrase(tempPassphrase);
    setErrorMsg('');
    if (tempPassphrase) {
      setShowKeypad(false);
    }
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

      {/* Security Key Vault Banner with Top Passcode Field & Apply Key */}
      <div className="bg-[#0b101a] border-b border-slate-800/80 p-3 flex flex-col gap-2 shadow-lg">
        <div className="flex items-center gap-2">
          {/* Main Passcode Input Field */}
          <div className="relative flex-1">
            <input
              type={showTempPassphrase ? 'text' : 'password'}
              value={tempPassphrase}
              onChange={(e) => setTempPassphrase(e.target.value)}
              onFocus={() => setShowKeypad(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tempPassphrase) {
                  e.preventDefault();
                  handleApplyKey();
                }
              }}
              placeholder="Enter room E2EE passcode..."
              className="w-full bg-[#131b2e] border border-amber-500/50 rounded-xl px-3.5 py-2.5 text-slate-100 placeholder-slate-500 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500 pr-9 shadow-inner"
            />
            <button
              type="button"
              onClick={() => setShowTempPassphrase(!showTempPassphrase)}
              className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
              title={showTempPassphrase ? "Hide passcode" : "Show passcode"}
            >
              {showTempPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Apply Key Button */}
          <button
            type="button"
            onClick={handleApplyKey}
            disabled={!tempPassphrase && !passphrase}
            className="bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold px-4 py-2.5 rounded-xl text-xs transition-all shadow-md active:scale-95 cursor-pointer shrink-0"
          >
            Apply Key
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 px-0.5">
          <span>Passcodes are strictly computed in browser memory (AES-GCM 256) and never sent to servers.</span>
          <button
            type="button"
            onClick={() => setShowKeypad(!showKeypad)}
            className="text-amber-400 hover:text-amber-300 font-medium cursor-pointer flex items-center gap-1 ml-2 shrink-0 hover:underline"
          >
            <Key className="w-3.5 h-3.5" />
            <span>{showKeypad ? 'Hide Keypad' : 'Keypad'}</span>
          </button>
        </div>

        {/* Number Style Lock Pad Drawer / Overlay */}
        {showKeypad && (
          <div className="mt-1 p-4 bg-[#111827] border border-slate-800 rounded-2xl shadow-2xl max-w-xs mx-auto w-full animate-fadeIn flex flex-col items-center">
            {/* Display / Status */}
            <div className="w-full text-center mb-3">
              <span className="text-[11px] font-mono text-amber-400 font-semibold uppercase tracking-wider">
                {passphrase ? '● Key Active (Tap digits to change)' : 'Enter PIN or custom passcode'}
              </span>
            </div>

            {/* Circular Digits Grid (1-9, C, 0, ⌫) */}
            <div className="grid grid-cols-3 gap-3 w-full max-w-[240px] mb-4">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setTempPassphrase((prev) => prev + num)}
                  className="w-12 h-12 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-100 hover:text-amber-400 font-extrabold text-base flex items-center justify-center border border-slate-800 hover:border-amber-500/40 transition-all active:scale-95 shadow-md cursor-pointer mx-auto"
                >
                  {num}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setTempPassphrase('')}
                className="w-12 h-12 rounded-full bg-slate-900/50 hover:bg-slate-900 text-slate-400 hover:text-rose-400 text-xs font-bold flex items-center justify-center border border-slate-800/50 transition-colors cursor-pointer mx-auto"
                title="Clear input"
              >
                CLEAR
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev + '0')}
                className="w-12 h-12 rounded-full bg-slate-900 hover:bg-slate-800 text-slate-100 hover:text-amber-400 font-extrabold text-base flex items-center justify-center border border-slate-800 hover:border-amber-500/40 transition-all active:scale-95 shadow-md cursor-pointer mx-auto"
              >
                0
              </button>

              <button
                type="button"
                onClick={() => setTempPassphrase((prev) => prev.slice(0, -1))}
                className="w-12 h-12 rounded-full bg-slate-900/50 hover:bg-slate-900 text-slate-400 hover:text-amber-400 text-sm flex items-center justify-center border border-slate-800/50 transition-colors cursor-pointer mx-auto"
                title="Delete digit"
              >
                ⌫
              </button>
            </div>

            {/* Confirm / Apply Key button inside keypad */}
            <button
              type="button"
              onClick={handleApplyKey}
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-lg active:scale-95 cursor-pointer"
            >
              <Unlock className="w-3.5 h-3.5" />
              <span>Apply Key & Decrypt Chat</span>
            </button>
          </div>
        )}
      </div>

      {/* Chat Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-slate-900/40 relative flex flex-col justify-between">
        {messages.length === 0 ? (
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
      }import { encryptMessage, decryptMessage, EncryptedPayload } from '../lib/crypto';
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
  const [showPassphraseInput, setShowPassphraseInput] = useState(false);
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

  // Key lock confirmation handler
  const handleSetPassphrase = (e: React.FormEvent) => {
    e.preventDefault();
    setPassphrase(tempPassphrase.trim());
    setErrorMsg('');
  };

  // Sending a message (encrypted or direct plain text)
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() && !selectedImage) return;

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
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 rounded-2xl border border-slate-900 overflow-hidden shadow-2xl relative">
      {/* Top Header Bar */}
      <div className="px-4 py-3 bg-slate-900/80 backdrop-blur-md border-b border-slate-800/80 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}

          {chat.type === 'direct' && recipient ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative shrink-0">
                <img
                  src={recipient.photoURL || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(recipient.displayName)}`}
                  alt={recipient.displayName}
                  className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700/60 object-cover"
                  referrerPolicy="no-referrer"
                />
                <span
                  className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${
                    isSomeoneTyping ? 'bg-amber-500 animate-bounce' : recipient.status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'
                  }`}
                />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold text-slate-100 truncate">
                  {recipient.displayName}
                </span>
                <span className="text-[11px] text-slate-400 truncate">
                  {isSomeoneTyping ? (
                    <span className="text-amber-400 font-medium animate-pulse">typing...</span>
                  ) : (
                    'Direct Encrypted Chat'
                  )}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shrink-0">
                <Shield className="w-4 h-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold text-slate-100 truncate">{roomName}</span>
                <span className="text-[11px] text-slate-400 truncate">
                  {isSomeoneTyping ? (
                    <span className="text-amber-400 font-medium animate-pulse">Someone is typing...</span>
                  ) : (
                    `${chat.participantIds.length} members`
                  )}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowPassphraseInput(!showPassphraseInput)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition-all ${
              passphrase
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                : 'bg-slate-800/80 text-slate-400 border-slate-700/60 hover:text-slate-200'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{passphrase ? 'Key Active' : 'Set Key'}</span>
          </button>

          <button
            onClick={triggerEmergencyLock}
            className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 transition-all"
            title="Emergency Lock Screen"
          >
            <Lock className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Encryption Key Config Panel */}
      {showPassphraseInput && (
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 shrink-0 animate-fadeIn">
          <form onSubmit={handleSetPassphrase} className="flex items-center gap-2 max-w-lg mx-auto">
            <div className="relative flex-1">
              <input
                type="password"
                value={tempPassphrase}
                onChange={(e) => setTempPassphrase(e.target.value)}
                placeholder="Enter room E2EE passcode..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono"
              />
            </div>
            <button
              type="submit"
              className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-3 py-2 rounded-xl text-xs transition-colors shrink-0"
            >
              Apply Key
            </button>
          </form>
          <p className="text-[10px] text-slate-500 text-center mt-1.5">
            Passcodes are strictly computed in browser memory (AES-GCM 256) and never sent to servers.
          </p>
        </div>
      )}

      {/* Chat Messages List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 relative">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500 space-y-2">
            <ShieldCheck className="w-10 h-10 text-slate-600" />
            <p className="text-sm font-medium text-slate-400">End-to-End Encrypted Workspace</p>
            <p className="text-xs max-w-xs">
              Messages and shared attachments in this room are encrypted client-side using Web Crypto.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUser.uid;
            const decryptedText = decryptedMessages[msg.id];
            const isLockError = decryptedText?.includes('🔒 [Decryption Failed');
            const readByList = msg.readBy || [];
            const otherReaders = readByList.filter((id) => id !== msg.senderId);
            const isReadByOthers = otherReaders.length > 0;
            const allRead = msg.isRead || (chat.participantIds.length > 0 && chat.participantIds.every((id) => readByList.includes(id)));

            const parsedPayload = parseDecryptedMessage(decryptedText);
            const isImagePreview = msg.previewText?.includes('📷') || parsedPayload.isImage;

            return (
              <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} group/msg`}>
                <div className={`flex items-end gap-2 max-w-[82%] sm:max-w-[70%]`}>
                  {!isMe && (
                    <img
                      src={msg.senderPhoto || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(msg.senderName)}`}
                      alt={msg.senderName}
                      className="w-7 h-7 rounded-full border border-slate-800 object-cover mb-1 shrink-0"
                      referrerPolicy="no-referrer"
                    />
                  )}

                  <div className="flex flex-col">
                    {/* Message Bubble */}
                    <div
                      className={`rounded-2xl px-4 py-2.5 text-xs sm:text-sm shadow-md transition-all ${
                        isMe
                          ? 'bg-amber-500 text-slate-950 font-medium rounded-br-xs'
                          : 'bg-slate-900 text-slate-100 rounded-bl-xs border border-slate-800/80'
                      }`}
                    >
                      {/* Replying banner */}
                      {msg.replyToId && (
                        <div className={`border-l-2 px-2 py-1 rounded text-[11px] mb-2 truncate max-w-full text-left ${
                          isMe ? 'border-slate-900 bg-amber-600/30 text-slate-950' : 'border-amber-500 bg-slate-950/60 text-slate-300'
                        }`}>
                          <span className="font-bold block text-[10px] uppercase">
                            Replying to {msg.replyToSenderName}
                          </span>
                          <span className="truncate block opacity-90">{msg.replyToText}</span>
                        </div>
                      )}

                      {/* Decryption status or payload rendering */}
                      {isLockError ? (
                        <div className="flex items-center gap-1.5 text-xs italic opacity-90">
                          <ShieldAlert className="w-4 h-4 shrink-0" />
                          <span>Decryption failed (Wrong Key)</span>
                        </div>
                      ) : parsedPayload.isImage ? (
                        <div className="space-y-1.5">
                          <div className="relative group/img overflow-hidden rounded-xl border border-slate-700/60 bg-black/40">
                            <img
                              src={parsedPayload.imageUrl!}
                              alt="Shared image attachment"
                              className="max-h-64 sm:max-h-80 w-auto rounded-xl object-contain cursor-pointer hover:opacity-95 transition-opacity"
                              onClick={() => setExpandedImageUrl(parsedPayload.imageUrl)}
                            />
                            <button
                              onClick={() => setExpandedImageUrl(parsedPayload.imageUrl)}
                              className="absolute bottom-2 right-2 p-1.5 bg-black/70 text-slate-200 rounded-lg backdrop-blur-md opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center gap-1 text-[10px] font-medium border border-slate-700 cursor-pointer"
                            >
                              <Maximize2 className="w-3 h-3" />
                              <span>View</span>
                            </button>
                          </div>
                          {parsedPayload.text && (
                            <p className="whitespace-pre-wrap break-words leading-relaxed">{parsedPayload.text}</p>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {!passphrase && (
                            <span className="shrink-0 text-amber-300">
                              {isImagePreview ? '📷' : '🔒'}
                            </span>
                          )}
                          <p className="whitespace-pre-wrap break-words leading-relaxed">
                            {decryptedText || msg.previewText}
                          </p>
                        </div>
                      )}

                      {/* Message Time inside bubble */}
                      <div className={`text-[10px] text-right mt-1 opacity-75 flex items-center justify-end gap-1 ${
                        isMe ? 'text-slate-950 font-semibold' : 'text-slate-400'
                      }`}>
                        <span>{formatMessageTime(msg.timestamp)}</span>
                        {isMe && (
                          <span>
                            {allRead || isReadByOthers ? (
                              <CheckCheck className="w-3.5 h-3.5" />
                            ) : (
                              <Check className="w-3.5 h-3.5" />
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions (Reply & Delete) on Hover */}
                  <div className={`flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity ${isMe ? 'order-first' : 'order-last'}`}>
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
                      className="p-1 text-slate-400 hover:text-amber-400 transition-colors"
                      title="Reply"
                    >
                      <CornerUpLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteMessage(msg.id)}
                      className="p-1 text-slate-400 hover:text-rose-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Message Input & Attachment Footer */}
      <div className="p-3 bg-slate-900/90 border-t border-slate-800/80 shrink-0 space-y-2">
        {errorMsg && (
          <div className="text-xs font-medium text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded-lg flex items-center justify-between">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} className="p-0.5 hover:text-rose-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Staged Image Attachment Preview */}
        {selectedImage && (
          <div className="flex items-center justify-between bg-slate-950 border border-slate-800 p-2 rounded-xl text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src={selectedImage.dataUrl}
                alt="Staged attachment"
                className="w-10 h-10 rounded-lg object-cover border border-slate-800 shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-slate-200 truncate">{selectedImage.name}</span>
                <span className="text-[10px] text-amber-400 font-mono">Compressed & Encrypted Image</span>
              </div>
            </div>
            <button
              onClick={() => setSelectedImage(null)}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Replying Banner */}
        {replyingTo && (
          <div className="flex items-center justify-between bg-slate-950 border-l-2 border-amber-500 px-3 py-1.5 rounded-r-xl text-xs">
            <div className="flex flex-col min-w-0">
              <span className="font-semibold text-amber-400 text-[10px] uppercase">Replying to {replyingTo.senderName}</span>
              <span className="text-slate-300 truncate text-[11px]">{replyingTo.text}</span>
            </div>
            <button
              onClick={() => setReplyingTo(null)}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <form onSubmit={handleSendMessage} className="flex items-center gap-2">
          {/* File Picker Trigger */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessingImage}
            className="p-2.5 rounded-xl bg-slate-800/80 text-slate-300 hover:text-slate-100 hover:bg-slate-800 border border-slate-700/60 transition-colors shrink-0 cursor-pointer disabled:opacity-50"
            title="Attach Encrypted Photo"
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
            placeholder={
              selectedImage
                ? "Add an optional image caption..."
                : passphrase
                ? "Type an encrypted message..."
                : "Type message (Set key above to encrypt)..."
            }
            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />

          <button
            type="submit"
            disabled={(!inputText.trim() && !selectedImage) || isProcessingImage}
            className="bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:hover:bg-amber-500 text-slate-950 font-bold p-2.5 rounded-xl transition-all shrink-0 cursor-pointer"
            title="Send Message"
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
                className="p-2 bg-slate-800 text-slate-200 rounded-lg border border-slate-700 hover:bg-slate-700 transition-colors flex items-center gap-1.5 text-xs font-medium"
              >
                <Download className="w-4 h-4" />
                <span>Download</span>
              </a>
              <button
                onClick={() => setExpandedImageUrl(null)}
                className="p-2 bg-slate-800 text-slate-200 rounded-lg border border-slate-700 hover:bg-slate-700 transition-colors"
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
