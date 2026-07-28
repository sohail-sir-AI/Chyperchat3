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
